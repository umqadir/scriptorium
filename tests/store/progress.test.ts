import { describe, expect, test } from "vitest";
import {
  accumulateLifetime,
  applyProgressUpdate,
  applySectionOverride,
  computeTotalChars,
  createInitialProgress,
  isSectionIncluded,
  resolveSections,
} from "../../src/store/progress";
import type { Section } from "../../src/types";

function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "sec-1",
    href: "sec-1.xhtml",
    title: "Chapter 1",
    order: 0,
    kind: "body",
    included: true,
    blocks: [],
    charCount: 1000,
    ...overrides,
  };
}

describe("createInitialProgress", () => {
  test("starts at position zero with zero progress", () => {
    const p = createInitialProgress("book-a", 5000);
    expect(p.bookId).toBe("book-a");
    expect(p.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(p.charsCompleted).toBe(0);
    expect(p.totalChars).toBe(5000);
    expect(p.bestWpm).toBe(0);
    expect(p.lifetime).toEqual({ charsTyped: 0, errors: 0, timeMs: 0, sessions: 0 });
    expect(p.sectionOverrides).toEqual({});
  });

  test("accepts pre-filled section overrides from the import flow", () => {
    const overrides = { intro: false, "book-1": true };
    const p = createInitialProgress("book-a", 5000, overrides);
    expect(p.sectionOverrides).toEqual(overrides);
  });
});

describe("applySectionOverride", () => {
  test("sets a new override without touching others", () => {
    const p = createInitialProgress("book-a", 100, { "sec-1": true });
    const updated = applySectionOverride(p, "sec-2", false);
    expect(updated.sectionOverrides).toEqual({ "sec-1": true, "sec-2": false });
  });

  test("flips an existing override", () => {
    const p = createInitialProgress("book-a", 100, { "sec-1": true });
    const updated = applySectionOverride(p, "sec-1", false);
    expect(updated.sectionOverrides).toEqual({ "sec-1": false });
  });

  test("clears an override when the choice is changed back to the section default", () => {
    const p = createInitialProgress("book-a", 100, { "sec-1": false, keep: true });
    const updated = applySectionOverride(p, "sec-1", true, true);
    expect(updated.sectionOverrides).toEqual({ keep: true });
    expect(p.sectionOverrides).toEqual({ "sec-1": false, keep: true });
  });

  test("can clear an include override when the section default is excluded", () => {
    const p = createInitialProgress("book-a", 100, { frontmatter: true });
    expect(applySectionOverride(p, "frontmatter", false, false).sectionOverrides).toEqual({});
  });

  test("persists across a simulated reload (round-trips as plain data)", () => {
    const p = createInitialProgress("book-a", 100, {});
    const updated = applySectionOverride(p, "glossary", false);
    const roundTripped = JSON.parse(JSON.stringify(updated));
    expect(roundTripped.sectionOverrides).toEqual({ glossary: false });
  });

  test("does not mutate the original progress object", () => {
    const p = createInitialProgress("book-a", 100, { "sec-1": true });
    const updated = applySectionOverride(p, "sec-1", false);
    expect(p.sectionOverrides).toEqual({ "sec-1": true });
    expect(updated).not.toBe(p);
  });

  test("bumps updatedAt", () => {
    const p = { ...createInitialProgress("book-a", 100), updatedAt: 0 };
    const updated = applySectionOverride(p, "sec-1", true);
    expect(updated.updatedAt).toBeGreaterThan(0);
  });
});

describe("applyProgressUpdate", () => {
  test("advances position and charsCompleted", () => {
    const p = createInitialProgress("book-a", 1000);
    const updated = applyProgressUpdate(p, {
      position: { sectionIndex: 1, blockIndex: 2, charIndex: 10 },
      charsCompleted: 250,
    });
    expect(updated.position).toEqual({ sectionIndex: 1, blockIndex: 2, charIndex: 10 });
    expect(updated.charsCompleted).toBe(250);
  });

  test("raises bestWpm but never lowers it", () => {
    const p = { ...createInitialProgress("book-a", 1000), bestWpm: 80 };
    const raised = applyProgressUpdate(p, {
      position: p.position,
      charsCompleted: 0,
      wpm: 120,
    });
    expect(raised.bestWpm).toBe(120);

    const notLowered = applyProgressUpdate(p, {
      position: p.position,
      charsCompleted: 0,
      wpm: 40,
    });
    expect(notLowered.bestWpm).toBe(80);
  });

  test("leaves bestWpm untouched when wpm is omitted", () => {
    const p = { ...createInitialProgress("book-a", 1000), bestWpm: 55 };
    const updated = applyProgressUpdate(p, { position: p.position, charsCompleted: 5 });
    expect(updated.bestWpm).toBe(55);
  });
});

describe("isSectionIncluded / resolveSections / computeTotalChars", () => {
  test("falls back to the section's parser-assigned default when there's no override", () => {
    const bodySec = section({ id: "s1", included: true });
    const frontSec = section({ id: "s2", included: false });
    expect(isSectionIncluded(bodySec, {})).toBe(true);
    expect(isSectionIncluded(frontSec, {})).toBe(false);
  });

  test("an explicit override wins over the parser default in either direction", () => {
    const bodySec = section({ id: "s1", included: true });
    const frontSec = section({ id: "s2", included: false });
    expect(isSectionIncluded(bodySec, { s1: false })).toBe(false); // user excluded a body chapter
    expect(isSectionIncluded(frontSec, { s2: true })).toBe(true); // user included the front matter
  });

  test("resolveSections applies overrides onto a fresh array without mutating the input", () => {
    const sections = [section({ id: "s1", included: true }), section({ id: "s2", included: false })];
    const resolved = resolveSections(sections, { s1: false, s2: true });
    expect(resolved.map((s) => s.included)).toEqual([false, true]);
    expect(sections.map((s) => s.included)).toEqual([true, false]); // original untouched
  });

  test("computeTotalChars sums only included sections' charCount", () => {
    const sections = [
      section({ id: "intro", included: false, charCount: 196_000 }), // excluded frontmatter
      section({ id: "ch1", included: true, charCount: 5_000 }),
      section({ id: "ch2", included: true, charCount: 6_000 }),
      section({ id: "glossary", included: false, charCount: 154_000 }), // excluded backmatter
    ];
    expect(computeTotalChars(sections, {})).toBe(11_000);
  });

  test("computeTotalChars respects overrides that flip a section either way", () => {
    const sections = [
      section({ id: "intro", included: false, charCount: 196_000 }),
      section({ id: "ch1", included: true, charCount: 5_000 }),
    ];
    // user decides to include the introduction after all, and skip chapter 1
    expect(computeTotalChars(sections, { intro: true, ch1: false })).toBe(196_000);
  });
});

describe("accumulateLifetime", () => {
  test("adds session stats onto existing lifetime totals and increments sessions", () => {
    const p = {
      ...createInitialProgress("book-a", 1000),
      lifetime: { charsTyped: 500, errors: 10, timeMs: 60_000, sessions: 3 },
    };
    const updated = accumulateLifetime(p, { charsTyped: 200, errors: 5, timeMs: 20_000 });
    expect(updated.lifetime).toEqual({
      charsTyped: 700,
      errors: 15,
      timeMs: 80_000,
      sessions: 4,
    });
  });
});
