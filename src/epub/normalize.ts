/**
 * Character-level normalization — the ONE place that produces the final
 * `Block.text` characters. See SPEC.md "Normalization rules" and the
 * invariant block at the top of src/types.ts: display glyph at index i must
 * equal the key the user presses at index i. Nothing downstream may touch
 * these characters again.
 *
 * Pipeline note: in this codebase normalization runs as its own composable
 * stage (`normalizeBlocks`), called from src/epub/index.ts after structural
 * extraction (and after any repair/mojibake-fixing stage that runs first).
 */

import type { Block } from "../types";

// ─────────────────────────── typeable set ───────────────────────────────
// Per SPEC.md: A-Z a-z 0-9, space, and !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
// That is exactly printable ASCII, 0x20 (space) through 0x7E (~).

export function isTypeable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/** Matches only if every character in the string is in the typeable set. */
export const TYPEABLE_RE = /^[\x20-\x7e]*$/;

// ───────────────────────── whitespace class ──────────────────────────────
// The explicitly-required whitespace plus the remaining Unicode Separator
// characters seen in converted books. Dropping one of these in the generic
// untypeable-character pass would join adjacent words (`you\u2005already` ->
// `youalready`), so all of them become an ASCII space first. Keep this as an
// explicit character string because extract.ts embeds it in its verse-number
// prefix character class.
export const WHITESPACE_CLASS_CHARS =
  " \t\n\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
const WHITESPACE_CHAR_RE = new RegExp(`[${WHITESPACE_CLASS_CHARS}]`, "g");
const LEADING_WHITESPACE_RE = new RegExp(`^[${WHITESPACE_CLASS_CHARS}]+`);
const TRAILING_WHITESPACE_RE = new RegExp(`[${WHITESPACE_CLASS_CHARS}]+$`);

/** Trim only whitespace-class characters (not a full normalize) — used by
 *  extract.ts on raw, pre-normalization text (e.g. to test for structurally
 *  empty blocks, or to measure verse-line length for the poetry heuristic). */
export function trimWhitespaceClass(s: string): string {
  return s.replace(LEADING_WHITESPACE_RE, "").replace(TRAILING_WHITESPACE_RE, "");
}

// ───────────────────── invisible / untypeable-as-glyph ──────────────────
// Zero-width space/non-joiner/joiner, BOM, and soft hyphen. Spec marks this
// row "(removed)", not "(removed, counted)" -- doesn't count toward the
// dropped-chars warning.
const INVISIBLE_RE = /[​‌‍﻿­]/g;

// Reference marks are structural noise, not unsupported prose characters.
// Remove them deliberately before the catch-all filter so imports do not
// report a misleading dropped-character warning for marks we recognize.
const FOOTNOTE_MARK_RE = /[†‡§¶]/g;

// ───────────────────────── punctuation folds ─────────────────────────────
const SINGLE_QUOTE_RE = /[‘’‛′]/g; // ' ‘ ’ ‛ ′
const DOUBLE_QUOTE_RE = /[“”„″«»]/g; // " “ ” „ ″ « »
const DASH_RE = /[—–‒−]/g; // — – ‒ −
const ELLIPSIS_RE = /…/g;

// ────────────────────────────── ligatures ────────────────────────────────
// Fold unconditionally -- not gated by foldAccents.
const LIGATURE_RE = /[ﬁﬂ]/g;
function replaceLigature(ch: string): string {
  return ch === "ﬁ" ? "fi" : "fl";
}

// ───────────────────────────── accent folding ────────────────────────────
// NFD handles most accented Latin letters generically (decompose, then strip
// combining marks). A handful of letters don't canonically decompose and
// need an explicit map.
const EXPLICIT_ACCENT_MAP: Record<string, string> = {
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ß: "ss",
  đ: "d",
  Đ: "D",
  ł: "l",
  Ł: "L",
};
const EXPLICIT_ACCENT_RE = /[øØæÆœŒßđĐłŁ]/g;
const COMBINING_MARK_RE = /\p{M}/gu;

function foldAccentedText(text: string): string {
  const decomposed = text.normalize("NFD").replace(COMBINING_MARK_RE, "");
  return decomposed.replace(EXPLICIT_ACCENT_RE, (ch) => EXPLICIT_ACCENT_MAP[ch] ?? ch);
}

// ────────────────────────────── normalize() ──────────────────────────────

export interface NormalizeOptions {
  foldAccents?: boolean;
}

export interface NormalizeResult {
  /** Fully normalized text: typeable-set only, single spaces, trimmed. */
  text: string;
  /** Count of characters dropped because, after every mapping rule ran,
   *  they were still outside the typeable set. */
  droppedCount: number;
}

/**
 * Normalize one string through the full character table, exactly once.
 * Order matters: invisible chars and ligatures fold first (unconditional),
 * then optional accent folding, then punctuation folds, then whitespace
 * collapses to literal spaces, THEN the catch-all typeable-set filter runs
 * (so a dropped character sitting between two spaces doesn't leave a
 * double space behind), and finally space runs collapse and the string is
 * trimmed.
 */
export function normalize(input: string, opts: NormalizeOptions = {}): NormalizeResult {
  let text = input;

  text = text.replace(INVISIBLE_RE, "");
  text = text.replace(FOOTNOTE_MARK_RE, "");
  text = text.replace(LIGATURE_RE, replaceLigature);

  if (opts.foldAccents) {
    text = foldAccentedText(text);
  }

  text = text.replace(SINGLE_QUOTE_RE, "'");
  text = text.replace(DOUBLE_QUOTE_RE, '"');
  text = text.replace(DASH_RE, "-");
  text = text.replace(ELLIPSIS_RE, "...");

  // Whitespace-class characters -> literal single space each.
  text = text.replace(WHITESPACE_CHAR_RE, " ");

  // Catch-all: anything still outside the typeable set is dropped & counted.
  let droppedCount = 0;
  let cleaned = "";
  for (const ch of text) {
    if (isTypeable(ch)) {
      cleaned += ch;
    } else {
      droppedCount++;
    }
  }

  // Collapse space runs (including ones newly created by a drop above),
  // then trim.
  cleaned = cleaned.replace(/ {2,}/g, " ").trim();

  return { text: cleaned, droppedCount };
}

// ────────────────────────── normalizeBlocks() ────────────────────────────
// Public composable pipeline stage: run every block's text through
// normalize(), drop blocks that end up empty. This is the exact seam the
// corpus-level `clean` stage runs after (see src/epub/index.ts).

export interface NormalizeBlocksOptions {
  foldAccents: boolean;
}

export interface NormalizeBlocksReport {
  blocks: Block[];
  /** Total characters dropped across all blocks (for the dropped-chars
   *  warning; the plain `normalizeBlocks` export below discards this). */
  droppedCount: number;
}

export function normalizeBlocksWithReport(
  blocks: Block[],
  opts: NormalizeBlocksOptions,
): NormalizeBlocksReport {
  const out: Block[] = [];
  let droppedCount = 0;
  for (const block of blocks) {
    const result = normalize(block.text, { foldAccents: opts.foldAccents });
    droppedCount += result.droppedCount;
    if (result.text.length === 0) continue; // empty blocks are dropped
    out.push({ kind: block.kind, text: result.text });
  }
  return { blocks: out, droppedCount };
}

export function normalizeBlocks(blocks: Block[], opts: NormalizeBlocksOptions): Block[] {
  return normalizeBlocksWithReport(blocks, opts).blocks;
}
