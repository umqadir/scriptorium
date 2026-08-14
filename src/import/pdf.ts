import {
  GlobalWorkerOptions,
  getDocument,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { Block } from "../types";
import type { RawBook, RawBookSection } from "./parse-book";

const nodeRuntime = (globalThis as typeof globalThis & {
  process?: { versions?: { node?: string } };
}).process?.versions?.node;
if (!nodeRuntime) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfTextItemLike {
  str: string;
  transform: ArrayLike<number>;
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export interface PdfGroupedLine {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

type PositionedItem = PdfTextItemLike & {
  x: number;
  y: number;
  fontSize: number;
  sourceIndex: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function itemPosition(item: PdfTextItemLike, sourceIndex: number): PositionedItem | undefined {
  if (!item.str || item.str.trim().length === 0) return undefined;
  const x = Number(item.transform[4] ?? 0);
  const y = Number(item.transform[5] ?? 0);
  const transformHeight = Math.hypot(
    Number(item.transform[2] ?? 0),
    Number(item.transform[3] ?? 0),
  );
  const fontSize = Math.max(1, Math.abs(item.height ?? transformHeight));
  return { ...item, x, y, fontSize, sourceIndex };
}

function joinLineItems(items: PositionedItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x || a.sourceIndex - b.sourceIndex);
  let text = "";
  let previous: PositionedItem | undefined;
  for (const item of sorted) {
    const piece = item.str;
    if (!text) {
      text = piece;
      previous = item;
      continue;
    }
    const previousEnd = previous ? previous.x + Math.max(0, previous.width ?? 0) : item.x;
    const gap = item.x - previousEnd;
    const needsSpace = !/\s$/.test(text) && !/^\s/.test(piece)
      && gap > Math.max(0.5, Math.min(previous?.fontSize ?? item.fontSize, item.fontSize) * 0.12);
    text += needsSpace ? ` ${piece}` : piece;
    previous = item;
  }
  return text.replace(/\s+/g, " ").trim();
}

function splitAtColumnGaps(items: PositionedItem[]): PositionedItem[][] {
  const sorted = [...items].sort((a, b) => a.x - b.x || a.sourceIndex - b.sourceIndex);
  const groups: PositionedItem[][] = [[]];
  for (const item of sorted) {
    const group = groups[groups.length - 1]!;
    const previous = group[group.length - 1];
    if (previous) {
      const previousWidth = previous.width ?? previous.str.length * previous.fontSize * 0.5;
      const gap = item.x - (previous.x + Math.max(0, previousWidth));
      if (gap > Math.max(48, Math.max(previous.fontSize, item.fontSize) * 5)) groups.push([]);
    }
    groups[groups.length - 1]!.push(item);
  }
  return groups.filter((group) => group.length > 0);
}

/** Group positioned PDF.js text items into visual lines in reading order. */
export function groupPdfTextItemsIntoLines(items: PdfTextItemLike[]): PdfGroupedLine[] {
  const positioned = items
    .map(itemPosition)
    .filter((item): item is PositionedItem => item !== undefined);
  if (positioned.length === 0) return [];
  const tolerance = Math.max(1.5, median(positioned.map((item) => item.fontSize)) * 0.35);
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x || a.sourceIndex - b.sourceIndex);
  const rows: { y: number; items: PositionedItem[] }[] = [];
  for (const item of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (row) {
      row.items.push(item);
      row.y = row.items.reduce((sum, current) => sum + current.y, 0) / row.items.length;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }
  let sawColumnGap = false;
  const lines = rows.flatMap((row) => {
    const columnGroups = splitAtColumnGaps(row.items);
    if (columnGroups.length > 1) sawColumnGap = true;
    return columnGroups.map((group) => ({
      text: joinLineItems(group),
      x: Math.min(...group.map((item) => item.x)),
      y: row.y,
      width: Math.max(...group.map((item) =>
        item.x + Math.max(item.width ?? item.str.length * item.fontSize * 0.5, 0),
      )) - Math.min(...group.map((item) => item.x)),
      fontSize: median(group.map((item) => item.fontSize)),
    }));
  }).filter((line) => line.text.length > 0);

  if (sawColumnGap && lines.length >= 4) {
    const xValues = [...lines].sort((a, b) => a.x - b.x);
    let largestGap = 0;
    let cut = 0;
    for (let i = 1; i < xValues.length; i++) {
      const gap = xValues[i]!.x - xValues[i - 1]!.x;
      if (gap > largestGap) {
        largestGap = gap;
        cut = (xValues[i]!.x + xValues[i - 1]!.x) / 2;
      }
    }
    const font = median(lines.map((line) => line.fontSize));
    if (largestGap > Math.max(80, font * 6)) {
      return [
        ...lines.filter((line) => line.x < cut).sort((a, b) => b.y - a.y),
        ...lines.filter((line) => line.x >= cut).sort((a, b) => b.y - a.y),
      ];
    }
  }
  return lines.sort((a, b) => b.y - a.y || a.x - b.x);
}

type XmpLike = { get(name: string): unknown };

function metadataString(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || undefined;
  if (Array.isArray(value)) {
    const joined = value.map(metadataString).filter((item): item is string => !!item).join(", ");
    return joined || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return metadataString(record["x-default"] ?? record["#text"] ?? record.value);
  }
  return undefined;
}

export function pdfMetadataFromValues(
  info: unknown,
  xmp: XmpLike | null | undefined,
  fallbackTitle: string,
): { title: string; author?: string; language?: string } {
  const values = info && typeof info === "object" ? info as Record<string, unknown> : {};
  return {
    title: metadataString(values.Title) ?? metadataString(xmp?.get("dc:title")) ?? fallbackTitle,
    author: metadataString(values.Author) ?? metadataString(xmp?.get("dc:creator")),
    language: metadataString(values.Language) ?? metadataString(xmp?.get("dc:language")),
  };
}

export function mapPdfError(error: unknown): Error {
  const record = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : {};
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (name === "PasswordException" || /password/i.test(message)) {
    return new Error("This PDF is password-protected. Remove the password and try again.");
  }
  if (
    name === "InvalidPDFException" || name === "MissingPDFException"
    || name === "UnexpectedResponseException" || /invalid pdf|malformed pdf/i.test(message)
  ) {
    return new Error("This file is not a valid PDF or is damaged.");
  }
  return new Error("This PDF could not be read.");
}

type PdfPage<T extends string | PdfGroupedLine = string> = { pageNumber: number; lines: T[] };

function lineText(line: string | PdfGroupedLine): string {
  return typeof line === "string" ? line : line.text;
}

function edgeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isStandalonePageNumber(text: string): boolean {
  const value = text.trim();
  return /^\d{1,5}$/.test(value) || /^[ivxlcdm]{1,8}$/i.test(value);
}

/** Suppress only deterministic page-edge artifacts, never repeated body text. */
export function suppressPdfPageArtifacts<T extends string | PdfGroupedLine>(pages: PdfPage<T>[]): PdfPage<T>[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const candidates = new Set(
      [...page.lines.slice(0, 2), ...page.lines.slice(-2)].map((line) => edgeKey(lineText(line))),
    );
    for (const candidate of candidates) {
      if (candidate && candidate.length <= 120 && !isStandalonePageNumber(candidate)) {
        counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
      }
    }
  }
  const required = Math.max(3, Math.ceil(pages.length * 0.6));
  const repeated = new Set(Array.from(counts).filter(([, count]) => count >= required).map(([key]) => key));
  return pages.map((page) => ({
    ...page,
    lines: page.lines.filter((line, index) => {
      const atEdge = index < 2 || index >= page.lines.length - 2;
      if (!atEdge) return true;
      const text = lineText(line);
      return !isStandalonePageNumber(text) && !repeated.has(edgeKey(text));
    }),
  }));
}

type OutlineItem = { title: string; dest: string | unknown[] | null; items?: OutlineItem[] };
type PdfDocumentLike = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: unknown[]; lang?: string | null }>;
  }>;
  getMetadata(): Promise<{ info: unknown; metadata: XmpLike | null }>;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
};

async function outlineMarkers(pdf: PdfDocumentLike): Promise<{ title: string; pageIndex: number }[]> {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const selected = outline.length >= 2 ? outline : (outline[0]?.items?.length ? outline[0].items : outline);
  const markers: { title: string; pageIndex: number }[] = [];
  for (const item of selected.slice(0, 80)) {
    try {
      const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      const target = destination?.[0];
      const pageIndex = typeof target === "number" ? target : await pdf.getPageIndex(target);
      const title = item.title.replace(/\s+/g, " ").trim();
      if (title && pageIndex >= 0 && pageIndex < pdf.numPages) markers.push({ title, pageIndex });
    } catch {
      // A broken outline entry should not make otherwise-readable pages fail.
    }
  }
  const unique = new Map<number, string>();
  for (const marker of markers.sort((a, b) => a.pageIndex - b.pageIndex)) {
    if (!unique.has(marker.pageIndex)) unique.set(marker.pageIndex, marker.title);
  }
  return Array.from(unique, ([pageIndex, title]) => ({ pageIndex, title }));
}

function range(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

function beginsUppercase(text: string): boolean {
  return /^["'(\[]*[A-Z]/.test(text.trim());
}

/**
 * Reconstruct prose paragraphs without erasing likely verse line boundaries.
 * Runs split at visibly large vertical gaps or font-size changes. Within a
 * run, lines join only when left edges and widths resemble a wrapped text
 * column and most interior lines look like continuations. Ragged/indented or
 * repeatedly capitalized verse stays as one Block per visual line.
 */
export function reconstructPdfPageBlocks(lines: PdfGroupedLine[]): Block[] {
  if (lines.length === 0) return [];
  const ordered = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const gaps = ordered.slice(1).map((line, index) => Math.max(0, ordered[index]!.y - line.y));
  const typicalGap = median(gaps.filter((gap) => gap > 0));
  const runs: PdfGroupedLine[][] = [];
  let current: PdfGroupedLine[] = [];
  for (const line of ordered) {
    const previous = current[current.length - 1];
    const verticalGap = previous ? previous.y - line.y : 0;
    const fontRatio = previous
      ? Math.max(previous.fontSize, line.fontSize) / Math.max(1, Math.min(previous.fontSize, line.fontSize))
      : 1;
    const strongGap = !!previous && verticalGap > Math.max(typicalGap * 1.55, previous.fontSize * 1.45);
    const paragraphIndent = !!previous && current.length >= 2
      && line.x - previous.x > Math.max(previous.fontSize, line.fontSize) * 1.2;
    if (previous && (strongGap || fontRatio > 1.28 || paragraphIndent)) {
      runs.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) runs.push(current);

  const blocks: Block[] = [];
  for (const run of runs) {
    if (run.length === 1) {
      blocks.push({ kind: "paragraph", text: run[0]!.text });
      continue;
    }
    const font = median(run.map((line) => line.fontSize));
    const comparisonLines = run.length > 2 ? run.slice(1) : run;
    const alignedLeft = range(comparisonLines.map((line) => line.x)) <= font * 0.9;
    const maxWidth = Math.max(...run.map((line) => line.width));
    const interior = run.slice(0, -1);
    const wideRatio = interior.filter((line) => line.width >= maxWidth * 0.68).length
      / Math.max(1, interior.length);
    const continuationRatio = interior.filter((line) => !endsSentence(line.text)).length
      / Math.max(1, interior.length);
    const ragged = range(run.map((line) => line.width)) > maxWidth * 0.38;
    const capitalizedRatio = run.filter((line) => beginsUppercase(line.text)).length / run.length;
    const likelyVerse = run.length >= 3 && capitalizedRatio >= 0.75 && (ragged || wideRatio < 0.75);
    const likelyProse = alignedLeft && wideRatio >= 0.67 && continuationRatio >= 0.5 && !likelyVerse;
    if (likelyProse) {
      blocks.push({ kind: "paragraph", text: run.map((line) => line.text).join(" ") });
    } else {
      blocks.push(...run.map((line): Block => ({ kind: "verse", text: line.text })));
    }
  }
  return blocks;
}

function pageBlocks(pages: PdfPage<PdfGroupedLine>[], start: number, endExclusive: number): Block[] {
  return pages.slice(start, endExclusive).flatMap((page) => reconstructPdfPageBlocks(page.lines));
}

function pdfSections(
  pages: PdfPage<PdfGroupedLine>[],
  markers: { title: string; pageIndex: number }[],
  title: string,
): RawBookSection[] {
  if (markers.length > 0) {
    const starts = markers[0]!.pageIndex > 0
      ? [{ title: "Opening pages", pageIndex: 0 }, ...markers]
      : markers;
    return starts.map((marker, index) => {
      const end = starts[index + 1]?.pageIndex ?? pages.length;
      return {
        id: `pdf-${marker.pageIndex + 1}`,
        href: `#page=${marker.pageIndex + 1}`,
        title: marker.title,
        blocks: pageBlocks(pages, marker.pageIndex, end),
      };
    });
  }

  const rangeSize = 20;
  const sections: RawBookSection[] = [];
  for (let start = 0; start < pages.length; start += rangeSize) {
    const end = Math.min(pages.length, start + rangeSize);
    sections.push({
      id: `pdf-${start + 1}`,
      href: `#page=${start + 1}`,
      title: pages.length <= rangeSize ? title : `Pages ${start + 1}-${end}`,
      blocks: pageBlocks(pages, start, end),
    });
  }
  return sections;
}

export async function parsePdfFile(bytes: Uint8Array, fallbackTitle: string): Promise<RawBook> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let pdf: PdfDocumentLike | undefined;
  try {
    loadingTask = getDocument({ data: bytes.slice(), useWorkerFetch: false, useSystemFonts: true });
    pdf = await loadingTask.promise as unknown as PdfDocumentLike;
    const metadataResult = await pdf.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const metadata = pdfMetadataFromValues(metadataResult.info, metadataResult.metadata, fallbackTitle);
    const pages: PdfPage<PdfGroupedLine>[] = [];
    let detectedLanguage = metadata.language;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      detectedLanguage ??= metadataString(content.lang);
      const textItems = content.items.filter(
        (item): item is PdfTextItemLike => !!item && typeof item === "object" && "str" in item && "transform" in item,
      );
      pages.push({
        pageNumber,
        lines: groupPdfTextItemsIntoLines(textItems),
      });
    }
    const cleanedPages = suppressPdfPageArtifacts(pages);
    const markers = await outlineMarkers(pdf);
    return {
      ...metadata,
      ...(detectedLanguage ? { language: detectedLanguage } : {}),
      sections: pdfSections(cleanedPages, markers, metadata.title),
    };
  } catch (error) {
    throw mapPdfError(error);
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}
