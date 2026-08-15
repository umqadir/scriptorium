/**
 * The alignment regression test - the whole point of this app.
 *
 * Display and comparison must never drift apart. We build a book with
 * deliberately tricky content (apostrophes, quotes, hyphens, digits, a
 * single-character block, a very long block), type EVERY character of it
 * by reading Block.text directly and feeding those exact characters through
 * real keydown events, and assert the session ends with 100% accuracy, zero
 * errors, and a final position exactly at the end of the book.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TypingSession } from "../../src/engine/index";
import type { SessionStats } from "../../src/types";
import {
  getHiddenInput,
  makeBook,
  makeLongText,
  makeSettings,
  pressBackspace,
  pressChar,
  pressEnter,
  totalIncludedChars,
  typeText,
} from "./helpers";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe("alignment regression", () => {
  test("typing every character of tricky content yields 100% accuracy, zero errors, exact end position", () => {
    const longText = makeLongText(2000);
    expect(longText.length).toBe(2000);
    // sanity: fixture itself must be well-formed (no leading/trailing ws,
    // no double spaces) or this test would be testing the wrong thing.
    expect(longText.startsWith(" ")).toBe(false);
    expect(longText.endsWith(" ")).toBe(false);
    expect(longText.includes("  ")).toBe(false);

    const book = makeBook([
      {
        id: "ch1",
        kind: "body",
        blocks: [
          { text: "Chapter One: Beginnings", kind: "heading" },
          {
            text: "It's a \"test\" - now count: 123, 456.7, and done!",
            kind: "paragraph",
          },
          {
            text: "Well-known facts: don't stop; can't quit -- 42% sure.",
            kind: "paragraph",
          },
          { text: "A", kind: "paragraph" }, // single-character block
          {
            text: "\"Never,\" she said, \"not even once.\"",
            kind: "blockquote",
          },
          { text: longText, kind: "paragraph" }, // ~2000 char block
          { text: "The end - for now.", kind: "paragraph" },
        ],
      },
    ]);

    let sectionCompletions: number[] = [];
    let bookCompleted = 0;
    const lessonStats: SessionStats[] = [];

    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onSectionComplete: (i) => sectionCompletions.push(i),
      onLessonComplete: (stats) => lessonStats.push(stats),
      onBookComplete: () => {
        bookCompleted += 1;
      },
    });
    session.start();
    const input = getHiddenInput(container);

    const section = book.sections[0]!;
    for (const [index, block] of section.blocks.entries()) {
      typeText(input, block.text);
      if (index < section.blocks.length - 1) pressEnter(input);
    }

    const expectedLessons = expectedLessonCount(book);
    expect(expectedLessons).toBe(19);
    expect(lessonStats).toHaveLength(expectedLessons);
    expect(lessonStats.every((stats) => stats.accuracy === 100)).toBe(true);
    expect(lessonStats.reduce((sum, stats) => sum + stats.errors, 0)).toBe(0);
    expect(lessonStats.reduce((sum, stats) => sum + stats.charsTyped, 0)).toBe(
      totalIncludedChars(book) + section.blocks.length - 1,
    );

    const lastBlock = section.blocks[section.blocks.length - 1]!;
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: section.blocks.length - 1,
      charIndex: lastBlock.text.length,
    });

    expect(sectionCompletions).toEqual([0]);
    expect(bookCompleted).toBe(1);

    session.destroy();
  });

  test("every rendered span's textContent matches Block.text at the same index (no parallel string)", () => {
    const book = makeBook([
      {
        id: "ch1",
        blocks: [
          { text: "It's \"quoted\" - 100% real, right?" },
          { text: "Second paragraph here." },
        ],
      },
    ]);

    const session = new TypingSession({ book, container, settings: makeSettings({ contextLines: 5 }) });
    session.start();

    const block0 = book.sections[0]!.blocks[0]!;
    const block1 = book.sections[0]!.blocks[1]!;
    const blockEls = container.querySelectorAll<HTMLDivElement>(".scr-block");
    expect(blockEls.length).toBe(2);

    // Query only `.scr-char` spans (not the interspersed `.scr-extras`
    // containers) so DOM order maps 1:1 onto Block.text indices.
    const spans0 = blockEls[0]!.querySelectorAll<HTMLSpanElement>(".scr-char");
    const spans1 = blockEls[1]!.querySelectorAll<HTMLSpanElement>(".scr-char");
    expect(spans0.length).toBe(block0.text.length);
    expect(spans1.length).toBe(block1.text.length);

    for (let i = 0; i < block0.text.length; i++) {
      expect(spans0[i]?.textContent).toBe(block0.text[i]);
    }
    for (let i = 0; i < block1.text.length; i++) {
      expect(spans1[i]?.textContent).toBe(block1.text[i]);
    }

    session.destroy();
  });

  test("mixed correct/incorrect typing still keeps display and comparison aligned", () => {
    // Type the tricky block with a few deliberate mistakes mixed in, then
    // fix them, and confirm charsTyped/errors track keystrokes (not final
    // state) while the position still lands exactly at the end.
    const text = "Don't panic: it's fine -- 99% of the time!";
    const book = makeBook([{ id: "ch1", blocks: [{ text }] }]);
    let finalStats: SessionStats | undefined;
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onLessonComplete: (stats) => {
        finalStats = stats;
      },
    });
    session.start();
    const input = getHiddenInput(container);

    let mistakes = 0;
    for (let i = 0; i < text.length; i++) {
      const expected = text[i]!;
      if (i === 3 || i === 20) {
        // Type a wrong character (marks 'incorrect', advances past it),
        // then backspace (resets to 'pending', hadError permanently true)
        // before retyping correctly below - this should land as 'corrected'.
        const wrong = expected === "x" ? "y" : "x";
        pressChar(input, wrong);
        pressBackspace(input);
        mistakes += 1;
      }
      pressChar(input, expected);
    }

    const stats = finalStats!;
    // 2 wrong keystrokes + text.length correct keystrokes were made.
    expect(stats.charsTyped).toBe(text.length + mistakes);
    expect(stats.errors).toBe(mistakes);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: text.length,
    });

    session.destroy();
  });
});

function expectedLessonCount(book: ReturnType<typeof makeBook>): number {
  const blocks = book.sections
    .filter((section) => section.included)
    .flatMap((section) => section.blocks.filter((block) => block.text.length > 0));
  let lessons = 0;
  let nonSpaceChars = 0;
  let runKeys = 0;

  blocks.forEach((block, blockOrdinal) => {
    for (const char of block.text) {
      runKeys += 1;
      if (char !== " ") nonSpaceChars += 1;
      if (char === " " && nonSpaceChars >= 100) {
        lessons += 1;
        nonSpaceChars = 0;
        runKeys = 0;
      }
    }
    if (blockOrdinal < blocks.length - 1) {
      runKeys += 1; // The explicit Enter belongs to the completed lesson.
      if (nonSpaceChars >= 100) {
        lessons += 1;
        nonSpaceChars = 0;
        runKeys = 0;
      }
    }
  });

  return lessons + (runKeys > 0 ? 1 : 0);
}
