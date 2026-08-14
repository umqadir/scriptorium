/**
 * Repair pass — runs on RAW blocks, before character normalization.
 *
 * Everything here depends on information that normalization destroys, so it
 * must run first:
 *   - mojibake repair needs the original mis-decoded byte sequences
 *   - paragraph recovery needs the interior whitespace runs intact
 *
 * See src/epub/clean.ts for the pass that runs *after* normalization.
 */
import type { Block, ParseWarning } from "../types";

export type RepairResult = {
  blocks: Block[];
  warnings: ParseWarning[];
};

// ───────────────────────────── Mojibake repair ─────────────────────────────
//
// UTF-8 bytes decoded as Latin-1/CP1252 produce a characteristic garble:
// "don’t" becomes "donâ€™t". It is endemic in EPUBs converted by sloppy
// tooling. The fix is to reverse the bad decode — re-encode the string as
// Latin-1 and decode it as UTF-8 — but only when we're confident, because
// running it on clean text corrupts legitimately accented prose.

/** Sequences that essentially only occur as mis-decoded UTF-8. */
const MOJIBAKE_SIGNATURES = [
  "â€™", "â€œ", "â€", "â€”", "â€“", "â€˜", "â€¦", "â€¢",
  "Ã©", "Ã¨", "Ã¤", "Ã¶", "Ã¼", "Ã±", "Ã§", "Ã ", "Ãº", "Ã­",
  "Â«", "Â»", "Â£", "Â©", "Â®", "Â°",
];

export function mojibakeScore(text: string): number {
  let hits = 0;
  for (const sig of MOJIBAKE_SIGNATURES) {
    let i = text.indexOf(sig);
    while (i !== -1) {
      hits++;
      i = text.indexOf(sig, i + sig.length);
    }
  }
  return hits;
}

/**
 * Reverse a Latin-1-decoded-as-UTF-8 mistake. Returns undefined if the string
 * cannot be round-tripped (i.e. it wasn't mojibake after all).
 */
export function undoMojibake(text: string): string | undefined {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code <= 0xff ? code : CP1252_CODE_POINT_TO_BYTE.get(code);
    // TextDecoder's windows-1252 decoder maps bytes 0x80-0x9f to Unicode
    // punctuation such as U+20AC and U+2019. Those code points are above the
    // Latin-1 range even though they still represent one original byte, so a
    // plain `code <= 0xff` check rejects the most common mojibake signatures
    // (notably â€™, â€œ and â€”). Anything outside both ranges really cannot have
    // come from a one-byte CP1252/Latin-1 misdecode.
    if (byte === undefined) return undefined;
    bytes[i] = byte;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return undefined;
  }
}

/** Reverse table for the printable Windows-1252 characters whose Unicode
 * code points are not equal to their source bytes. Undefined CP1252 byte
 * slots are intentionally absent: accepting them would make a purported
 * round-trip less trustworthy. */
const CP1252_CODE_POINT_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

/**
 * Repair mojibake across a whole book's worth of text.
 *
 * Decided at book level, not per block: the mistake is made once by whatever
 * produced the file, so it's all-or-nothing. Judging per block would repair
 * some paragraphs and not others and leave the book internally inconsistent.
 */
export function repairMojibake(blocks: Block[]): {
  blocks: Block[];
  repaired: boolean;
  hits: number;
} {
  const sample = blocks.map((b) => b.text).join("\n");
  const hits = mojibakeScore(sample);
  // Require both an absolute floor and a density, so a book that happens to
  // contain the literal string "Â£" once isn't "repaired" into garbage.
  const density = hits / Math.max(1, sample.length / 10000);
  if (hits < 5 || density < 0.5) {
    return { blocks, repaired: false, hits };
  }

  let changed = 0;
  const out = blocks.map((b) => {
    const fixed = undoMojibake(b.text);
    if (fixed === undefined || fixed === b.text) return b;
    changed++;
    return { ...b, text: fixed };
  });

  if (changed === 0) return { blocks, repaired: false, hits };
  return { blocks: out, repaired: true, hits };
}

// ─────────────────────────── Paragraph recovery ────────────────────────────
//
// Some converters collapse an entire chapter into a single <p>, leaving the
// original paragraph breaks visible only as runs of interior whitespace —
// the leading indent of each lost paragraph. One book in the test corpus has
// a 33,664-character block whose paragraphs are separated by U+00A0 runs.
//
// This is why extractBlocks must not collapse whitespace: after collapsing,
// the structure is unrecoverable and the chapter is one unreadable slab.

/** Two or more spaces/nbsp/other Unicode spaces, mid-text. */
const INDENT_RUN = /[^\S\r\n]{2,}/gu;

/** Below this, a block is already reasonably sized; don't go looking. */
const RECOVERY_MIN_LENGTH = 2000;

/** A recovered paragraph shorter than this is probably a false positive. */
const MIN_PARAGRAPH = 40;

export function recoverParagraphs(blocks: Block[]): {
  blocks: Block[];
  recovered: number;
} {
  let recovered = 0;
  const out: Block[] = [];

  for (const block of blocks) {
    if (block.text.length < RECOVERY_MIN_LENGTH) {
      out.push(block);
      continue;
    }

    const pieces = splitOnIndents(block.text);
    if (pieces.length < 2) {
      out.push(block);
      continue;
    }

    recovered += pieces.length - 1;
    for (const text of pieces) {
      out.push({ ...block, text });
    }
  }

  return { blocks: out, recovered };
}

function splitOnIndents(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;

  INDENT_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INDENT_RUN.exec(text)) !== null) {
    // An indent run at position 0 is just this block's own leading indent.
    if (match.index === 0) continue;
    const piece = text.slice(start, match.index);
    if (piece.trim().length < MIN_PARAGRAPH) continue;
    pieces.push(piece);
    start = match.index + match[0].length;
  }

  if (pieces.length === 0) return [text];

  const tail = text.slice(start);
  if (tail.trim().length > 0) pieces.push(tail);
  return pieces;
}

// ──────────────────────────────── Orchestrator ─────────────────────────────

/**
 * Run the repair passes over a whole book's raw blocks.
 * Call once per book, between extraction and normalization.
 */
export function repairBlocks(blocks: Block[]): RepairResult {
  const warnings: ParseWarning[] = [];

  const moji = repairMojibake(blocks);
  if (moji.repaired) {
    warnings.push({
      code: "mojibake-repaired",
      message:
        `Fixed ${moji.hits} garbled character sequences (this file was ` +
        `saved with the wrong text encoding).`,
    });
  }

  const paras = recoverParagraphs(moji.blocks);
  if (paras.recovered > 0) {
    warnings.push({
      code: "paragraphs-recovered",
      message:
        `Recovered ${paras.recovered} paragraph breaks that this file had ` +
        `flattened into run-on text.`,
    });
  }

  return { blocks: paras.blocks, warnings };
}
