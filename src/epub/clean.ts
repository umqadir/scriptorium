/**
 * Cleaning pass — runs on NORMALIZED blocks, after src/epub/normalize.ts.
 *
 * This is the layer that decides what makes *good typing material*, as
 * opposed to merely valid text. Every heuristic here was designed against a
 * corpus of nine real EPUBs (Project Gutenberg, Calibre output, a Kobo
 * .kepub, two Anna's Archive scans, a Norton Critical edition, Gabler's
 * Ulysses and the Lattimore Iliad) rather than invented in the abstract, and
 * each one is deliberately conservative: a false positive here silently
 * deletes or corrupts the user's book, which is far worse than leaving an
 * artifact in place.
 *
 * Two findings shaped the design and are worth stating, because both refute
 * the obvious approach:
 *
 *  1. Frequency-based running-head removal is a trap. In the Iliad the line
 *     "Son of Atreus, most lordly and king of men, Agamemnon," appears 7
 *     times because Homeric formulae repeat; in Ulysses the speaker label
 *     "BLOOM" appears 275 times because Circe is written as a play. Dropping
 *     repeated short blocks would destroy all of it. Running heads are a
 *     page-layout artifact, and EPUBs reflow — so we only look for them when
 *     the file shows independent evidence of being a page-structured
 *     conversion, and even then only remove blocks matching the book or
 *     section title.
 *
 *  2. Naive de-hyphenation corrupts text. `any- thing` and `to- ward` are
 *     real line-break hyphenations, but `three- or four-day` is a correct
 *     suspended hyphen and `himself- it` is a mangled dash. Joining blindly
 *     produces "threeor" and "himselfit". See dehyphenate() for the
 *     three-way rule that resolves this without shipping a dictionary.
 */
import type { Block, ParseWarning } from "../types";

export type CleanContext = {
  /** Book title, used only for the narrow running-head rule. */
  title?: string;
  author?: string;
  /** This section's title, same purpose. */
  sectionTitle?: string;
  /** Book-wide word frequencies from buildVocabulary(). */
  vocabulary: Map<string, number>;
  /** From detectPageStructure() — gates the running-head rule. */
  pageStructured: boolean;
};

export type CleanResult = {
  blocks: Block[];
  warnings: ParseWarning[];
};

// ──────────────────────────── Book-level analysis ──────────────────────────

const WORD = /[A-Za-z]+/g;

/**
 * Word frequencies across the whole book. This is the book's own dictionary:
 * it needs no shipped word list, works for any language using Latin script,
 * and already knows the book's proper nouns and coinages — which a general
 * English dictionary would reject.
 */
export function buildVocabulary(blocks: Block[]): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const block of blocks) {
    const words = block.text.match(WORD);
    if (!words) continue;
    for (const w of words) {
      const k = w.toLowerCase();
      vocab.set(k, (vocab.get(k) ?? 0) + 1);
    }
  }
  return vocab;
}

/**
 * Does this file look like it was converted from a paginated source?
 *
 * The tell is standalone page-number blocks: a reflowable EPUB has no reason
 * to contain a paragraph whose entire content is "147". Only when we see a
 * meaningful number of those do the page-artifact rules (running heads) get
 * to run at all.
 */
export function detectPageStructure(blocks: Block[]): boolean {
  let numeric = 0;
  for (const block of blocks) {
    if (block.kind === "heading") continue;
    if (isPageNumber(block.text)) numeric++;
  }
  return numeric >= 10;
}

function isPageNumber(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 6) return false;
  if (/^\d{1,4}$/.test(t)) return true;
  return /^[ivxlcdm]{1,6}$/i.test(t);
}

// ────────────────────────────── De-hyphenation ─────────────────────────────

/**
 * `X- y` — a hyphen with a space after it but none before — is always
 * malformed, but it has three different causes and three different fixes.
 *
 *   1. Suspended hyphen: "three- or four-day". The space is CORRECT here.
 *      Detected by the follower being a coordinating conjunction.
 *   2. Line-break hyphenation: "any- thing" -> "anything". Detected by the
 *      joined form being attested elsewhere in this same book.
 *   3. Everything else ("good- sized", "himself- it"): a compound or dash
 *      that lost its spacing. Close the gap rather than inventing a word —
 *      "good-sized" is right and "himself-it" is at worst harmless, whereas
 *      joining would produce "goodsized" and "himselfit".
 *
 * Validated against the corpus: on The Fifth Head of Cerberus this joins
 * any-/thing, to-/ward and com-/mandant while correctly leaving red- and,
 * stole- eggs and then- thick alone; on Moby-Dick it correctly leaves the
 * suspended "three- or" and "one- or" untouched.
 */
const HYPHEN_BREAK = /([A-Za-z]{2,})- ([a-z]{2,})/g;
const SUSPENDED_FOLLOWERS = new Set(["or", "and", "to", "nor", "but"]);

export function dehyphenate(
  blocks: Block[],
  vocabulary: Map<string, number>,
): { blocks: Block[]; joined: number; closed: number } {
  let joined = 0;
  let closed = 0;

  const out = blocks.map((block) => {
    const text = block.text.replace(HYPHEN_BREAK, (whole, a: string, b: string) => {
      if (SUSPENDED_FOLLOWERS.has(b.toLowerCase())) return whole;

      const merged = (a + b).toLowerCase();
      if ((vocabulary.get(merged) ?? 0) > 0) {
        joined++;
        return a + b;
      }

      closed++;
      return `${a}-${b}`;
    });
    return text === block.text ? block : { ...block, text };
  });

  return { blocks: out, joined, closed };
}

/**
 * A block ending in a hyphen, continued by the next block, is the same
 * artifact across a block boundary. Only merge when the joined form is
 * attested — this one is rare and the downside of a wrong merge is a
 * permanently mangled sentence.
 */
export function joinHyphenatedBlocks(
  blocks: Block[],
  vocabulary: Map<string, number>,
): { blocks: Block[]; joined: number } {
  const out: Block[] = [];
  let joined = 0;

  for (const block of blocks) {
    const prev = out[out.length - 1];
    const tail = prev && /([A-Za-z]{2,})-$/.exec(prev.text);
    const head = /^([a-z]{2,})/.exec(block.text);

    if (prev && tail && head && prev.kind === block.kind) {
      const merged = (tail[1]! + head[1]!).toLowerCase();
      if ((vocabulary.get(merged) ?? 0) > 0) {
        prev.text = prev.text.slice(0, -1) + block.text;
        joined++;
        continue;
      }
    }
    out.push({ ...block });
  }

  return { blocks: out, joined };
}

// ─────────────────────────── Punctuation spacing ───────────────────────────

/**
 * Remove space before closing punctuation: "word ." -> "word.".
 *
 * Deliberately excludes dashes. Joyce and Wolfe both use spaced dashes as a
 * dialogue convention (351 and 134 occurrences in the corpus respectively),
 * and "closing" those would rewrite the author's punctuation, not fix an
 * artifact.
 */
const SPACE_BEFORE_PUNCT = / +([,.;:!?])/g;

export function fixPunctuationSpacing(blocks: Block[]): {
  blocks: Block[];
  fixed: number;
} {
  let fixed = 0;
  const out = blocks.map((block) => {
    const text = block.text.replace(SPACE_BEFORE_PUNCT, (_m, p: string) => {
      fixed++;
      return p;
    });
    return text === block.text ? block : { ...block, text };
  });
  return { blocks: out, fixed };
}

// ────────────────────────────── Noise removal ──────────────────────────────

/** Footnote/reference marks that survive as literal text. */
const FOOTNOTE_MARKS = /[†‡§¶]/g;

/**
 * Blocks that are not worth typing: ornaments ("* * *"), horizontal rules,
 * bullets, standalone page numbers, stray single characters. Headings are
 * exempt — a chapter heading of "IV" is meaningful.
 */
export function dropNoiseBlocks(blocks: Block[]): {
  blocks: Block[];
  dropped: number;
} {
  let dropped = 0;
  const out = blocks.filter((block) => {
    if (block.kind === "heading") return true;
    const t = block.text.trim();

    if (t.length === 0) {
      dropped++;
      return false;
    }
    // No letters and no digits at all: ornaments, rules, bullet runs.
    if (!/[A-Za-z0-9]/.test(t)) {
      dropped++;
      return false;
    }
    if (isPageNumber(t)) {
      dropped++;
      return false;
    }
    if (t.length === 1) {
      dropped++;
      return false;
    }
    return true;
  });
  return { blocks: out, dropped };
}

export function stripFootnoteMarks(blocks: Block[]): {
  blocks: Block[];
  stripped: number;
} {
  let stripped = 0;
  const out = blocks.map((block) => {
    if (!FOOTNOTE_MARKS.test(block.text)) return block;
    FOOTNOTE_MARKS.lastIndex = 0;
    const text = block.text
      .replace(FOOTNOTE_MARKS, () => {
        stripped++;
        return "";
      })
      // the mark's own spacing usually collapses to a double space
      .replace(/ {2,}/g, " ")
      .trim();
    return { ...block, text };
  });
  return { blocks: out, stripped };
}

// ──────────────────────────── Running heads ────────────────────────────────

function headingKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Narrow, gated running-head removal. Only runs on page-structured
 * conversions, only removes short non-heading blocks, and only when the text
 * matches the book title, the author, or this section's title. See the file
 * header for why anything broader is unsafe.
 */
export function removeRunningHeads(
  blocks: Block[],
  ctx: CleanContext,
): { blocks: Block[]; removed: number } {
  if (!ctx.pageStructured) return { blocks, removed: 0 };

  const targets = new Set(
    [ctx.title, ctx.author, ctx.sectionTitle]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map(headingKey),
  );
  if (targets.size === 0) return { blocks, removed: 0 };

  let removed = 0;
  const out = blocks.filter((block) => {
    if (block.kind === "heading") return true;
    if (block.text.length > 80) return true;
    if (!targets.has(headingKey(block.text))) return true;
    removed++;
    return false;
  });

  return { blocks: out, removed };
}

// ─────────────────────────── Long-block splitting ──────────────────────────
//
// Block length across the corpus ranges from a p50 of 61 characters (Iliad
// verse) to single blocks of 33,664 characters. An enormous block is bad for
// typing in three ways: it renders slowly as per-character spans, it gives
// the reader no visual structure, and it offers no natural stopping point.
// Split oversized blocks at sentence boundaries into comfortable units.

const MAX_BLOCK_LENGTH = 1200;
const TARGET_BLOCK_LENGTH = 600;

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "rev", "hon", "sr", "jr",
  "capt", "col", "gen", "lt", "sgt", "maj", "adm", "gov", "pres",
  "vs", "etc", "eg", "ie", "cf", "al", "no", "vol", "ch", "fig",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * Split text into sentences. Conservative: a period only ends a sentence if
 * the following token looks like a sentence opening and the preceding token
 * is not a known abbreviation or a single initial.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /([.!?])(["'”’)\]]*)\s+(?=["'“‘(\[]*[A-Z0-9])/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const before = text.slice(start, match.index);
    const lastWord = /([A-Za-z]+)\.?$/.exec(before.trimEnd() + ".");

    if (lastWord) {
      const w = lastWord[1]!.toLowerCase();
      if (ABBREVIATIONS.has(w)) continue;
      if (w.length === 1) continue; // "J. R. R. Tolkien"
    }

    out.push(text.slice(start, end).trim());
    start = end;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out.length > 0 ? out : [text];
}

export function splitLongBlocks(blocks: Block[]): {
  blocks: Block[];
  split: number;
} {
  let split = 0;
  const out: Block[] = [];

  for (const block of blocks) {
    if (block.text.length <= MAX_BLOCK_LENGTH) {
      out.push(block);
      continue;
    }

    const sentences = splitSentences(block.text);
    if (sentences.length < 2) {
      // One unbroken run with no sentence boundaries (a Molly Bloom
      // situation). Fall back to splitting on word boundaries so it is at
      // least renderable, rather than leaving a 20k-character span run.
      out.push(...chunkOnWords(block, MAX_BLOCK_LENGTH));
      split++;
      continue;
    }

    let buffer = "";
    const flush = (): void => {
      if (buffer.length === 0) return;
      out.push({ ...block, text: buffer.trim() });
      buffer = "";
    };

    for (const sentence of sentences) {
      if (sentence.length > MAX_BLOCK_LENGTH) {
        flush();
        out.push(...chunkOnWords({ ...block, text: sentence }, MAX_BLOCK_LENGTH));
        continue;
      }
      if (buffer.length > 0 && buffer.length + sentence.length > TARGET_BLOCK_LENGTH) {
        flush();
      }
      buffer = buffer.length > 0 ? `${buffer} ${sentence}` : sentence;
    }
    flush();
    split++;
  }

  return { blocks: out, split };
}

function chunkOnWords(block: Block, size: number): Block[] {
  const words = block.text.split(" ");
  const out: Block[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push({ ...block, text: buffer });
    buffer = "";
  };

  for (const word of words) {
    if (word.length > size) {
      flush();
      // A pathological token (OCR garbage, a long URL, or text without any
      // spaces) still has to respect the renderer budget. Splitting it by
      // code units is safe here because normalized Block.text is printable
      // ASCII only. No character is inserted, removed, or reordered.
      let offset = 0;
      while (offset + size <= word.length) {
        out.push({ ...block, text: word.slice(offset, offset + size) });
        offset += size;
      }
      buffer = word.slice(offset);
      continue;
    }

    if (buffer.length > 0 && buffer.length + word.length + 1 > size) flush();
    buffer = buffer.length > 0 ? `${buffer} ${word}` : word;
  }
  flush();
  return out;
}

// ──────────────────────────────── Orchestrator ─────────────────────────────

/**
 * Run the full cleaning pipeline over one section's normalized blocks.
 *
 * Order matters: de-hyphenation before splitting (so a hyphen fix is never
 * stranded across a new block boundary), noise removal before running-head
 * removal (fewer candidates to scan), and splitting last so every emitted
 * block is within the size budget regardless of what earlier passes did.
 */
export function cleanBlocks(blocks: Block[], ctx: CleanContext): CleanResult {
  const warnings: ParseWarning[] = [];

  const joinedAcross = joinHyphenatedBlocks(blocks, ctx.vocabulary);
  const hyphens = dehyphenate(joinedAcross.blocks, ctx.vocabulary);
  const totalJoined = hyphens.joined + joinedAcross.joined;
  if (totalJoined + hyphens.closed > 0) {
    warnings.push({
      code: "dehyphenated",
      message:
        `Repaired ${totalJoined + hyphens.closed} broken hyphenations ` +
        `(${totalJoined} rejoined into whole words).`,
    });
  }

  const spacing = fixPunctuationSpacing(hyphens.blocks);
  const marks = stripFootnoteMarks(spacing.blocks);

  const noise = dropNoiseBlocks(marks.blocks);
  if (noise.dropped > 0) {
    warnings.push({
      code: "noise-dropped",
      message:
        `Removed ${noise.dropped} blocks that aren't worth typing ` +
        `(page numbers, ornaments, stray characters).`,
    });
  }

  const heads = removeRunningHeads(noise.blocks, ctx);
  if (heads.removed > 0) {
    warnings.push({
      code: "running-heads-removed",
      message: `Removed ${heads.removed} repeated page headers.`,
    });
  }

  const split = splitLongBlocks(heads.blocks);
  if (split.split > 0) {
    warnings.push({
      code: "blocks-split",
      message:
        `Split ${split.split} oversized paragraphs into readable chunks at ` +
        `sentence boundaries.`,
    });
  }

  // Final guarantee: nothing empty escapes this function.
  const blocksOut = split.blocks.filter((b) => b.text.trim().length > 0);

  return { blocks: blocksOut, warnings };
}
