import { describe, expect, test } from "vitest";
import {
  buildCanonicalNonSpaceIndex,
  canonicalNonSpaceCharsAt,
  findLessonEnd,
  normalizePosition,
} from "../../src/engine/text-model";
import { makeBook } from "./helpers";

describe("normalizePosition", () => {
  test("preserves an exact non-final block boundary while clamping overshoot", () => {
    const book = makeBook([
      { id: "one", blocks: [{ text: "abc" }, { text: "def" }] },
    ]);

    expect(
      normalizePosition(book, { sectionIndex: 0, blockIndex: 0, charIndex: 3 }),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 3 });
    expect(
      normalizePosition(book, { sectionIndex: 0, blockIndex: 0, charIndex: 4 }),
    ).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });
  });

  test("clamps negative and fractional indices to safe integers", () => {
    const book = makeBook([{ id: "one", blocks: [{ text: "abcd" }] }]);

    expect(
      normalizePosition(book, {
        sectionIndex: -2.5,
        blockIndex: -4.2,
        charIndex: -9.8,
      }),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(
      normalizePosition(book, {
        sectionIndex: 0.9,
        blockIndex: 0.7,
        charIndex: 2.9,
      }),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 2 });
  });

  test("skips empty included sections and defensive empty blocks", () => {
    const book = makeBook([
      { id: "empty-section", blocks: [] },
      { id: "mixed", blocks: [{ text: "" }, { text: "ready" }] },
    ]);

    expect(
      normalizePosition(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }),
    ).toEqual({ sectionIndex: 1, blockIndex: 1, charIndex: 0 });
  });

  test("returns a harmless origin when there is no typeable included content", () => {
    const book = makeBook([
      { id: "excluded", included: false, blocks: [{ text: "no" }] },
      { id: "empty", blocks: [] },
    ]);
    expect(
      normalizePosition(book, { sectionIndex: 99, blockIndex: 99, charIndex: 99 }),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
  });
});

describe("canonical non-space index", () => {
  test("uses per-block prefix offsets while excluding skipped sections and empty text", () => {
    const book = makeBook([
      { id: "first", blocks: [{ text: "a b" }, { text: "" }] },
      { id: "excluded", included: false, blocks: [{ text: "not counted" }] },
      { id: "empty", blocks: [] },
      { id: "last", blocks: [{ text: " c" }] },
    ]);
    const index = buildCanonicalNonSpaceIndex(book);

    const countAt = (sectionIndex: number, blockIndex: number, charIndex: number) =>
      canonicalNonSpaceCharsAt(index, { sectionIndex, blockIndex, charIndex });
    expect(countAt(0, 0, 0)).toBe(0);
    expect(countAt(0, 0, 2)).toBe(1);
    expect(countAt(0, 0, 3)).toBe(2);
    expect(countAt(0, 1, 0)).toBe(2);
    expect(countAt(3, 0, 1)).toBe(2);
    expect(countAt(3, 0, 2)).toBe(3);
  });
});

describe("findLessonEnd", () => {
  test("ends after the first post-target space and otherwise uses the final remainder", () => {
    const text = `${"a".repeat(99)} bb future`;
    const book = makeBook([{ id: "one", blocks: [{ text }] }]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 103 });
    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 103 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: text.length });
  });

  test("uses an Enter end across included sections and skips excluded or empty content", () => {
    const book = makeBook([
      { id: "one", blocks: [{ text: "a".repeat(60) }, { text: "b".repeat(45) }] },
      { id: "excluded", included: false, blocks: [{ text: "x".repeat(200) }] },
      { id: "empty", blocks: [] },
      { id: "two", blocks: [{ text: "remainder" }] },
    ]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 3, blockIndex: 0, charIndex: 0 });
  });
});
