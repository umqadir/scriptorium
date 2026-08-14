import type {
  Block,
  ParseResult,
  ParseWarning,
  Section,
  SectionKind,
} from "../types";
import { buildVocabulary, cleanBlocks, detectPageStructure } from "./clean";
import { extractBlocksWithReport } from "./extract";
import { normalizeBlocksWithReport } from "./normalize";
import { repairBlocks } from "./repair";
import {
  bytesToDataUrl,
  decodeUtf8,
  decodeXhtml,
  unzipEpub,
  type ZipFiles,
} from "./unzip";

export interface ParseEpubOptions {
  foldAccents: boolean;
}

type ManifestItem = {
  id: string;
  href: string;
  path: string;
  mediaType: string;
  properties: Set<string>;
};

type WorkingSection = {
  id: string;
  href: string;
  path?: string;
  title: string;
  order: number;
  kind: SectionKind;
  blocks: Block[];
};

type TaggedBlock = Block & { __sectionIndex: number };

const ACCEPTED_COVER_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_COVER_SOURCE_BYTES = 16 * 1024 * 1024;
const SMALL_COVER_FALLBACK_BYTES = 256 * 1024;
const MAX_COVER_DIMENSION = 256;

function localName(el: Element): string {
  const reported = el.localName || el.tagName;
  return (reported.split(":").pop() || "").toLowerCase();
}

function descendants(el: ParentNode, name: string): Element[] {
  const wanted = name.toLowerCase();
  return Array.from(el.querySelectorAll("*")).filter((candidate) => localName(candidate) === wanted);
}

function firstDescendant(el: ParentNode, name: string): Element | undefined {
  return descendants(el, name)[0];
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseXml(text: string, description: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (!doc.documentElement || localName(doc.documentElement) === "parsererror") {
    throw new Error(`Invalid ${description}.`);
  }
  if (descendants(doc, "parsererror").length > 0) {
    throw new Error(`Invalid ${description}.`);
  }
  return doc;
}

function stripReferenceSuffix(value: string): string {
  const hash = value.indexOf("#");
  const query = value.indexOf("?");
  let end = value.length;
  if (hash !== -1) end = Math.min(end, hash);
  if (query !== -1) end = Math.min(end, query);
  return value.slice(0, end);
}

/** Decode URL escaping without allowing escaped separators to change path shape. */
function cautiouslyDecodeSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
      return segment;
    }
    return decoded;
  } catch {
    return segment;
  }
}

function normalizeArchivePath(value: string): string {
  const clean = stripReferenceSuffix(value).replace(/\\/g, "/");
  const parts: string[] = [];
  for (const rawPart of clean.split("/")) {
    const part = cautiouslyDecodeSegment(rawPart);
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function resolveArchivePath(baseFile: string, reference: string): string {
  const ref = stripReferenceSuffix(reference).replace(/\\/g, "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return "";
  if (ref.startsWith("/")) return normalizeArchivePath(ref);
  const base = dirname(baseFile);
  return normalizeArchivePath(base ? `${base}/${ref}` : ref);
}

function buildFileLookup(files: ZipFiles): Map<string, Uint8Array> {
  const lookup = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    const normalized = normalizeArchivePath(name);
    if (!lookup.has(normalized)) lookup.set(normalized, bytes);
  }
  return lookup;
}

function getFile(
  lookup: Map<string, Uint8Array>,
  path: string,
): Uint8Array | undefined {
  const normalized = normalizeArchivePath(path);
  const direct = lookup.get(normalized);
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  for (const [candidate, bytes] of lookup) {
    if (candidate.toLowerCase() === lower) return bytes;
  }
  return undefined;
}

function parseManifest(opf: Document, opfPath: string): Map<string, ManifestItem> {
  const manifest = firstDescendant(opf, "manifest");
  const result = new Map<string, ManifestItem>();
  if (!manifest) return result;

  for (const el of descendants(manifest, "item")) {
    const id = normalizedText(el.getAttribute("id"));
    const href = normalizedText(el.getAttribute("href"));
    if (!id || !href) continue;
    const mediaType = normalizedText(el.getAttribute("media-type")).toLowerCase();
    result.set(id, {
      id,
      href: stripReferenceSuffix(href),
      path: resolveArchivePath(opfPath, href),
      mediaType,
      properties: new Set(normalizedText(el.getAttribute("properties")).split(/\s+/).filter(Boolean)),
    });
  }
  return result;
}

function addTocEntry(
  toc: Map<string, string>,
  basePath: string,
  href: string,
  label: string,
): void {
  const path = resolveArchivePath(basePath, href);
  const title = normalizedText(label);
  if (path && title && !toc.has(path)) toc.set(path, title);
}

function parseEpub3Navigation(
  manifest: Map<string, ManifestItem>,
  lookup: Map<string, Uint8Array>,
): Map<string, string> {
  const toc = new Map<string, string>();
  const navItem = Array.from(manifest.values()).find((item) => item.properties.has("nav"));
  if (!navItem) return toc;
  const bytes = getFile(lookup, navItem.path);
  if (!bytes) return toc;

  let doc: Document;
  try {
    doc = parseXml(decodeXhtml(bytes).text, "EPUB navigation document");
  } catch {
    return toc;
  }
  const navs = descendants(doc, "nav");
  const tocNav = navs.find((nav) => {
    const type = `${nav.getAttribute("epub:type") ?? ""} ${nav.getAttribute("type") ?? ""}`;
    const role = nav.getAttribute("role") ?? "";
    return /(^|\s)toc(\s|$)/i.test(type) || role.toLowerCase() === "doc-toc";
  }) ?? navs[0];
  if (!tocNav) return toc;

  for (const anchor of descendants(tocNav, "a")) {
    const href = anchor.getAttribute("href");
    if (href) addTocEntry(toc, navItem.path, href, anchor.textContent ?? "");
  }
  return toc;
}

function parseNcxNavigation(
  opf: Document,
  manifest: Map<string, ManifestItem>,
  lookup: Map<string, Uint8Array>,
): Map<string, string> {
  const toc = new Map<string, string>();
  const spine = firstDescendant(opf, "spine");
  const declaredId = normalizedText(spine?.getAttribute("toc"));
  const ncxItem = (declaredId ? manifest.get(declaredId) : undefined)
    ?? Array.from(manifest.values()).find((item) => item.mediaType === "application/x-dtbncx+xml");
  if (!ncxItem) return toc;
  const bytes = getFile(lookup, ncxItem.path);
  if (!bytes) return toc;

  let doc: Document;
  try {
    doc = parseXml(decodeUtf8(bytes), "NCX navigation document");
  } catch {
    return toc;
  }
  for (const point of descendants(doc, "navpoint")) {
    const content = firstDescendant(point, "content");
    const label = firstDescendant(firstDescendant(point, "navlabel") ?? point, "text");
    const href = content?.getAttribute("src");
    if (href) addTocEntry(toc, ncxItem.path, href, label?.textContent ?? "");
  }
  return toc;
}

function filenameTitle(href: string, id: string): string {
  const name = normalizeArchivePath(href).split("/").pop()?.replace(/\.[^.]+$/, "") || id;
  const readable = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return normalizedText(readable) || "Untitled section";
}

function documentTitle(doc: Document): string | undefined {
  const title = normalizedText(firstDescendant(doc, "title")?.textContent);
  if (title) return title;
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const heading = normalizedText(firstDescendant(doc, tag)?.textContent);
    if (heading) return heading;
  }
  return undefined;
}

const FRONTMATTER_TERMS = [
  "cover", "copyright", "contents", "toc", "dedication", "epigraph",
  "preface", "foreword", "introduction", "translator s note", "translator note", "maps", "map",
];
const BACKMATTER_TERMS = [
  "notes", "endnotes", "glossary", "index", "bibliography", "appendix", "appendices",
  "colophon", "about the author", "about author", "ads", "advertisements",
];

function hasStructuralTerm(haystack: string, term: string): boolean {
  return ` ${haystack} `.includes(` ${term} `);
}

function classifySection(id: string, href: string, title: string): SectionKind {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedIdentity = `${id} ${href}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const candidate = `${id} ${href} ${title}`
    .toLowerCase()
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (
    normalizedTitle === "title" || normalizedTitle === "title page"
    || hasStructuralTerm(normalizedIdentity, "title")
    || hasStructuralTerm(normalizedIdentity, "title page")
    || hasStructuralTerm(normalizedIdentity, "titlepage")
  ) return "frontmatter";
  if (FRONTMATTER_TERMS.some((term) => hasStructuralTerm(candidate, term))) return "frontmatter";
  if (BACKMATTER_TERMS.some((term) => hasStructuralTerm(candidate, term))) return "backmatter";
  return "body";
}

function metadataValue(opf: Document, name: string): string | undefined {
  const metadata = firstDescendant(opf, "metadata");
  if (!metadata) return undefined;
  const value = normalizedText(firstDescendant(metadata, name)?.textContent);
  return value || undefined;
}

function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  if (mediaType === "image/png") {
    if (
      bytes.length >= 24
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    return undefined;
  }
  if (mediaType !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && length >= 7) {
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += length;
  }
  return undefined;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | undefined> {
  return await new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob ?? undefined), type, type === "image/jpeg" ? 0.86 : undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function resizeCover(
  bytes: Uint8Array,
  mediaType: string,
  width: number,
  height: number,
): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const source = new Blob([bytes.slice().buffer], { type: mediaType });
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, MAX_COVER_DIMENSION / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    let blob: Blob | undefined;

    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        blob = await canvas.convertToBlob({
          type: mediaType,
          ...(mediaType === "image/jpeg" ? { quality: 0.86 } : {}),
        });
      }
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        blob = await canvasToBlob(canvas, mediaType);
      }
    }
    bitmap.close();
    if (!blob || !ACCEPTED_COVER_TYPES.has(blob.type)) return undefined;
    return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
  } catch {
    return undefined;
  }
}

function coverItemFromGuide(
  opf: Document,
  opfPath: string,
  manifest: Map<string, ManifestItem>,
  lookup: Map<string, Uint8Array>,
): ManifestItem | undefined {
  const guide = firstDescendant(opf, "guide");
  const reference = guide && descendants(guide, "reference").find((el) => {
    const type = normalizedText(el.getAttribute("type")).toLowerCase();
    return type === "cover" || type === "cover-image";
  });
  const href = reference?.getAttribute("href");
  if (!href) return undefined;
  const path = resolveArchivePath(opfPath, href);
  const direct = Array.from(manifest.values()).find((item) => item.path === path);
  if (direct && ACCEPTED_COVER_TYPES.has(direct.mediaType)) return direct;

  const wrapperBytes = getFile(lookup, path);
  if (!wrapperBytes) return undefined;
  try {
    const wrapper = parseXml(decodeXhtml(wrapperBytes).text, "cover document");
    const image = firstDescendant(wrapper, "img") ?? firstDescendant(wrapper, "image");
    const src = image?.getAttribute("src") ?? image?.getAttribute("href") ?? image?.getAttribute("xlink:href");
    if (!src) return undefined;
    const imagePath = resolveArchivePath(path, src);
    return Array.from(manifest.values()).find(
      (item) => item.path === imagePath && ACCEPTED_COVER_TYPES.has(item.mediaType),
    );
  } catch {
    return undefined;
  }
}

async function extractCover(
  opf: Document,
  opfPath: string,
  manifest: Map<string, ManifestItem>,
  lookup: Map<string, Uint8Array>,
): Promise<string | undefined> {
  const candidates: ManifestItem[] = [];
  const addCandidate = (candidate: ManifestItem | undefined): void => {
    if (
      candidate && ACCEPTED_COVER_TYPES.has(candidate.mediaType)
      && !candidates.some((existing) => existing.path === candidate.path)
    ) candidates.push(candidate);
  };
  addCandidate(Array.from(manifest.values()).find(
    (candidate) => candidate.properties.has("cover-image")
      && ACCEPTED_COVER_TYPES.has(candidate.mediaType),
  ));

  const metadata = firstDescendant(opf, "metadata");
  const coverMeta = metadata && descendants(metadata, "meta").find(
    (el) => normalizedText(el.getAttribute("name")).toLowerCase() === "cover",
  );
  const coverId = normalizedText(coverMeta?.getAttribute("content"));
  if (coverId) addCandidate(manifest.get(coverId));
  addCandidate(coverItemFromGuide(opf, opfPath, manifest, lookup));
  addCandidate(Array.from(manifest.values()).find((candidate) =>
    ACCEPTED_COVER_TYPES.has(candidate.mediaType)
    && /(^|[^a-z])(?:front[-_ ]?)?cover([^a-z]|$)/i.test(`${candidate.id} ${candidate.href}`),
  ));

  for (const item of candidates) {
    const bytes = getFile(lookup, item.path);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_COVER_SOURCE_BYTES) continue;
    const dimensions = imageDimensions(bytes, item.mediaType);
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      if (Math.max(dimensions.width, dimensions.height) <= MAX_COVER_DIMENSION) {
        return bytesToDataUrl(bytes, item.mediaType);
      }
      const resized = await resizeCover(bytes, item.mediaType, dimensions.width, dimensions.height);
      if (resized) return resized;
      continue;
    }
    if (bytes.length <= SMALL_COVER_FALLBACK_BYTES) return bytesToDataUrl(bytes, item.mediaType);
  }
  return undefined;
}

async function bookId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Parse an EPUB into the one canonical, normalized block stream used by the reader. */
export async function parseEpub(
  file: Blob,
  options: ParseEpubOptions = { foldAccents: true },
): Promise<ParseResult> {
  const rawBytes = new Uint8Array(await file.arrayBuffer());
  let files: ZipFiles;
  try {
    files = unzipEpub(rawBytes);
  } catch {
    throw new Error("This file is not a valid EPUB archive.");
  }
  const lookup = buildFileLookup(files);
  const containerBytes = getFile(lookup, "META-INF/container.xml");
  if (!containerBytes) throw new Error("This EPUB is missing META-INF/container.xml.");

  const container = parseXml(decodeUtf8(containerBytes), "EPUB container.xml");
  const rootfiles = descendants(container, "rootfile");
  const rootfile = rootfiles.find(
    (el) => normalizedText(el.getAttribute("media-type")) === "application/oebps-package+xml",
  ) ?? rootfiles[0];
  const opfPath = normalizeArchivePath(rootfile?.getAttribute("full-path") ?? "");
  if (!opfPath) throw new Error("This EPUB's container does not name a package document.");
  const opfBytes = getFile(lookup, opfPath);
  if (!opfBytes) throw new Error("This EPUB's package document is missing.");
  const opf = parseXml(decodeUtf8(opfBytes), "EPUB package document");

  const title = metadataValue(opf, "title")
    ?? filenameTitle((file as Blob & { name?: string }).name ?? "", "Untitled book");
  const author = metadataValue(opf, "creator") ?? "Unknown author";
  const language = metadataValue(opf, "language") ?? "und";
  const manifest = parseManifest(opf, opfPath);
  const epub3Toc = parseEpub3Navigation(manifest, lookup);
  const toc = parseNcxNavigation(opf, manifest, lookup);
  // A valid EPUB can carry both formats during an EPUB2 -> EPUB3 transition.
  // Use NCX to fill gaps, while treating the EPUB3 navigation as authoritative.
  for (const [path, tocTitle] of epub3Toc) toc.set(path, tocTitle);
  const warnings: ParseWarning[] = [];
  const working: WorkingSection[] = [];
  const spine = firstDescendant(opf, "spine");
  const itemrefs = spine ? descendants(spine, "itemref") : [];
  if (itemrefs.length === 0) {
    warnings.push({
      code: "no-spine",
      message: "This EPUB has no reading order (spine).",
    });
  }

  for (let order = 0; order < itemrefs.length; order++) {
    const itemref = itemrefs[order];
    if (!itemref) continue;
    const id = normalizedText(itemref.getAttribute("idref")) || `section-${order + 1}`;
    const item = manifest.get(id);
    const href = item?.href ?? "";
    const path = item?.path;
    const tocTitle = path ? toc.get(path) : undefined;
    let doc: Document | undefined;
    let blocks: Block[] = [];

    if (path) {
      const sectionBytes = getFile(lookup, path);
      if (sectionBytes) {
        const decoded = decodeXhtml(sectionBytes);
        if (decoded.guessed) {
          warnings.push({
            code: "decode-fallback",
            message: "Assumed UTF-8 because this section did not declare a supported encoding.",
            sectionId: id,
          });
        }
        try {
          doc = parseXml(decoded.text, `section ${id}`);
          const extracted = extractBlocksWithReport(doc, id);
          blocks = extracted.blocks;
          warnings.push(...extracted.warnings);
        } catch {
          // Keep the spine item visible as an empty section; import remains useful.
        }
      }
    }

    const sectionTitle = tocTitle ?? (doc ? documentTitle(doc) : undefined) ?? filenameTitle(href, id);
    working.push({
      id,
      href,
      ...(path ? { path } : {}),
      title: sectionTitle,
      order,
      kind: classifySection(id, href, sectionTitle),
      blocks,
    });
  }

  // Preserve provenance through the genuinely book-wide repair pass. Every
  // repair operation either returns the input object or spreads it, so the
  // private tag survives paragraph recovery without entering final Blocks.
  const taggedRaw: TaggedBlock[] = working.flatMap((section, sectionIndex) =>
    section.blocks.map((block) => ({ ...block, __sectionIndex: sectionIndex })),
  );
  const repaired = repairBlocks(taggedRaw);
  warnings.push(...repaired.warnings.filter((warning) => warning.code !== "paragraphs-recovered"));
  const repairedBySection: Block[][] = working.map(() => []);
  for (const repairedBlock of repaired.blocks as TaggedBlock[]) {
    const sectionBlocks = repairedBySection[repairedBlock.__sectionIndex];
    if (sectionBlocks) sectionBlocks.push({ kind: repairedBlock.kind, text: repairedBlock.text });
  }
  for (let i = 0; i < working.length; i++) {
    const recovered = (repairedBySection[i]?.length ?? 0) - working[i]!.blocks.length;
    if (recovered > 0) {
      warnings.push({
        code: "paragraphs-recovered",
        message: `Recovered ${recovered} paragraph breaks that this file had flattened into run-on text.`,
        sectionId: working[i]!.id,
      });
    }
  }

  const normalizedBySection: Block[][] = [];
  for (let i = 0; i < working.length; i++) {
    const section = working[i];
    if (!section) continue;
    const normalized = normalizeBlocksWithReport(repairedBySection[i] ?? [], options);
    normalizedBySection[i] = normalized.blocks;
    if (normalized.droppedCount > 0) {
      warnings.push({
        code: "dropped-chars",
        message: `Removed ${normalized.droppedCount} characters that cannot be typed on a standard keyboard.`,
        sectionId: section.id,
      });
    }
  }

  const allNormalized = normalizedBySection.flat();
  const vocabulary = buildVocabulary(allNormalized);
  const pageStructured = detectPageStructure(allNormalized);
  const sections: Section[] = working.map((section, index) => {
    const cleaned = cleanBlocks(normalizedBySection[index] ?? [], {
      title,
      author,
      sectionTitle: section.title,
      vocabulary,
      pageStructured,
    });
    warnings.push(...cleaned.warnings.map((warning) => ({ ...warning, sectionId: section.id })));
    if (cleaned.blocks.length === 0) {
      warnings.push({
        code: "empty-section",
        message: "This section contains no readable text.",
        sectionId: section.id,
      });
    }
    return {
      id: section.id,
      href: section.href,
      title: section.title,
      order: section.order,
      kind: section.kind,
      included: section.kind === "body",
      blocks: cleaned.blocks,
      charCount: cleaned.blocks.reduce((sum, block) => sum + block.text.length, 0),
    };
  });

  const coverDataUrl = await extractCover(opf, opfPath, manifest, lookup);
  if (!coverDataUrl) {
    warnings.push({ code: "no-cover", message: "No usable JPEG or PNG cover image was found." });
  }

  return {
    book: {
      meta: {
        id: await bookId(rawBytes),
        title,
        author,
        language,
        ...(coverDataUrl ? { coverDataUrl } : {}),
        addedAt: Date.now(),
      },
      sections,
    },
    warnings,
  };
}
