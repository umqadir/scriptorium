import { describe, expect, test } from "vitest";
import type { Block } from "../../src/types";
import {
  TYPEABLE_RE,
  isTypeable,
  normalize,
  normalizeBlocksWithReport,
  trimWhitespaceClass,
} from "../../src/epub/normalize";

describe("normalize mappings", () => {
  test("folds smart punctuation, ellipses, and ligatures to canonical ASCII", () => {
    const input = "‘one’ ‛two′ “three” „four″ «five» — – ‒ − … ﬁ ﬂ";
    expect(normalize(input).text).toBe(
      "'one' 'two' \"three\" \"four\" \"five\" - - - - ... fi fl",
    );
  });

  test("removes invisible characters without counting them as dropped", () => {
    const result = normalize("a\u200bb\u200cc\u200dd\ufeffe\u00adf");
    expect(result).toEqual({ text: "abcdef", droppedCount: 0 });
  });

  test("maps required and Unicode separator whitespace to one ASCII space", () => {
    const separators = [
      " ", "\t", "\n", "\r", "\u00a0", "\u1680", "\u2000", "\u2005",
      "\u2007", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
    ];
    const input = separators.map((separator, i) => `word${i}${separator}`).join("") + "end";
    const result = normalize(input);
    expect(result.text).toBe(separators.map((_, i) => `word${i}`).join(" ") + " end");
    expect(result.droppedCount).toBe(0);
    expect(trimWhitespaceClass(`\u2005\u3000${result.text}\u202f`)).toBe(result.text);
  });

  test("folds decomposable accents and explicit-map letters when enabled", () => {
    const result = normalize("àéîõü øØ æÆ œŒ ß đĐ łŁ", { foldAccents: true });
    expect(result).toEqual({
      text: "aeiou oO aeAE oeOE ss dD lL",
      droppedCount: 0,
    });
  });

  test("documents SPEC behavior when accent folding is disabled", () => {
    // Canonical output remains printable ASCII, so an unfurled non-ASCII
    // letter is handled by the normal unsupported-character filter.
    expect(normalize("café", { foldAccents: false })).toEqual({
      text: "caf",
      droppedCount: 1,
    });
  });

  test("removes recognized footnote marks intentionally before drop counting", () => {
    expect(normalize("word† ‡§¶ next")).toEqual({
      text: "word next",
      droppedCount: 0,
    });
  });

  test("counts each unsupported Unicode code point and preserves word spacing", () => {
    expect(normalize("keep α 🙂 © going")).toEqual({
      text: "keep going",
      droppedCount: 3,
    });
  });
});

describe("canonical typeable set", () => {
  test("accepts exactly printable ASCII code points", () => {
    const printableAscii = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
      String.fromCharCode(i + 0x20),
    ).join("");

    expect(TYPEABLE_RE.test(printableAscii)).toBe(true);
    for (const ch of printableAscii) expect(isTypeable(ch)).toBe(true);
    expect(isTypeable("\u001f")).toBe(false);
    expect(isTypeable("\u007f")).toBe(false);
    expect(isTypeable("é")).toBe(false);
    expect(TYPEABLE_RE.test("ASCII plus é")).toBe(false);
  });

  test("every normalized result is trimmed, single-spaced printable ASCII", () => {
    const result = normalize(" \u2005“naïve”\t…  α ﬁne\u3000", { foldAccents: true });
    expect(result.text).toBe("\"naive\" ... fine");
    expect(TYPEABLE_RE.test(result.text)).toBe(true);
    expect(result.text).toBe(result.text.trim());
    expect(result.text).not.toContain("  ");
  });
});

describe("normalizeBlocksWithReport", () => {
  test("preserves kinds, aggregates drops, and removes blocks that normalize empty", () => {
    const blocks: Block[] = [
      { kind: "heading", text: "  A\u2005heading  " },
      { kind: "paragraph", text: "α🙂" },
      { kind: "verse", text: "§†" },
      { kind: "blockquote", text: "  ﬁnal  line  " },
    ];

    const result = normalizeBlocksWithReport(blocks, { foldAccents: true });

    expect(result.blocks).toEqual([
      { kind: "heading", text: "A heading" },
      { kind: "blockquote", text: "final line" },
    ]);
    expect(result.droppedCount).toBe(2);
    for (const block of result.blocks) expect(TYPEABLE_RE.test(block.text)).toBe(true);
  });
});
