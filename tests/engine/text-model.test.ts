import { describe, expect, test } from "vitest";
import {
  buildCanonicalNonSpaceIndex,
  canonicalNonSpaceCharsAt,
  findLessonEnd,
  isValidLessonAnchor,
  lessonCorpusSignature,
  makeLessonAnchor,
  normalizePosition,
  reconstructRecentLessonAnchors,
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

describe("lesson corpus signature", () => {
  test("is deterministic and changes with the runtime inclusion mask", () => {
    const included = makeBook([
      { id: "first", blocks: [{ text: "alpha" }] },
      { id: "middle", blocks: [{ text: "beta" }] },
      { id: "last", blocks: [{ text: "gamma" }] },
    ]);
    const excluded = makeBook([
      { id: "first", blocks: [{ text: "alpha" }] },
      { id: "middle", included: false, blocks: [{ text: "beta" }] },
      { id: "last", blocks: [{ text: "gamma" }] },
    ]);

    expect(lessonCorpusSignature(included)).toMatch(/^[0-9a-f]{16}$/);
    expect(lessonCorpusSignature(included)).toBe(
      lessonCorpusSignature(structuredClone(included)),
    );
    expect(lessonCorpusSignature(excluded)).not.toBe(
      lessonCorpusSignature(included),
    );
  });
});

describe("findLessonEnd", () => {
  test("uses the fallback when the next word exceeds the bounded overshoot", () => {
    const fallback = `${"a".repeat(99)} b `;
    const text = `${fallback}${"x".repeat(30)} future`;
    const book = makeBook([{ id: "one", blocks: [{ text }] }]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: fallback.length });
    expect(
      findLessonEnd(
        book,
        { sectionIndex: 0, blockIndex: 0, charIndex: fallback.length },
        100,
      ),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: text.length });
  });

  test("prefers a source block end over an earlier sentence inside the window", () => {
    const first = `${"a".repeat(99)} b end. short`;
    const book = makeBook([
      { id: "one", blocks: [{ text: first }, { text: "next lesson" }] },
    ]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });
  });

  test("prefers the first sentence boundary when no source end fits the window", () => {
    const sentence = `${"a".repeat(99)} b end. `;
    const text = `${sentence}${"x".repeat(30)} future`;
    const book = makeBook([{ id: "one", blocks: [{ text }] }]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: sentence.length });
  });

  test.each([100, 200])("caps a %i target's prose scan at 20/25 extra characters", (target) => {
    const fallback = `${"a".repeat(target - 1)} b `;
    const text = `${fallback}${"x".repeat(30)} after`;
    const book = makeBook([{ id: "one", blocks: [{ text }] }]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, target),
    ).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: fallback.length });
  });

  test("never splits verse after reaching target", () => {
    const verse = Array.from({ length: 26 }, () => "word").join(" ");
    const book = makeBook([
      {
        id: "poem",
        blocks: [{ text: verse, kind: "verse" }, { text: "after", kind: "paragraph" }],
      },
    ]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });
  });

  test("carries an over-target starting heading into the following prose word", () => {
    const book = makeBook([
      {
        id: "chapter",
        blocks: [
          { text: "H".repeat(120), kind: "heading" },
          { text: "Opening prose continues", kind: "paragraph" },
        ],
      },
    ]);

    expect(
      findLessonEnd(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100),
    ).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 8 });
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

describe("persisted lesson anchors", () => {
  test("validates exact canonical ranges without recomputing historical ends", () => {
    const book = makeBook([
      { id: "one", blocks: [{ text: "alpha beta gamma delta" }] },
    ]);
    const historical = {
      start: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      end: { sectionIndex: 0, blockIndex: 0, charIndex: 6 },
      targetNonSpaceChars: 100,
      plannerVersion: 1,
    };

    expect(isValidLessonAnchor(book, historical)).toBe(true);
    expect(
      isValidLessonAnchor(book, {
        ...historical,
        plannerVersion: 2,
      }),
    ).toBe(false);
    expect(
      isValidLessonAnchor(book, {
        ...historical,
        end: historical.start,
      }),
    ).toBe(false);
  });

  test("reconstructs only recent section-local anchors and closes a legacy gap", () => {
    const text = Array.from({ length: 170 }, () => "word").join(" ");
    const book = makeBook([{ id: "one", blocks: [{ text }] }]);
    const frontier = { sectionIndex: 0, blockIndex: 0, charIndex: 620 };
    const anchors = reconstructRecentLessonAnchors(book, frontier, 100, 2);

    expect(anchors).toHaveLength(2);
    expect(anchors.at(-1)?.end).toEqual(frontier);
    expect(anchors.every((anchor) => anchor.targetNonSpaceChars === 100)).toBe(
      true,
    );
    expect(anchors[0]?.start).not.toEqual(
      makeLessonAnchor(book, { sectionIndex: 0, blockIndex: 0, charIndex: 0 }, 100)
        .start,
    );
  });

  test("includes the previous typeable section when frontier is at section start", () => {
    const previousText = Array.from({ length: 130 }, () => "word").join(" ");
    const book = makeBook([
      { id: "previous", blocks: [{ text: previousText }] },
      { id: "empty", blocks: [] },
      { id: "current", blocks: [{ text: "current passage" }] },
    ]);
    const frontier = { sectionIndex: 2, blockIndex: 0, charIndex: 0 };
    const anchors = reconstructRecentLessonAnchors(book, frontier, 100);

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]?.start.sectionIndex).toBe(0);
    expect(anchors.at(-1)?.end).toEqual(frontier);
  });
});
