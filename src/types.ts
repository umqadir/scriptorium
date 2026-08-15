/**
 * Shared contract for Scriptorium.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE CORE INVARIANT — read this before touching anything else.        │
 * │                                                                      │
 * │ `Block.text` is the ONE canonical string for a block of text.        │
 * │ It is fully normalized at parse time so that, for every index i:     │
 * │                                                                      │
 * │     the glyph rendered at i  ===  the key the user must press at i   │
 * │                                                                      │
 * │ There is no second "comparison string" and no second "display        │
 * │ string". The renderer and the comparator index the SAME array of     │
 * │ characters. Downstream code MUST NOT re-normalize, trim, collapse,   │
 * │ or otherwise transform `Block.text` — doing so reintroduces the      │
 * │ index-drift bug class this app exists to avoid.                      │
 * │                                                                      │
 * │ All normalization happens exactly once, in src/epub/normalize.ts.    │
 * └──────────────────────────────────────────────────────────────────────┘
 */

// ───────────────────────────── Book/import layer ──────────────────────────

export type BlockKind = "heading" | "paragraph" | "verse" | "blockquote";

export type Block = {
  kind: BlockKind;
  /**
   * Canonical, already-normalized text. Display === expected, 1:1, per index.
   * Guaranteed: no leading/trailing whitespace, no tabs/newlines, no runs of
   * 2+ spaces, no characters outside the typeable set.
   */
  text: string;
};

/** Where an imported section sits in the book's structure. */
export type SectionKind = "body" | "frontmatter" | "backmatter";

export type Section = {
  /** Stable source-section id, unique within the book (an EPUB spine idref
   *  where available; a generated id for other formats). */
  id: string;
  /** Source-relative location or a generated anchor for synthetic sections. */
  href: string;
  title: string;
  order: number;
  kind: SectionKind;
  /** User-toggleable. Defaults to `kind === "body"`. */
  included: boolean;
  blocks: Block[];
  /** Sum of block text lengths. Excludes nothing — count what's here. */
  charCount: number;
};

export type BookMeta = {
  /** Content hash of the raw source-file bytes (sha-256, hex, first 16 chars).
   *  Stable across devices — this is what progress sync keys on. */
  id: string;
  title: string;
  author: string;
  language: string;
  /** Small (<=256px) JPEG/PNG data URL, or undefined. */
  coverDataUrl?: string;
  addedAt: number;
};

export type ParsedBook = {
  meta: BookMeta;
  sections: Section[];
};

/**
 * Non-fatal parser diagnostics retained for repair tests and debugging.
 * Routine cleanup details are deliberately not exposed in the product UI.
 */
export type ParseWarning = {
  code:
    // structural / character level (src/epub/parse.ts, extract.ts, normalize.ts)
    | "no-spine"
    | "empty-section"
    | "decode-fallback"
    | "dropped-chars"
    | "verse-numbers-stripped"
    | "no-cover"
    // quality layer (src/epub/repair.ts, clean.ts)
    | "mojibake-repaired"
    | "paragraphs-recovered"
    | "dehyphenated"
    | "blocks-split"
    | "noise-dropped"
    | "running-heads-removed"
    | "boilerplate-excluded";
  message: string;
  sectionId?: string;
};

export type ParseResult = {
  book: ParsedBook;
  warnings: ParseWarning[];
};

// ────────────────────────────── Engine layer ──────────────────────────────

export type Position = {
  sectionIndex: number;
  blockIndex: number;
  /** Index into Block.text. Equals text.length when the block is complete. */
  charIndex: number;
};

export type CharState =
  | "pending"
  | "correct"
  | "incorrect"
  /** Was wrong, user backspaced and fixed it. Counts against accuracy. */
  | "corrected";

export type Keystroke = {
  /** ms since session start */
  t: number;
  expected: string;
  actual: string;
  correct: boolean;
};

export type SessionStats = {
  wpm: number;
  rawWpm: number;
  /** 0–100 */
  accuracy: number;
  /** 0–100, coefficient-of-variation based, monkeytype-style */
  consistency: number;
  charsTyped: number;
  errors: number;
  elapsedMs: number;
};

export type LifetimeStats = {
  charsTyped: number;
  errors: number;
  timeMs: number;
  sessions: number;
};

export type BookProgress = {
  /** BookMeta.id — content hash. */
  bookId: string;
  position: Position;
  charsCompleted: number;
  totalChars: number;
  updatedAt: number;
  lifetime: LifetimeStats;
  bestWpm: number;
  /** Per-section included/excluded overrides, keyed by Section.id. */
  sectionOverrides: Record<string, boolean>;
};

// ───────────────────────────── Settings & sync ────────────────────────────

export type CaretStyle = "line" | "block" | "underline" | "off";
export type StopOnError = "off" | "letter" | "word";

export const MIN_VISIBLE_LINE_COUNT = 2;
export const MAX_VISIBLE_LINE_COUNT = 8;
export const DEFAULT_VISIBLE_LINE_COUNT = 3;

/** Validate the persisted/public line-count setting at the engine boundary. */
export function normalizeVisibleLineCount(value: unknown): number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_VISIBLE_LINE_COUNT &&
    value <= MAX_VISIBLE_LINE_COUNT
  )
    ? value
    : DEFAULT_VISIBLE_LINE_COUNT;
}

export type Settings = {
  theme: string;
  fontFamily: string;
  fontSize: number;
  caretStyle: CaretStyle;
  smoothCaret: boolean;
  stopOnError: StopOnError;
  /** Fold accented Latin letters to ASCII (ä→a). Applied at import time. */
  foldAccents: boolean;
  soundOnClick: boolean;
  showLiveWpm: boolean;
  /** Physical typing rows visible at once. Integer from 2 through 8. */
  contextLines: number;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "serika_dark",
  fontFamily: "Roboto Mono",
  fontSize: 2,
  caretStyle: "line",
  smoothCaret: true,
  stopOnError: "off",
  foldAccents: true,
  soundOnClick: false,
  showLiveWpm: true,
  contextLines: DEFAULT_VISIBLE_LINE_COUNT,
};

/**
 * Cross-device sync payload.
 *
 * DELIBERATELY CONTAINS NO BOOK TEXT. Only progress and settings travel.
 * Books stay on the device that imported them. This is a hard requirement:
 * it keeps the app clear of redistributing copyrighted material. Anyone
 * adding a field here must preserve that property.
 */
export type SyncPayload = {
  version: 1;
  updatedAt: number;
  /** keyed by BookMeta.id (content hash) */
  progress: Record<string, BookProgress>;
  /** Titles only, so the other device can say "you have progress in X". */
  knownBooks: Record<string, { title: string; author: string }>;
  settings: Settings;
};
