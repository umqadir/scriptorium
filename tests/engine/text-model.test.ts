import { describe, expect, test } from "vitest";
import { normalizePosition } from "../../src/engine/text-model";
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
