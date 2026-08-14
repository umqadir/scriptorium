import { describe, expect, test } from "vitest";
import type { Block } from "../../src/types";
import { splitLongBlocks } from "../../src/epub/clean";

function paragraph(text: string): Block {
  return { kind: "paragraph", text };
}

function expectWithinRendererBudget(blocks: Block[]): void {
  expect(blocks.length).toBeGreaterThan(1);
  for (const block of blocks) {
    expect(block.text.length).toBeGreaterThan(0);
    expect(block.text.length).toBeLessThanOrEqual(1200);
  }
}

describe("splitLongBlocks hard maximum", () => {
  test("chunks an overlong single sentence on word boundaries", () => {
    const text = `${Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ")}.`;
    const result = splitLongBlocks([paragraph(text)]);

    expectWithinRendererBudget(result.blocks);
    expect(result.blocks.map((block) => block.text).join(" ")).toBe(text);
    expect(result.split).toBe(1);
  });

  test("chunks an overlong sentence even when other sentence boundaries exist", () => {
    const first = `${Array.from({ length: 500 }, () => "archive").join(" ")}.`;
    const text = `${first} This short sentence must remain after it.`;
    const result = splitLongBlocks([paragraph(text)]);

    expectWithinRendererBudget(result.blocks);
    expect(result.blocks.map((block) => block.text).join(" ")).toBe(text);
  });

  test("splits a no-space token without losing or reordering any character", () => {
    const text = "x".repeat(3505);
    const result = splitLongBlocks([paragraph(text)]);

    expectWithinRendererBudget(result.blocks);
    expect(result.blocks.map((block) => block.text).join("")).toBe(text);
    expect(result.blocks.map((block) => block.text.length)).toEqual([1200, 1200, 1105]);
  });

  test("handles an oversized token embedded between ordinary words", () => {
    const token = "z".repeat(2501);
    const text = `before ${token} after`;
    const result = splitLongBlocks([paragraph(text)]);

    expectWithinRendererBudget(result.blocks);
    expect(result.blocks.map((block) => block.text.replaceAll(" ", "")).join("")).toBe(
      text.replaceAll(" ", ""),
    );
  });

  test("leaves blocks already within the limit untouched", () => {
    const block = paragraph("A short paragraph remains the same object.");
    const result = splitLongBlocks([block]);
    expect(result).toEqual({ blocks: [block], split: 0 });
    expect(result.blocks[0]).toBe(block);
  });
});
