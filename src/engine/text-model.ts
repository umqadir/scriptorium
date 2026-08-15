/**
 * Pure, DOM-free helpers over `ParsedBook` structure and `Block.text`
 * indices. No normalization happens here - per the core invariant in
 * src/types.ts, `Block.text` is already canonical and these functions only
 * ever index into it, never transform it.
 */

import type { ParsedBook, Position } from "../types";

export type CanonicalNonSpaceIndex = ReadonlyArray<
  ReadonlyArray<{ base: number; prefix: Uint32Array } | null>
>;

/** Build an immutable-position lookup for rolling lesson length. Excluded
 * sections contribute no characters; empty included blocks retain the same
 * absolute base as the next typeable block. Construction is O(book chars),
 * while every subsequent Position lookup is O(1). */
export function buildCanonicalNonSpaceIndex(
  book: ParsedBook,
): CanonicalNonSpaceIndex {
  let absoluteCount = 0;
  return book.sections.map((section) =>
    section.blocks.map((block) => {
      if (!section.included) return null;
      const prefix = new Uint32Array(block.text.length + 1);
      for (let i = 0; i < block.text.length; i++) {
        prefix[i + 1] = prefix[i]! + (block.text[i] === " " ? 0 : 1);
      }
      const entry = { base: absoluteCount, prefix };
      absoluteCount += prefix[prefix.length - 1]!;
      return entry;
    }),
  );
}

/** Absolute count of included, canonical non-space characters before a
 * normalized Position. */
export function canonicalNonSpaceCharsAt(
  index: CanonicalNonSpaceIndex,
  position: Position,
): number {
  const entry = index[position.sectionIndex]?.[position.blockIndex];
  if (!entry) return 0;
  const charIndex = Math.min(
    entry.prefix.length - 1,
    Math.max(
      0,
      Number.isFinite(position.charIndex) ? Math.floor(position.charIndex) : 0,
    ),
  );
  return entry.base + entry.prefix[charIndex]!;
}

/** Canonical exclusive end of a finite lesson beginning at `start`.
 * A lesson stops after the first space reached with the target number of
 * non-space characters, or after the Enter boundary whose completed block
 * reaches the target. If neither occurs, the final book position is used. */
export function findLessonEnd(
  book: ParsedBook,
  start: Position,
  targetNonSpaceChars: number,
): Position {
  let position = normalizePosition(book, start);
  if (!hasTypeableContent(book)) return position;
  const target = Math.max(
    1,
    Number.isFinite(targetNonSpaceChars)
      ? Math.floor(targetNonSpaceChars)
      : 1,
  );
  let nonSpaceChars = 0;

  while (true) {
    const block = book.sections[position.sectionIndex]?.blocks[position.blockIndex];
    if (!block) return position;
    for (let charIndex = position.charIndex; charIndex < block.text.length; charIndex++) {
      const char = block.text[charIndex]!;
      if (char !== " ") nonSpaceChars += 1;
      if (char === " " && nonSpaceChars >= target) {
        return { ...position, charIndex: charIndex + 1 };
      }
    }

    const next = findNextBlock(book, position.sectionIndex, position.blockIndex);
    if (!next) return { ...position, charIndex: block.text.length };
    // The pilcrow/Enter is a natural boundary and belongs to this lesson;
    // its exclusive end is the next block's canonical zero position.
    if (nonSpaceChars >= target) return { ...next, charIndex: 0 };
    position = { ...next, charIndex: 0 };
  }
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function firstNonEmptyBlockIndex(
  book: ParsedBook,
  sectionIndex: number,
  from = 0,
): number | null {
  const blocks = book.sections[sectionIndex]?.blocks;
  if (!blocks) return null;
  for (let i = Math.max(0, from); i < blocks.length; i++) {
    if ((blocks[i]?.text.length ?? 0) > 0) return i;
  }
  return null;
}

function sectionIsTypeable(book: ParsedBook, sectionIndex: number): boolean {
  const section = book.sections[sectionIndex];
  return Boolean(section?.included && firstNonEmptyBlockIndex(book, sectionIndex) !== null);
}

/** Index of the first character of the "word" containing `index`.
 * A word starts at 0 or just after the nearest preceding space. */
export function getWordStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const spaceIndex = text.lastIndexOf(" ", index - 1);
  return spaceIndex + 1;
}

/** Index of the section to resume/start at when none is specified: the
 * first section with `included === true`, or 0 if none are included. */
export function firstIncludedSectionIndex(book: ParsedBook): number {
  const idx = book.sections.findIndex((s) => s.included);
  return idx === -1 ? 0 : idx;
}

/** First included section that actually contains a typeable block. */
export function firstTypeableSectionIndex(book: ParsedBook): number | null {
  for (let i = 0; i < book.sections.length; i++) {
    if (sectionIsTypeable(book, i)) return i;
  }
  return null;
}

export function hasTypeableContent(book: ParsedBook): boolean {
  return firstTypeableSectionIndex(book) !== null;
}

/** Next included section strictly after `from`, or null if there isn't one. */
export function nextIncludedSectionIndex(
  book: ParsedBook,
  from: number,
): number | null {
  for (let i = from + 1; i < book.sections.length; i++) {
    if (book.sections[i]?.included) return i;
  }
  return null;
}

/** Next included, non-empty section strictly after `from`. */
export function nextTypeableSectionIndex(
  book: ParsedBook,
  from: number,
): number | null {
  for (let i = from + 1; i < book.sections.length; i++) {
    if (sectionIsTypeable(book, i)) return i;
  }
  return null;
}

/** Previous included section strictly before `from`, or null if there isn't one. */
export function previousIncludedSectionIndex(
  book: ParsedBook,
  from: number,
): number | null {
  for (let i = from - 1; i >= 0; i--) {
    if (book.sections[i]?.included) return i;
  }
  return null;
}

/** The next non-empty block in reading order, skipping excluded and empty
 * sections as well as defensive empty blocks. */
export function findNextBlock(
  book: ParsedBook,
  sectionIndex: number,
  blockIndex: number,
): { sectionIndex: number; blockIndex: number } | null {
  const sameSection = firstNonEmptyBlockIndex(book, sectionIndex, blockIndex + 1);
  if (sameSection !== null && book.sections[sectionIndex]?.included) {
    return { sectionIndex, blockIndex: sameSection };
  }

  const nextSection = nextTypeableSectionIndex(book, sectionIndex);
  if (nextSection === null) return null;
  return {
    sectionIndex: nextSection,
    blockIndex: firstNonEmptyBlockIndex(book, nextSection)!,
  };
}

/**
 * Normalize a Position so it always points at a real, typeable character:
 *  - if the section isn't included (or doesn't exist), redirect to the
 *    first included section;
 *  - preserve the documented `charIndex === text.length` block-boundary
 *    state, where the engine waits for an explicit Enter before advancing;
 *  - if charIndex is past the end of the block, roll forward to the start
 *    of the next block, crossing into the next included section as needed;
 *  - if this rolls off the end of the book entirely, clamp at the very
 *    last character position of the last included section.
 */
export function normalizePosition(
  book: ParsedBook,
  position: Position,
): Position {
  let sectionIndex = nonNegativeInteger(position.sectionIndex);
  let blockIndex = nonNegativeInteger(position.blockIndex);
  let charIndex = nonNegativeInteger(position.charIndex);

  const firstTypeable = firstTypeableSectionIndex(book);
  if (firstTypeable === null) {
    // Position has no nullable/empty sentinel. Keep the harmless origin and
    // let TypingSession's `hasTypeableContent` guard disable input.
    return { sectionIndex: 0, blockIndex: 0, charIndex: 0 };
  }

  let section = book.sections[sectionIndex];
  if (!section || !sectionIsTypeable(book, sectionIndex)) {
    sectionIndex = firstTypeable;
    section = book.sections[sectionIndex];
    blockIndex = 0;
    charIndex = 0;
  }
  if (!section) return { sectionIndex: 0, blockIndex: 0, charIndex: 0 };

  let block = section.blocks[blockIndex];
  if (!block) {
    blockIndex = firstNonEmptyBlockIndex(book, sectionIndex)!;
    charIndex = 0;
    block = section.blocks[blockIndex];
  }
  if (!block || block.text.length === 0) {
    const nextInSection = firstNonEmptyBlockIndex(book, sectionIndex, blockIndex + 1);
    if (nextInSection !== null) {
      blockIndex = nextInSection;
      charIndex = 0;
      block = section.blocks[blockIndex]!;
    } else {
      const nextSection = nextTypeableSectionIndex(book, sectionIndex);
      if (nextSection === null) {
        // This cannot happen for a typeable section, but keep the return safe
        // against malformed runtime data.
        return {
          sectionIndex: firstTypeable,
          blockIndex: firstNonEmptyBlockIndex(book, firstTypeable)!,
          charIndex: 0,
        };
      }
      sectionIndex = nextSection;
      section = book.sections[sectionIndex]!;
      blockIndex = firstNonEmptyBlockIndex(book, sectionIndex)!;
      charIndex = 0;
      block = section.blocks[blockIndex]!;
    }
  }

  if (charIndex > block.text.length) {
    const next = findNextBlock(book, sectionIndex, blockIndex);
    if (next) return { ...next, charIndex: 0 };
    // End of book: clamp oversize positions to the documented terminal
    // `text.length` position of the final typeable block.
    charIndex = block.text.length;
  }

  return { sectionIndex, blockIndex, charIndex };
}

/** The block immediately before (sectionIndex, blockIndex), skipping
 * excluded sections. Null if there is nothing before it in the book. */
export function findPreviousBlock(
  book: ParsedBook,
  sectionIndex: number,
  blockIndex: number,
): { sectionIndex: number; blockIndex: number } | null {
  for (let i = blockIndex - 1; i >= 0; i--) {
    if ((book.sections[sectionIndex]?.blocks[i]?.text.length ?? 0) > 0) {
      return { sectionIndex, blockIndex: i };
    }
  }

  let prevSection = previousIncludedSectionIndex(book, sectionIndex);
  while (prevSection !== null) {
    const s = book.sections[prevSection]!;
    for (let i = s.blocks.length - 1; i >= 0; i--) {
      if ((s.blocks[i]?.text.length ?? 0) > 0) {
        return { sectionIndex: prevSection, blockIndex: i };
      }
    }
    prevSection = previousIncludedSectionIndex(book, prevSection);
  }
  return null;
}

/** True if `a` is at or before `b` in book order (section, then block). */
export function isAtOrBefore(
  a: { sectionIndex: number; blockIndex: number },
  b: { sectionIndex: number; blockIndex: number },
): boolean {
  if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex < b.sectionIndex;
  return a.blockIndex <= b.blockIndex;
}
