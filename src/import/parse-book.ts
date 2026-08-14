import type { Block, ParseResult, ParseWarning, Section, SectionKind } from "../types";
import { buildVocabulary, cleanBlocks, detectPageStructure } from "../epub/clean";
import { extractBlocksWithReport } from "../epub/extract";
import { parseEpub } from "../epub";
import { normalizeBlocksWithReport } from "../epub/normalize";
import { repairBlocks } from "../epub/repair";

export interface ParseBookOptions {
  foldAccents: boolean;
}

export const SUPPORTED_BOOK_ACCEPT = [
  ".epub", ".pdf", ".txt", ".md", ".markdown", ".html", ".htm",
  "application/epub+zip", "application/pdf", "text/plain", "text/markdown", "text/html",
].join(",");

type BookFormat = "epub" | "pdf" | "txt" | "markdown" | "html";

export type RawBookSection = {
  id: string;
  href: string;
  title: string;
  kind?: SectionKind;
  blocks: Block[];
};

export type RawBook = {
  title: string;
  author?: string;
  language?: string;
  sections: RawBookSection[];
};

type TaggedBlock = Block & { __sectionIndex: number };

const EXTENSION_FORMATS: Record<string, BookFormat> = {
  epub: "epub",
  pdf: "pdf",
  txt: "txt",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
};

const MIME_FORMATS: Record<string, BookFormat> = {
  "application/epub+zip": "epub",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/html": "html",
  "application/xhtml+xml": "html",
};

function filenameExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
  return match?.[1] ?? "";
}

function detectFormat(file: Pick<File, "name" | "type">): BookFormat | undefined {
  return EXTENSION_FORMATS[filenameExtension(file.name)]
    ?? MIME_FORMATS[file.type.toLowerCase().split(";", 1)[0]?.trim() ?? ""];
}

export function isSupportedBookFile(file: Pick<File, "name" | "type">): boolean {
  return detectFormat(file) !== undefined;
}

function filenameTitle(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  let decoded = withoutExtension;
  try {
    decoded = decodeURIComponent(withoutExtension);
  } catch {
    // A literal percent sign in a filename is harmless.
  }
  return decoded.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled book";
}

async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function decodePlainText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function normalizedLabel(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function htmlMeta(doc: Document, ...names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const meta of Array.from(doc.querySelectorAll("meta"))) {
    const key = (meta.getAttribute("name") ?? meta.getAttribute("property") ?? "").toLowerCase();
    const content = normalizedLabel(meta.getAttribute("content"));
    if (wanted.has(key) && content) return content;
  }
  return undefined;
}

function sectionsAtHeadings(blocks: Block[], prefix: string, fallbackTitle: string): RawBookSection[] {
  const groups: { title: string; blocks: Block[] }[] = [];
  let current: { title: string; blocks: Block[] } | undefined;
  for (const block of blocks) {
    if (block.kind === "heading") {
      current = { title: normalizedLabel(block.text) || fallbackTitle, blocks: [block] };
      groups.push(current);
    } else {
      current ??= { title: fallbackTitle, blocks: [] };
      if (!groups.includes(current)) groups.push(current);
      current.blocks.push(block);
    }
  }
  if (groups.length === 0) groups.push({ title: fallbackTitle, blocks: [] });
  return groups.map((group, index) => ({
    id: `${prefix}-${index + 1}`,
    href: `#${prefix}-${index + 1}`,
    title: group.title,
    blocks: group.blocks,
  }));
}

function parseHtmlDocument(source: string, fallbackTitle: string, prefix: string): RawBook {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const title = normalizedLabel(doc.querySelector("title")?.textContent) || fallbackTitle;
  const report = extractBlocksWithReport(doc);
  return {
    title,
    author: htmlMeta(doc, "author", "dc.creator", "dcterms.creator"),
    language: htmlMeta(doc, "language", "dc.language", "dcterms.language")
      ?? (normalizedLabel(doc.documentElement.getAttribute("lang")) || undefined),
    sections: sectionsAtHeadings(report.blocks, prefix, title),
  };
}

const STRONG_TEXT_HEADING = /^(?:(?:chapter|book|part|section)\s+(?:\d+|[ivxlcdm]+|[a-z]+)(?:\s*[:.\-]\s*.*|\s+.*)?|(?:prologue|epilogue|introduction|preface))$/i;

function textGroupBlocks(lines: string[]): Block[] {
  if (lines.length <= 1) {
    return lines.map((text) => ({ kind: "paragraph", text }));
  }
  const widths = lines.map((line) => line.trim().length);
  const maxWidth = Math.max(...widths);
  const minWidth = Math.min(...widths);
  const interior = lines.slice(0, -1);
  const wideRatio = interior.filter((line) => line.trim().length >= maxWidth * 0.68).length
    / Math.max(1, interior.length);
  const continuationRatio = interior.filter((line) => !/[.!?]["')\]]?$/.test(line.trim())).length
    / Math.max(1, interior.length);
  const capitalizedRatio = lines.filter((line) => /^["'(\[]*[A-Z]/.test(line.trim())).length / lines.length;
  const ragged = maxWidth - minWidth > maxWidth * 0.38;
  const likelyVerse = (lines.length >= 2 && maxWidth < 62)
    || (lines.length >= 3 && capitalizedRatio >= 0.75 && (ragged || wideRatio < 0.75));
  const likelyWrappedProse = wideRatio >= 0.67 && continuationRatio >= 0.5 && !likelyVerse;
  if (likelyWrappedProse) {
    return [{ kind: "paragraph", text: lines.map((line) => line.trim()).join(" ") }];
  }
  return lines.map((text) => ({ kind: "verse", text }));
}

function parseTextBook(source: string, title: string): RawBook {
  const lines = source.split(/\r\n?|\n/);
  const headingCount = lines.filter((line) => STRONG_TEXT_HEADING.test(line.trim())).length;
  const groups: { title: string; blocks: Block[] }[] = [];
  let current = { title, blocks: [] as Block[] };
  groups.push(current);
  let lineGroup: string[] = [];
  const flushLineGroup = (): void => {
    if (lineGroup.length === 0) return;
    current.blocks.push(...textGroupBlocks(lineGroup));
    lineGroup = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushLineGroup();
      continue;
    }
    if (STRONG_TEXT_HEADING.test(trimmed)) {
      flushLineGroup();
      current = { title: trimmed, blocks: [{ kind: "heading", text: line }] };
      groups.push(current);
    } else {
      lineGroup.push(line);
    }
  }
  flushLineGroup();
  // Without chapter markers the initial group is the whole book; with them,
  // a nonempty initial group is intentional front-of-book prose.
  if (headingCount === 0 && groups[0]) groups[0].title = title;
  return {
    title,
    sections: groups.filter((group) => group.blocks.length > 0).map((group, index) => ({
      id: `text-${index + 1}`,
      href: `#text-${index + 1}`,
      title: group.title,
      blocks: group.blocks,
    })),
  };
}

/** Finalize non-EPUB formats through the same canonical quality pipeline. */
export async function finalizeRawBook(
  raw: RawBook,
  bytes: Uint8Array,
  options: ParseBookOptions,
): Promise<ParseResult> {
  const warnings: ParseWarning[] = [];
  const taggedRaw: TaggedBlock[] = raw.sections.flatMap((section, sectionIndex) =>
    section.blocks.map((block) => ({ ...block, __sectionIndex: sectionIndex })),
  );
  const repaired = repairBlocks(taggedRaw);
  warnings.push(...repaired.warnings.filter((warning) => warning.code !== "paragraphs-recovered"));
  const repairedBySection: Block[][] = raw.sections.map(() => []);
  for (const repairedBlock of repaired.blocks as TaggedBlock[]) {
    const target = repairedBySection[repairedBlock.__sectionIndex];
    if (target) target.push({ kind: repairedBlock.kind, text: repairedBlock.text });
  }
  for (let i = 0; i < raw.sections.length; i++) {
    const count = (repairedBySection[i]?.length ?? 0) - raw.sections[i]!.blocks.length;
    if (count > 0) warnings.push({
      code: "paragraphs-recovered",
      message: `Recovered ${count} paragraph breaks that this file had flattened into run-on text.`,
      sectionId: raw.sections[i]!.id,
    });
  }

  const normalizedBySection = repairedBySection.map((blocks, index) => {
    const result = normalizeBlocksWithReport(blocks, options);
    if (result.droppedCount > 0) warnings.push({
      code: "dropped-chars",
      message: `Removed ${result.droppedCount} characters that cannot be typed on a standard keyboard.`,
      sectionId: raw.sections[index]!.id,
    });
    return result.blocks;
  });
  const allNormalized = normalizedBySection.flat();
  const vocabulary = buildVocabulary(allNormalized);
  const pageStructured = detectPageStructure(allNormalized);
  const sections: Section[] = raw.sections.map((section, index) => {
    const cleaned = cleanBlocks(normalizedBySection[index] ?? [], {
      title: raw.title,
      author: raw.author,
      sectionTitle: section.title,
      vocabulary,
      pageStructured,
    });
    warnings.push(...cleaned.warnings.map((warning) => ({ ...warning, sectionId: section.id })));
    if (cleaned.blocks.length === 0) warnings.push({
      code: "empty-section",
      message: "This section contains no readable text.",
      sectionId: section.id,
    });
    const kind = section.kind ?? "body";
    return {
      id: section.id,
      href: section.href,
      title: section.title,
      order: index,
      kind,
      included: kind === "body",
      blocks: cleaned.blocks,
      charCount: cleaned.blocks.reduce((sum, block) => sum + block.text.length, 0),
    };
  });

  return {
    book: {
      meta: {
        id: await contentId(bytes),
        title: raw.title,
        author: raw.author ?? "Unknown author",
        language: raw.language ?? "und",
        addedAt: Date.now(),
      },
      sections,
    },
    warnings,
  };
}

export async function parseBookFile(
  file: File,
  options: ParseBookOptions = { foldAccents: true },
): Promise<ParseResult> {
  const format = detectFormat(file);
  if (!format) {
    throw new Error("Unsupported book format. Choose an EPUB, PDF, TXT, Markdown, or HTML file.");
  }
  if (format === "epub") return parseEpub(file, options);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fallbackTitle = filenameTitle(file.name);
  let raw: RawBook;
  if (format === "pdf") {
    const { parsePdfFile } = await import("./pdf");
    raw = await parsePdfFile(bytes, fallbackTitle);
  } else {
    const source = decodePlainText(bytes);
    if (format === "txt") {
      raw = parseTextBook(source, fallbackTitle);
    } else if (format === "markdown") {
      const { marked } = await import("marked");
      const rendered = marked.parse(source, { async: false });
      raw = parseHtmlDocument(rendered, fallbackTitle, "markdown");
    } else {
      raw = parseHtmlDocument(source, fallbackTitle, "html");
    }
  }
  return finalizeRawBook(raw, bytes, options);
}
