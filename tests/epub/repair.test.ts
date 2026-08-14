import { describe, expect, test } from "vitest";
import { mojibakeScore, repairMojibake, undoMojibake } from "../../src/epub/repair";

describe("undoMojibake", () => {
  test("reverses common Windows-1252 punctuation bytes as well as Latin-1", () => {
    const garbled = "donâ€™t â€œquoteâ€ â€” pauseâ€¦ RenÃ©e";
    expect(undoMojibake(garbled)).toBe("don’t “quote” — pause… Renée");
  });

  test("covers the printable CP1252 characters outside Latin-1", () => {
    const garbled = "â€š â€ž â€  â€¡ Ë† â€° Å  â€¹ Å’ Å½ â€˜ â€™ â€œ â€ â€¢ â€“ â€” Ëœ â„¢ Å¡ â€º Å“ Å¾ Å¸";
    expect(undoMojibake(garbled)).toBe(
      "‚ „ † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ",
    );
  });

  test("rejects text that cannot be represented as one-byte CP1252", () => {
    expect(undoMojibake("clean Greek α text")).toBeUndefined();
    expect(undoMojibake("already correct — text")).toBeUndefined();
  });
});

describe("repairMojibake", () => {
  test("repairs a confidently garbled book at book scope", () => {
    const phrase = "He said â€œdonâ€™t pauseâ€”keep goingâ€¦â€ RenÃ©e agreed.";
    const text = Array.from({ length: 6 }, () => phrase).join(" ");
    expect(mojibakeScore(text)).toBeGreaterThanOrEqual(5);

    const result = repairMojibake([{ kind: "paragraph", text }]);

    expect(result.repaired).toBe(true);
    expect(result.blocks[0]?.text).toContain("He said “don’t pause—keep going…” Renée agreed.");
    expect(result.blocks[0]?.text).not.toContain("â€");
  });

  test("does not rewrite an isolated suspicious sequence", () => {
    const blocks = [{ kind: "paragraph" as const, text: "The literal label Ã© appears once." }];
    const result = repairMojibake(blocks);
    expect(result.repaired).toBe(false);
    expect(result.blocks).toBe(blocks);
  });
});
