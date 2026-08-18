/**
 * End-to-end TypingSession behaviour: correct/incorrect/backspace character
 * states, word commits, stopOnError modes, and extra characters. All driven
 * through real keydown events at the hidden input, never via private state.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TypingSession } from "../../src/engine/index";
import type { LessonAnchor } from "../../src/types";
import {
  getHiddenInput,
  makeBook,
  makeSettings,
  pressBackspace,
  pressChar,
  pressEnter,
  typeText,
} from "./helpers";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
});

function charSpan(container: HTMLElement, blockOrdinal: number, charIndex: number): HTMLSpanElement {
  const blockEl = container.querySelectorAll<HTMLDivElement>(".scr-block")[blockOrdinal]!;
  return blockEl.querySelectorAll<HTMLSpanElement>(".scr-char")[charIndex]!;
}

function dispatchBeforeInput(
  input: HTMLInputElement,
  inputType: string,
  data: string | null = null,
  isComposing = false,
): InputEvent {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
    isComposing,
  });
  input.dispatchEvent(event);
  return event;
}

function dispatchInput(
  input: HTMLInputElement,
  inputType: string,
  value: string,
  data: string | null = null,
  isComposing = false,
): void {
  input.value = value;
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType,
      data,
      isComposing,
    }),
  );
}

function pressModifiedBackspace(
  input: HTMLInputElement,
  modifiers: Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "metaKey">,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Backspace",
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  input.dispatchEvent(event);
  return event;
}

describe("basic character states", () => {
  test("correct input produces 100% accuracy and advances position", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "hello world" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "hello");
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 5 });
    expect(session.getStats().accuracy).toBe(100);
    for (let i = 0; i < 5; i++) {
      expect(charSpan(container, 0, i).className).toContain("scr-char--correct");
    }
    session.destroy();
  });

  test("moves the caret through stable lesson nodes without scrolling", () => {
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]),
      container,
      settings: makeSettings({ caretStyle: "line" }),
    });
    session.start();
    const input = getHiddenInput(container);
    const viewport = container.querySelector<HTMLElement>(".scr-viewport")!;
    const textEl = container.querySelector<HTMLElement>(".scr-text")!;
    const lessonNode = textEl.firstElementChild;
    const chars = textEl.querySelectorAll<HTMLElement>(".scr-char");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 300,
      height: 100,
    } as DOMRect);
    [...chars].forEach((span, index) => {
      vi.spyOn(span, "getBoundingClientRect").mockReturnValue({
        left: index * 10,
        top: 0,
        width: 10,
        height: 20,
      } as DOMRect);
    });
    viewport.scrollTop = 13;
    session.applySettings(makeSettings({ caretStyle: "line" }));

    pressChar(input, "a");
    expect(container.querySelector<HTMLElement>(".scr-caret")?.style.transform).toBe(
      "translate(10px, 13px)",
    );
    expect(textEl.firstElementChild).toBe(lessonNode);
    expect(viewport.scrollTop).toBe(13);

    pressChar(input, "b");
    expect(container.querySelector<HTMLElement>(".scr-caret")?.style.transform).toBe(
      "translate(20px, 13px)",
    );
    expect(textEl.firstElementChild).toBe(lessonNode);
    expect(viewport.scrollTop).toBe(13);
    session.destroy();
  });

  test("wrong input marks the character incorrect and (by default) still advances", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ stopOnError: "off" }) });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "x"); // wrong, expected 'a'
    expect(charSpan(container, 0, 0).className).toContain("scr-char--incorrect");
    expect(session.getPosition().charIndex).toBe(1); // advanced despite being wrong
    expect(session.getStats().errors).toBe(1);
    expect(session.getStats().accuracy).toBeCloseTo((0 / 1) * 100, 5);

    session.destroy();
  });

  test("backspace after a mistake produces 'corrected' on retype", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "x"); // wrong -> incorrect, charIndex -> 1
    expect(session.getPosition().charIndex).toBe(1);
    pressBackspace(input); // -> pending, charIndex -> 0
    expect(session.getPosition().charIndex).toBe(0);
    expect(charSpan(container, 0, 0).className).toContain("scr-char--pending");
    pressChar(input, "a"); // correct this time
    expect(charSpan(container, 0, 0).className).toContain("scr-char--corrected");
    expect(session.getPosition().charIndex).toBe(1);

    session.destroy();
  });

  test("backspace with no prior mistake just clears back to pending (not 'corrected')", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a"); // correct
    pressBackspace(input);
    expect(charSpan(container, 0, 0).className).toContain("scr-char--pending");
    pressChar(input, "a");
    expect(charSpan(container, 0, 0).className).toContain("scr-char--correct");
    expect(charSpan(container, 0, 0).className).not.toContain("corrected");

    session.destroy();
  });
});

describe("software keyboard input", () => {
  test("beforeinput-only insertText and deleteContentBackward drive canonical typing", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    const insert = dispatchBeforeInput(input, "insertText", "ab");
    expect(insert.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(2);

    const deletion = dispatchBeforeInput(input, "deleteContentBackward");
    expect(deletion.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(1);

    dispatchBeforeInput(input, "insertText", "bc");
    expect(session.getPosition().charIndex).toBe(3);
    expect(session.getStats().accuracy).toBe(100);
    expect(input.value).toBe("?");
    session.destroy();
  });

  test("input-only value fallback handles multi-character text and backward deletion", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    // A real browser appends after the non-empty Safari deletion sentinel.
    dispatchInput(input, "insertText", "?ab");
    expect(session.getPosition().charIndex).toBe(2);
    expect(input.value).toBe("?");

    dispatchInput(input, "deleteContentBackward", "");
    expect(session.getPosition().charIndex).toBe(1);

    dispatchInput(input, "insertText", "bc");
    expect(session.getPosition().charIndex).toBe(3);
    expect(session.getStats().accuracy).toBe(100);
    expect(input.value).toBe("?");
    session.destroy();
  });

  test("composition updates and their final input pair do not duplicate compositionend", async () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "ab" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    dispatchBeforeInput(input, "insertText", "a", true);
    dispatchInput(input, "insertText", "a", "a", true);
    expect(session.getPosition().charIndex).toBe(0);

    const compositionEnd = new CompositionEvent("compositionend", { bubbles: true });
    // happy-dom's CompositionEvent constructor currently ignores `data`.
    Object.defineProperty(compositionEnd, "data", { value: "a" });
    input.dispatchEvent(compositionEnd);
    expect(session.getPosition().charIndex).toBe(1);
    dispatchBeforeInput(input, "insertText", "a");
    dispatchInput(input, "insertText", "a", "a");
    expect(session.getPosition().charIndex).toBe(1);
    expect(session.getStats().charsTyped).toBe(1);

    // Suppression is scoped to the composition's event turn, not the next
    // independent software-keyboard edit.
    await Promise.resolve();
    dispatchBeforeInput(input, "insertText", "b");
    expect(session.getPosition().charIndex).toBe(2);
    session.destroy();
  });

  test("keydown followed by beforeinput/input is handled only once and listeners tear down", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a");
    dispatchBeforeInput(input, "insertText", "a");
    dispatchInput(input, "insertText", "a", "a");
    expect(session.getPosition().charIndex).toBe(1);
    expect(session.getStats().charsTyped).toBe(1);

    session.destroy();
    dispatchInput(input, "insertText", "b");
    expect(session.getPosition().charIndex).toBe(1);
    expect(session.getStats().charsTyped).toBe(1);
  });

  test("native backward-delete intents edit words/lines once and forward intents are safe no-ops", async () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "one two three" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    dispatchBeforeInput(input, "insertText", "one two");
    expect(session.getPosition().charIndex).toBe(7);

    const wordDelete = dispatchBeforeInput(input, "deleteWordBackward");
    expect(wordDelete.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(4);
    // A browser may still emit input after a canceled beforeinput.
    dispatchInput(input, "deleteWordBackward", "");
    expect(session.getPosition().charIndex).toBe(4);

    await Promise.resolve();
    const lineDelete = dispatchBeforeInput(input, "deleteSoftLineBackward");
    expect(lineDelete.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(4);

    await Promise.resolve();
    dispatchInput(input, "deleteHardLineBackward", "");
    expect(session.getPosition().charIndex).toBe(4);

    await Promise.resolve();
    dispatchBeforeInput(input, "insertText", "two");
    await Promise.resolve();
    const forwardDelete = dispatchBeforeInput(input, "deleteWordForward");
    expect(forwardDelete.defaultPrevented).toBe(true);
    dispatchInput(input, "deleteContentForward", "");
    expect(session.getPosition().charIndex).toBe(7);
    expect(session.getStats().charsTyped).toBe(10);
    session.destroy();
  });

  test("modifier keydown followed by native delete events performs one word edit", () => {
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "one two three" }] }]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    typeText(input, "one two");

    pressModifiedBackspace(input, { altKey: true });
    expect(session.getPosition().charIndex).toBe(4);
    const beforeInput = dispatchBeforeInput(input, "deleteWordBackward");
    expect(beforeInput.defaultPrevented).toBe(true);
    dispatchInput(input, "deleteWordBackward", "");
    expect(session.getPosition().charIndex).toBe(4);
    session.destroy();
  });
});

describe("explicit block boundaries", () => {
  test("holds exact progress at the pilcrow until Enter and edits backward normally", () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "abc." }, { text: "def" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ caretStyle: "line" }),
      onProgress,
    });
    session.start();
    const input = getHiddenInput(container);
    const firstBlock = container.querySelectorAll(".scr-block")[0];

    typeText(input, "abc.");
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 4,
    });
    const marker = container.querySelector<HTMLSpanElement>(".scr-boundary")!;
    expect(marker.textContent).toBe("¶");
    expect(marker.classList).toContain("scr-boundary--pending");
    expect(marker.classList).not.toContain("scr-char");

    pressChar(input, " ");
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 4,
    });
    expect(session.getStats().errors).toBe(1);
    expect(marker.classList).toContain("scr-boundary--incorrect");

    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(4);
    expect(charSpan(container, 0, 3).textContent).toBe(".");
    expect(charSpan(container, 0, 3).classList).toContain("scr-char--correct");
    expect(marker.classList).toContain("scr-boundary--pending");

    vi.advanceTimersByTime(1_000);
    expect(onProgress).toHaveBeenLastCalledWith(
      { sectionIndex: 0, blockIndex: 0, charIndex: 4 },
      4,
    );

    const viewport = container.querySelector<HTMLElement>(".scr-viewport")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 300,
      height: 100,
    } as DOMRect);
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue({
      left: 40,
      top: 20,
      width: 10,
      height: 20,
    } as DOMRect);
    session.applySettings(makeSettings({ caretStyle: "line" }));
    expect(container.querySelector<HTMLElement>(".scr-caret")?.style.transform).toBe(
      "translate(40px, 20px)",
    );

    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    expect(marker.classList).toContain("scr-boundary--correct");
    expect(container.querySelectorAll(".scr-block")[0]).toBe(firstBlock);
    session.destroy();
  });

  test("accumulates short blocks until an Enter boundary reaches the lesson target", () => {
    vi.useFakeTimers();
    const lessons = vi.fn();
    const onBookComplete = vi.fn();
    const book = makeBook([
      {
        id: "ch1",
        blocks: [
          { text: "a".repeat(20) },
          { text: "b".repeat(20) },
          { text: "c".repeat(20) },
          { text: "d".repeat(20) },
          { text: "e".repeat(20) },
          { text: "tail" },
        ],
      },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onLessonComplete: lessons,
      onBookComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    for (let blockIndex = 0; blockIndex < 4; blockIndex++) {
      typeText(input, book.sections[0]!.blocks[blockIndex]!.text);
      pressEnter(input);
      expect(lessons).not.toHaveBeenCalled();
    }
    typeText(input, book.sections[0]!.blocks[4]!.text);
    pressEnter(input);

    expect(lessons).toHaveBeenCalledTimes(1);
    expect(lessons.mock.calls[0]?.[0]).toMatchObject({
      charsTyped: 105,
      errors: 0,
      accuracy: 100,
    });
    expect(lessons.mock.calls[0]?.[1]).toEqual({
      sectionIndex: 0,
      blockIndex: 5,
      charIndex: 0,
    });
    expect(session.getStats()).toMatchObject({ charsTyped: 0, elapsedMs: 0 });
    expect(container.querySelectorAll(".scr-block")).toHaveLength(1);
    expect(container.querySelector(".scr-block")?.textContent).toBe("tail");

    vi.advanceTimersByTime(20_000);
    expect(session.getStats()).toMatchObject({ charsTyped: 0, elapsedMs: 0 });
    pressChar(input, "t");
    vi.advanceTimersByTime(1_000);
    typeText(input, "ail");

    expect(lessons).toHaveBeenCalledTimes(2);
    expect(lessons.mock.calls[1]?.[0]).toMatchObject({
      charsTyped: 4,
      errors: 0,
      accuracy: 100,
      elapsedMs: 1_000,
    });
    expect(onBookComplete).toHaveBeenCalledTimes(1);
    expect(onBookComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      lessons.mock.invocationCallOrder[1]!,
    );
    session.destroy();
  });

  test.each([100, 150, 200])(
    "mounts no text beyond a %i-character lesson target",
    (lessonLength) => {
      const prefix = "a".repeat(lessonLength - 1);
      const lessonText = `${prefix} bb `;
      const session = new TypingSession({
        book: makeBook([
          {
            id: "ch1",
            blocks: [{ text: `${lessonText}${"x".repeat(30)} future lesson` }],
          },
        ]),
        container,
        settings: makeSettings({ lessonLength }),
      });
      session.start();

      const mountedChars = [...container.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join("");
      expect(mountedChars).toBe(lessonText);
      expect(container.querySelector(".scr-text")?.textContent).not.toContain(
        "future lesson",
      );
      expect(container.querySelector<HTMLElement>(".scr-viewport")?.scrollTop).toBe(0);
      session.destroy();
    },
  );

  test("waits past the fallback for a preferred source block end", () => {
    const first = `${"a".repeat(99)} b end. short`;
    const lessons = vi.fn();
    const session = new TypingSession({
      book: makeBook([
        { id: "ch1", blocks: [{ text: first }, { text: "next lesson" }] },
      ]),
      container,
      settings: makeSettings(),
      onLessonComplete: lessons,
    });
    session.start();
    const input = getHiddenInput(container);
    const originalBlock = container.querySelector(".scr-block");

    typeText(input, `${"a".repeat(99)} b `);
    expect(lessons).not.toHaveBeenCalled();
    expect(container.querySelector(".scr-block")).toBe(originalBlock);
    typeText(input, "end. short");
    expect(lessons).not.toHaveBeenCalled();
    pressEnter(input);

    expect(lessons).toHaveBeenCalledTimes(1);
    expect(lessons.mock.calls[0]?.[1]).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    expect(container.querySelector(".scr-text")?.textContent).toBe("next lesson");
    session.destroy();
  });

  test("uses a preferred sentence boundary and never mounts the overshoot word", () => {
    const fallback = `${"a".repeat(99)} b `;
    const sentenceTail = "end. ";
    const future = `${"x".repeat(30)} future`;
    const lessons = vi.fn();
    const session = new TypingSession({
      book: makeBook([
        { id: "ch1", blocks: [{ text: `${fallback}${sentenceTail}${future}` }] },
      ]),
      container,
      settings: makeSettings(),
      onLessonComplete: lessons,
    });
    session.start();
    const input = getHiddenInput(container);

    expect(container.querySelector(".scr-text")?.textContent).toBe(
      `${fallback}${sentenceTail}`,
    );
    typeText(input, fallback);
    expect(lessons).not.toHaveBeenCalled();
    typeText(input, sentenceTail);

    expect(lessons).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".scr-text")?.textContent).toBe(future);
    session.destroy();
  });

  test("mounts and completes a whole over-target verse line", () => {
    const verse = Array.from({ length: 26 }, () => "word").join(" ");
    const lessons = vi.fn();
    const session = new TypingSession({
      book: makeBook([
        {
          id: "poem",
          blocks: [
            { text: verse, kind: "verse" },
            { text: "after", kind: "paragraph" },
          ],
        },
      ]),
      container,
      settings: makeSettings(),
      onLessonComplete: lessons,
    });
    session.start();
    const input = getHiddenInput(container);

    expect(container.querySelector(".scr-text")?.textContent).toBe(`${verse}¶`);
    expect(container.querySelector(".scr-text")?.textContent).not.toContain("after");
    typeText(input, verse);
    expect(lessons).not.toHaveBeenCalled();
    pressEnter(input);

    expect(lessons).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".scr-text")?.textContent).toBe("after");
    session.destroy();
  });

  test("carries an over-target starting heading into the first prose word", () => {
    const heading = "H".repeat(120);
    const session = new TypingSession({
      book: makeBook([
        {
          id: "chapter",
          blocks: [
            { text: heading, kind: "heading" },
            { text: "Opening prose continues", kind: "paragraph" },
          ],
        },
      ]),
      container,
      settings: makeSettings(),
    });
    session.start();

    expect(container.querySelectorAll(".scr-block")).toHaveLength(2);
    expect(container.querySelector(".scr-text")?.textContent).toBe(
      `${heading}¶Opening `,
    );
    expect(container.querySelector(".scr-text")?.textContent).not.toContain(
      "prose continues",
    );
    session.destroy();
  });

  test("freezes an active bound and applies a changed target at the next handoff", () => {
    const firstLesson = `${"a".repeat(99)} bb `;
    const secondLesson = `${"c".repeat(199)} dd `;
    const finalRemainder = `${"z".repeat(30)} tail`;
    const lessons = vi.fn();
    const session = new TypingSession({
      book: makeBook([
        {
          id: "ch1",
          blocks: [{ text: `${firstLesson}${secondLesson}${finalRemainder}` }],
        },
      ]),
      container,
      settings: makeSettings({ lessonLength: 100 }),
      onLessonComplete: lessons,
    });
    session.start();
    const input = getHiddenInput(container);
    const textEl = container.querySelector<HTMLElement>(".scr-text")!;
    const originalNode = textEl.firstElementChild;

    typeText(input, firstLesson.slice(0, 10));
    session.applySettings(makeSettings({ lessonLength: 200 }));
    expect(textEl.textContent).toBe(firstLesson);
    expect(textEl.firstElementChild).toBe(originalNode);
    expect(session.getStats().charsTyped).toBe(10);

    typeText(input, firstLesson.slice(10));
    expect(lessons).toHaveBeenCalledTimes(1);
    expect(lessons.mock.calls[0]?.[0].charsTyped).toBe(firstLesson.length);
    expect(textEl.textContent).toBe(secondLesson);
    expect(session.getStats()).toMatchObject({ charsTyped: 0, elapsedMs: 0 });
    session.destroy();
  });

  test("checkpoints long prose after the first post-target space and mounts zeroed next text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstWord = "a".repeat(99);
    const remainder = "z".repeat(30);
    const text = `${firstWord} bb ${remainder}`;
    const completed: Array<{
      stats: ReturnType<TypingSession["getStats"]>;
      position: ReturnType<TypingSession["getPosition"]>;
      liveStats: ReturnType<TypingSession["getStats"]>;
      mountedText: string;
      frozen: boolean;
    }> = [];
    const eventOrder: string[] = [];
    const onBookComplete = vi.fn(() => eventOrder.push("book"));
    let session!: TypingSession;
    session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text }] }]),
      container,
      settings: makeSettings(),
      onLessonComplete: (stats, position) => {
        eventOrder.push("lesson");
        completed.push({
          stats,
          position,
          liveStats: session.getStats(),
          mountedText: [...container.querySelectorAll<HTMLElement>(".scr-char")]
            .map((span) => span.textContent)
            .join(""),
          frozen: Object.isFrozen(stats),
        });
      },
      onBookComplete,
    });
    session.start();
    const input = getHiddenInput(container);
    const textEl = container.querySelector<HTMLElement>(".scr-text")!;
    const oldLessonNodes = [...textEl.children];
    const firstCanonicalSpan = textEl.querySelector(".scr-char");
    const viewport = container.querySelector<HTMLElement>(".scr-viewport")!;
    viewport.scrollTop = 37;

    expect(
      [...textEl.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe(`${firstWord} bb `);
    expect(textEl.textContent).not.toContain("tail");

    typeText(input, firstWord);
    pressChar(input, " ");
    expect(completed).toHaveLength(0); // 99 non-space chars is still short.
    expect(textEl.querySelector(".scr-char")).toBe(firstCanonicalSpan);
    expect(viewport.scrollTop).toBe(37);

    pressChar(input, "x"); // wrong first b, then correct it.
    pressBackspace(input);
    pressChar(input, "b");
    pressChar(input, "b");
    vi.advanceTimersByTime(1_000);
    pressChar(input, " ");

    expect(completed).toHaveLength(1);
    expect(oldLessonNodes.every((node) => !node.isConnected)).toBe(true);
    expect(viewport.scrollTop).toBe(0);
    expect(completed[0]).toMatchObject({
      stats: { charsTyped: 104, errors: 1, elapsedMs: 1_000 },
      position: { sectionIndex: 0, blockIndex: 0, charIndex: 103 },
      liveStats: { charsTyped: 0, errors: 0, elapsedMs: 0 },
      mountedText: remainder,
      frozen: true,
    });

    // The emitted lesson is an exact floor even though its final word has
    // permanent error history that would normally allow cross-word deletion.
    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(103);
    expect(session.getStats().charsTyped).toBe(0);

    typeText(input, remainder);
    expect(completed).toHaveLength(2);
    expect(completed[1]?.stats).toMatchObject({ charsTyped: 30, errors: 0 });
    expect(onBookComplete).toHaveBeenCalledTimes(1);
    expect(eventOrder).toEqual(["lesson", "lesson", "book"]);
    // The previous immutable snapshot is not changed by the next lesson.
    expect(completed[0]?.stats).toMatchObject({ charsTyped: 104, errors: 1 });
    session.destroy();
  });

  test.each(["off", "letter", "word"] as const)(
    "'%s' mode never deadlocks Enter behind invisible boundary errors",
    (stopOnError) => {
      const book = makeBook([
        { id: "ch1", blocks: [{ text: "Apollo" }, { text: "returns" }] },
      ]);
      const session = new TypingSession({
        book,
        container,
        settings: makeSettings({ stopOnError }),
      });
      session.start();
      const input = getHiddenInput(container);

      typeText(input, "Apollo");
      pressChar(input, " ");
      pressChar(input, "x");
      const marker = container.querySelector<HTMLSpanElement>(".scr-boundary")!;
      expect(marker.classList).toContain("scr-boundary--incorrect");
      expect(session.getStats().errors).toBe(2);

      // A correct Enter fixes its own dedicated target in every error mode.
      // The permanent errors remain in stats, while the non-canonical marker
      // state is cleared. Word-stop only gates on the canonical final word.
      pressEnter(input);
      expect(session.getPosition()).toEqual({
        sectionIndex: 0,
        blockIndex: 1,
        charIndex: 0,
      });
      expect(marker.classList).toContain("scr-boundary--correct");
      expect(session.getStats()).toMatchObject({ charsTyped: 9, errors: 2 });
      session.destroy();
    },
  );

  test("word mode offers one optional Backspace for repeated pilcrow errors across pause", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "Apollo" }, { text: "returns" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ stopOnError: "word" }),
    });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "Apollo");
    pressChar(input, " ");
    pressChar(input, "x");
    const marker = container.querySelector<HTMLSpanElement>(".scr-boundary")!;
    expect(marker.classList).toContain("scr-boundary--incorrect");

    session.pause();
    session.resume();

    // The pilcrow renders one red correction target, so one Backspace clears
    // it without deleting the final canonical character, even after multiple
    // wrong printable keys and a pause/resume cycle.
    pressBackspace(input);
    expect(marker.classList).toContain("scr-boundary--pending");
    expect(session.getPosition().charIndex).toBe(6);
    expect(charSpan(container, 0, 5).classList).toContain("scr-char--correct");

    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    expect(session.getStats().errors).toBe(2);
    session.destroy();
  });

  test("word mode blocks only on a wrong canonical final word, not the red pilcrow", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "Apollo" }, { text: "returns" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ stopOnError: "word" }),
    });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "Apollx");
    pressChar(input, " ");
    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 6,
    });
    const marker = container.querySelector<HTMLSpanElement>(".scr-boundary")!;
    expect(marker.classList).toContain("scr-boundary--incorrect");
    expect(marker.getAttribute("aria-label")).toBe(
      "Correct the final word, then press Enter",
    );

    // Clearing the boundary marker never deletes canonical text. Correcting
    // the final word is the only semantic prerequisite for the next Enter.
    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(6);
    expect(marker.classList).toContain("scr-boundary--incorrect");
    expect(marker.getAttribute("aria-label")).toBe(
      "Correct the final word, then press Enter",
    );
    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(5);
    pressChar(input, "o");
    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    session.destroy();
  });

  test("restart and exact passage remount discard transient pilcrow errors", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "Apollo" }, { text: "returns" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ stopOnError: "word" }),
    });
    session.start();
    const input = getHiddenInput(container);
    const anchor = session.getLessonAnchor();

    typeText(input, "Apollo");
    pressChar(input, " ");
    expect(container.querySelector(".scr-boundary--incorrect")).not.toBeNull();

    session.restartLesson();
    expect(session.getPosition()).toEqual(anchor.start);
    expect(container.querySelector(".scr-boundary--incorrect")).toBeNull();

    typeText(input, "Apollo");
    pressChar(input, "x");
    expect(container.querySelector(".scr-boundary--incorrect")).not.toBeNull();

    // Passage navigation may remount the same frozen lesson at its exact
    // canonical cursor. Boundary mistakes are transient and must not leak
    // into that fresh attempt.
    session.mountLesson(anchor, {
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 6,
    });
    expect(container.querySelector(".scr-boundary--incorrect")).toBeNull();
    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    session.destroy();
  });

  test("jumpTo clears transient boundary extras and re-renders the marker pending", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "a" }, { text: "b" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a");
    pressChar(input, "x");
    expect(container.querySelector(".scr-boundary")?.classList).toContain(
      "scr-boundary--incorrect",
    );

    session.jumpTo({ sectionIndex: 0, blockIndex: 0, charIndex: 1 });
    expect(container.querySelector(".scr-boundary")?.classList).toContain(
      "scr-boundary--pending",
    );
    pressEnter(getHiddenInput(container));
    expect(session.getPosition().blockIndex).toBe(1);
    session.destroy();
  });

  test("one finite lesson can cross blocks and sections without mounting the next lesson", () => {
    const first = "a".repeat(60);
    const second = "b".repeat(45);
    const book = makeBook([
      { id: "one", blocks: [{ text: first }, { text: second }] },
      { id: "two", blocks: [{ text: "remainder" }] },
    ]);
    const lessons = vi.fn();
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onLessonComplete: lessons,
    });
    session.start();
    const input = getHiddenInput(container);

    expect(container.querySelectorAll(".scr-block")).toHaveLength(2);
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(2);
    expect(container.querySelector(".scr-text")?.textContent).not.toContain(
      "remainder",
    );

    typeText(input, first);
    pressEnter(input);
    typeText(input, second);
    pressEnter(input);

    expect(lessons).toHaveBeenCalledTimes(1);
    expect(lessons.mock.calls[0]?.[1]).toEqual({
      sectionIndex: 1,
      blockIndex: 0,
      charIndex: 0,
    });
    expect(container.querySelectorAll(".scr-block")).toHaveLength(1);
    expect(container.querySelector(".scr-text")?.textContent).toBe("remainder");
    session.destroy();
  });

  test("accepts software-keyboard paragraph and line-break events exactly once", () => {
    const onBookComplete = vi.fn();
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "a" }, { text: "b" }, { text: "c" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onBookComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    dispatchBeforeInput(input, "insertText", "a");
    const paragraph = dispatchBeforeInput(input, "insertParagraph");
    expect(paragraph.defaultPrevented).toBe(true);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });

    dispatchBeforeInput(input, "insertText", "b");
    const lineBreak = dispatchBeforeInput(input, "insertLineBreak");
    expect(lineBreak.defaultPrevented).toBe(true);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 2,
      charIndex: 0,
    });

    dispatchBeforeInput(input, "insertText", "c");
    expect(onBookComplete).toHaveBeenCalledTimes(1);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 2,
      charIndex: 1,
    });
    // Final completion mounts the terminal lesson suffix before callbacks;
    // completed prior blocks and their boundaries are no longer in the DOM.
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(0);
    expect(container.querySelectorAll(".scr-line-break")).toHaveLength(0);
    session.destroy();
  });

  test("input-only line-break fallback advances, while the final block needs no Enter", () => {
    const onBookComplete = vi.fn();
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "a" }, { text: "b" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onBookComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    dispatchInput(input, "insertText", "a");
    dispatchInput(input, "insertLineBreak", "\n");
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    dispatchInput(input, "insertText", "b");
    expect(onBookComplete).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(0);
    session.destroy();
  });
});

describe("stopOnError behaviour", () => {
  test("'letter' mode refuses to advance past a wrong character", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ stopOnError: "letter" }) });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "x"); // wrong, refused
    expect(session.getPosition().charIndex).toBe(0);
    expect(session.getStats().errors).toBe(1); // still logged as a mistake
    pressChar(input, "a"); // now correct
    expect(session.getPosition().charIndex).toBe(1);

    session.destroy();
  });

  test("'word' mode allows wrong letters but blocks the space commit until fixed", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ stopOnError: "word" }) });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "c");
    pressChar(input, "x"); // wrong letter, allowed
    pressChar(input, "t");
    expect(session.getPosition().charIndex).toBe(3); // sitting at the space

    pressChar(input, " "); // blocked: word "cat" (typed "cxt") has an error
    expect(session.getPosition().charIndex).toBe(3);
    expect(session.getStats().errors).toBe(2); // wrong x + blocked commit

    pressBackspace(input); // remove the trailing 't'
    pressBackspace(input); // reach the wrong 'x'
    pressChar(input, "a"); // fix it
    pressChar(input, "t"); // restore the trailing character
    expect(session.getPosition().charIndex).toBe(3);
    pressChar(input, " "); // now the word is correct, space commits
    expect(session.getPosition().charIndex).toBe(4);

    session.destroy();
  });

  test("'off' mode (default) lets errors accumulate without blocking anything", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ stopOnError: "off" }) });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "xax "); // all wrong except the final space matches
    expect(session.getPosition().charIndex).toBe(4);

    session.destroy();
  });

  test("legacy onBlockComplete fallback receives the final lesson after word correction", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat" }] }]);
    let completed = 0;
    const onBlockComplete = vi.fn();
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ stopOnError: "word" }),
      onBookComplete: () => completed++,
      onBlockComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "cax");
    expect(session.getPosition().charIndex).toBe(3);
    expect(completed).toBe(0);

    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(2);
    pressChar(input, "t");
    expect(completed).toBe(1);
    expect(onBlockComplete.mock.calls[0]?.[0].errors).toBe(1);
    expect(session.getStats().errors).toBe(0);

    session.destroy();
  });
});

describe("extra characters", () => {
  test("typing past the end of a word appends extras marked incorrect, removable by backspace", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "cat"); // exact word
    expect(session.getPosition().charIndex).toBe(3); // sitting at the space

    pressChar(input, "s"); // extra: word is already "done" at index 3
    pressChar(input, "!"); // another extra
    // position must NOT advance for extras - they don't exist in Block.text
    expect(session.getPosition().charIndex).toBe(3);
    expect(session.getStats().errors).toBe(2);

    const extrasEl = container.querySelector<HTMLSpanElement>(".scr-extras");
    expect(extrasEl?.textContent).toBe("s!");

    pressBackspace(input); // removes '!'
    expect(container.querySelector<HTMLSpanElement>(".scr-extras")?.textContent).toBe("s");
    pressBackspace(input); // removes 's'
    expect(container.querySelector<HTMLSpanElement>(".scr-extras")?.textContent).toBe("");

    // now a normal backspace should step into the real word, not extras
    pressBackspace(input);
    expect(session.getPosition().charIndex).toBe(2);

    session.destroy();
  });

  test("'letter' mode refuses extra characters entirely", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ stopOnError: "letter" }) });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "cat");
    pressChar(input, "s"); // refused
    expect(session.getStats().errors).toBe(1);
    expect(container.querySelector<HTMLSpanElement>(".scr-extras")?.textContent).toBe("");
    expect(session.getPosition().charIndex).toBe(3);

    session.destroy();
  });

  test("a removed extra remains permanent error history after ordinary traversal", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "cat");
    pressChar(input, "s");
    pressBackspace(input); // current word is fixed, history remains
    pressChar(input, " ");
    pressChar(input, "d");
    pressBackspace(input); // back to start of dog
    pressBackspace(input); // ordinary Backspace traverses the word boundary
    expect(session.getPosition().charIndex).toBe(2);

    session.destroy();
  });
});

describe("backspace across word/block boundaries", () => {
  test("ordinary Backspace traverses a correct committed word", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    typeText(input, "cat "); // perfect word + space commit
    expect(session.getPosition().charIndex).toBe(4);
    pressChar(input, "d");
    expect(session.getPosition().charIndex).toBe(5);

    pressBackspace(input); // undo 'd' -> charIndex 4
    expect(session.getPosition().charIndex).toBe(4);
    pressBackspace(input); // crosses the delimiter and removes the prior word's final char
    expect(session.getPosition().charIndex).toBe(2);

    session.destroy();
  });

  test("ordinary Backspace traverses a correct source-block boundary", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "cat" }, { text: "dog" }] },
    ]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "c");
    pressChar(input, "a");
    pressChar(input, "t");
    // The block remains at its explicit boundary until Enter commits it.
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 3 });
    pressEnter(input);
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });

    pressBackspace(input); // explicit Enter boundary is editable inside the lesson
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 2 });

    session.destroy();
  });

  test.each([
    ["Option", { altKey: true }],
    ["Control", { ctrlKey: true }],
  ] as const)("%s+Backspace deletes to prior word starts", (_label, modifiers) => {
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "one two three" }] }]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    typeText(input, "one two");
    const charsTyped = session.getStats().charsTyped;

    const first = pressModifiedBackspace(input, modifiers);
    expect(first.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(4);

    const second = pressModifiedBackspace(input, modifiers);
    expect(second.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(0);
    expect(session.getStats().charsTyped).toBe(charsTyped);
    session.destroy();
  });

  test("word deletion crosses a pilcrow while line-backward remains a safe no-op", () => {
    const session = new TypingSession({
      book: makeBook([
        { id: "ch1", blocks: [{ text: "one two" }, { text: "three four" }] },
      ]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    typeText(input, "one two");
    pressEnter(input);

    pressModifiedBackspace(input, { ctrlKey: true });
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 4,
    });

    typeText(input, "two");
    pressEnter(input);
    typeText(input, "three");
    pressModifiedBackspace(input, { metaKey: true });
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 5,
    });
    session.destroy();
  });

  test("modified deletion respects the exact finite-lesson floor and does not intercept Ctrl+W", () => {
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "one two three" }] }]),
      container,
      settings: makeSettings(),
      startAt: { sectionIndex: 0, blockIndex: 0, charIndex: 6 },
    });
    session.start();
    const input = getHiddenInput(container);

    // Mid-word resume exposes the whole word as editable context, but never
    // allows either word- or line-delete to escape its rendered floor.
    pressModifiedBackspace(input, { altKey: true });
    expect(session.getPosition().charIndex).toBe(4);
    pressModifiedBackspace(input, { ctrlKey: true });
    expect(session.getPosition().charIndex).toBe(4);
    pressModifiedBackspace(input, { metaKey: true });
    expect(session.getPosition().charIndex).toBe(4);

    const ctrlW = new KeyboardEvent("keydown", {
      key: "w",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(ctrlW);
    expect(ctrlW.defaultPrevented).toBe(false);
    expect(session.getPosition().charIndex).toBe(4);

    const forward = new KeyboardEvent("keydown", {
      key: "Delete",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(session.getPosition().charIndex).toBe(4);
    session.destroy();
  });

  test("bulk word deletion clears a red pilcrow and the preceding word", () => {
    const session = new TypingSession({
      book: makeBook([
        { id: "ch1", blocks: [{ text: "Apollo" }, { text: "returns" }] },
      ]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    typeText(input, "Apollo");
    pressChar(input, " ");
    expect(container.querySelector(".scr-boundary--incorrect")).not.toBeNull();

    pressModifiedBackspace(input, { altKey: true });
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 0,
    });
    expect(container.querySelector(".scr-boundary--incorrect")).toBeNull();
    session.destroy();
  });
});

describe("position and settings", () => {
  test("focuses the typing input without moving the page", () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "one" }] }]),
      container,
      settings: makeSettings(),
    });

    session.start();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    session.destroy();
    focus.mockRestore();
  });

  test("keeps the current finite lesson mounted across source-block boundaries", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "one" }, { text: "two" }, { text: "three" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ contextLines: 0 }),
    });
    session.start();
    const firstBlock = container.querySelectorAll(".scr-block")[0];

    expect(container.querySelectorAll(".scr-block")).toHaveLength(3);
    typeText(getHiddenInput(container), "one");
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 3 });
    pressEnter(getHiddenInput(container));

    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });
    expect(container.querySelectorAll(".scr-block")[0]).toBe(firstBlock);
    session.destroy();
  });

  test("resume marks the completed prefix correct and word mode can commit at a delimiter", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "cat dog" }] }]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ stopOnError: "word" }),
      startAt: { sectionIndex: 0, blockIndex: 0, charIndex: 3 },
    });
    session.start();
    const input = getHiddenInput(container);

    for (let i = 0; i < 3; i++) {
      expect(charSpan(container, 0, i).className).toContain("scr-char--correct");
    }
    pressChar(input, " ");
    expect(session.getPosition().charIndex).toBe(4);

    session.destroy();
  });

  test("resume hides prior blocks but shows the active word prefix as completed context", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "first" }, { text: "second" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      startAt: { sectionIndex: 0, blockIndex: 1, charIndex: 2 },
    });

    session.start();
    const blocks = container.querySelectorAll<HTMLElement>(".scr-block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toBe("second");
    const chars = blocks[0]!.querySelectorAll(".scr-char");
    expect(chars[0]?.classList).toContain("scr-char--correct");
    expect(chars[1]?.classList).toContain("scr-char--correct");
    expect(chars[2]?.classList).toContain("scr-char--pending");
    session.destroy();
  });

  test("resume at a pilcrow shows an editable final-word context", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "first word" }, { text: "next" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      startAt: { sectionIndex: 0, blockIndex: 0, charIndex: 10 },
    });

    session.start();
    const input = getHiddenInput(container);
    const firstBlock = container.querySelector<HTMLElement>(".scr-block")!;
    expect(
      [...firstBlock.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("word");
    expect(
      [...firstBlock.querySelectorAll(".scr-char")].every((span) =>
        span.classList.contains("scr-char--correct"),
      ),
    ).toBe(true);
    expect(firstBlock.querySelector(".scr-boundary")?.textContent).toBe("¶");

    pressBackspace(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 9,
    });
    expect(firstBlock.querySelector(".scr-boundary")?.textContent).toBe("¶");
    session.destroy();
  });

  test("resume mid-word can edit to the rendered word start but no farther", () => {
    const beforeCheckpoint = `hello ${"a".repeat(97)} `;
    const checkpointTail = "b ";
    const future = "x".repeat(30);
    const onLessonComplete = vi.fn();
    const session = new TypingSession({
      book: makeBook([
        {
          id: "ch1",
          blocks: [{ text: `${beforeCheckpoint}${checkpointTail}${future}` }],
        },
      ]),
      container,
      settings: makeSettings(),
      startAt: { sectionIndex: 0, blockIndex: 0, charIndex: 3 },
      onLessonComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    pressBackspace(input);
    pressBackspace(input);
    pressBackspace(input);
    pressBackspace(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 0,
    });

    typeText(input, beforeCheckpoint);
    expect(session.getPosition().charIndex).toBe(beforeCheckpoint.length);
    expect(onLessonComplete).not.toHaveBeenCalled();
    typeText(input, checkpointTail);
    expect(onLessonComplete).toHaveBeenCalledTimes(1);
    expect(onLessonComplete.mock.calls[0]?.[1]).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: beforeCheckpoint.length + checkpointTail.length,
    });
    expect(container.querySelector(".scr-text")?.textContent).toBe(future);
    session.destroy();
  });

  test("jumpTo moves position and re-renders", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "first block" }, { text: "second block" }] },
    ]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();

    session.jumpTo({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });

    const input = getHiddenInput(container);
    typeText(input, "second");
    expect(session.getPosition().charIndex).toBe(6);

    session.destroy();
  });

  test("applySettings updates caret style without clipping the finite lesson", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "hello" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings({ caretStyle: "line" }) });
    session.start();

    session.applySettings(makeSettings({ caretStyle: "block", contextLines: 8 }));
    const caretEl = container.querySelector(".scr-caret");
    expect(caretEl?.className).toContain("scr-caret--block");
    expect(
      container.querySelector<HTMLElement>(".scr-root")?.style.getPropertyValue(
        "--scr-viewport-height",
      ),
    ).toBe("");

    session.destroy();
  });
});

describe("lifecycle and traversal", () => {
  test("pause/resume restarts the clock without counting the paused gap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a");
    vi.advanceTimersByTime(100);
    session.pause();
    vi.advanceTimersByTime(1_000);
    session.resume();
    pressChar(input, "b");
    vi.advanceTimersByTime(100);

    expect(session.getStats().elapsedMs).toBe(200);
    session.destroy();
  });

  test("completion and destroy both freeze elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const completeBook = makeBook([{ id: "complete", blocks: [{ text: "ab" }] }]);
    const completed = new TypingSession({
      book: completeBook,
      container,
      settings: makeSettings(),
    });
    completed.start();
    const firstInput = getHiddenInput(container);
    pressChar(firstInput, "a");
    vi.advanceTimersByTime(250);
    pressChar(firstInput, "b");
    const completionElapsed = completed.getStats().elapsedMs;
    vi.advanceTimersByTime(5_000);
    expect(completed.getStats().elapsedMs).toBe(completionElapsed);
    completed.destroy();

    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const destroyBook = makeBook([{ id: "destroy", blocks: [{ text: "abc" }] }]);
    const destroyed = new TypingSession({
      book: destroyBook,
      container: secondContainer,
      settings: makeSettings(),
    });
    destroyed.start();
    pressChar(getHiddenInput(secondContainer), "a");
    vi.advanceTimersByTime(125);
    destroyed.destroy();
    const destroyElapsed = destroyed.getStats().elapsedMs;
    vi.advanceTimersByTime(5_000);
    expect(destroyed.getStats().elapsedMs).toBe(destroyElapsed);
    secondContainer.remove();
  });

  test("destroy flushes pending debounced progress once", () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onProgress,
    });
    session.start();
    pressChar(getHiddenInput(container), "a");

    session.destroy();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(
      { sectionIndex: 0, blockIndex: 0, charIndex: 1 },
      1,
    );
    vi.runAllTimers();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  test("skips included empty sections at start and during rollover", () => {
    const book = makeBook([
      { id: "empty-start", blocks: [] },
      { id: "one", blocks: [{ text: "a" }] },
      { id: "empty-middle", blocks: [] },
      { id: "two", blocks: [{ text: "b" }] },
    ]);
    const completedSections: number[] = [];
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onSectionComplete: (index) => completedSections.push(index),
    });
    session.start();
    const input = getHiddenInput(container);

    expect(session.getPosition()).toEqual({ sectionIndex: 1, blockIndex: 0, charIndex: 0 });
    pressChar(input, "a");
    expect(session.getPosition()).toEqual({ sectionIndex: 1, blockIndex: 0, charIndex: 1 });
    pressEnter(input);
    expect(session.getPosition()).toEqual({ sectionIndex: 3, blockIndex: 0, charIndex: 0 });
    expect(completedSections).toEqual([1]);
    session.destroy();
  });

  test("all-excluded or empty books accept no typing", () => {
    const book = makeBook([
      { id: "excluded", included: false, blocks: [{ text: "secret" }] },
      { id: "empty", included: true, blocks: [] },
    ]);
    const onBookComplete = vi.fn();
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onBookComplete,
    });
    session.start();
    pressChar(getHiddenInput(container), "s");

    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(container.querySelectorAll(".scr-block")).toHaveLength(0);
    expect(session.getStats().charsTyped).toBe(0);
    expect(onBookComplete).not.toHaveBeenCalled();
    session.destroy();
  });

  test("caret follows typing focus without stealing interactive focus", () => {
    vi.useFakeTimers();
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);
    const caret = container.querySelector<HTMLElement>(".scr-caret")!;
    expect(document.activeElement).toBe(input);
    expect(caret.style.opacity).toBe("");
    expect(caret.style.visibility).toBe("");

    const button = document.createElement("button");
    container.appendChild(button);
    button.focus();
    button.click(); // the container's bubbling click handler must also abstain
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(button);
    expect(caret.style.opacity).toBe("0");
    expect(caret.style.visibility).toBe("hidden");

    input.focus();
    expect(caret.style.opacity).toBe("");
    session.pause();
    expect(caret.style.opacity).toBe("0");
    button.focus();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(button);
    expect(caret.style.opacity).toBe("0");

    session.resume();
    expect(document.activeElement).toBe(input);
    expect(caret.style.opacity).toBe("");

    button.remove();
    session.destroy();
  });

  test("non-interactive blur hides then restores the caret after automatic refocus", () => {
    vi.useFakeTimers();
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    const caret = container.querySelector<HTMLElement>(".scr-caret")!;

    input.dispatchEvent(
      new FocusEvent("blur", { relatedTarget: document.body }),
    );
    expect(caret.style.opacity).toBe("0");
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(input);
    expect(caret.style.opacity).toBe("");
    session.destroy();
  });

  test("null-relatedTarget blur respects a select that gains focus before fallback", () => {
    vi.useFakeTimers();
    const session = new TypingSession({
      book: makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const input = getHiddenInput(container);
    const caret = container.querySelector<HTMLElement>(".scr-caret")!;
    const select = document.createElement("select");
    const option = document.createElement("option");
    option.value = "100";
    option.textContent = "100";
    select.appendChild(option);
    container.appendChild(select);

    input.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    select.focus();
    expect(caret.style.opacity).toBe("0");
    vi.runOnlyPendingTimers();

    expect(document.activeElement).toBe(select);
    expect(caret.style.opacity).toBe("0");
    select.parentElement?.removeChild(select);
    session.destroy();
  });
});

describe("finite lesson navigation", () => {
  const longProse = Array.from({ length: 180 }, () => "word").join(" ");

  test("restart reuses the frozen anchor, discards score, and emits no callbacks", () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const onLessonComplete = vi.fn();
    const session = new TypingSession({
      book: makeBook([{ id: "one", blocks: [{ text: longProse }] }]),
      container,
      settings: makeSettings({ lessonLength: 100 }),
      onProgress,
      onLessonComplete,
    });
    session.start();
    const input = getHiddenInput(container);
    const anchor = session.getLessonAnchor();
    const text = container.querySelector(".scr-text")?.textContent;
    const defensive = session.getLessonAnchor();
    defensive.start.charIndex = defensive.end.charIndex;
    expect(session.getLessonAnchor()).toEqual(anchor);

    typeText(input, "word");
    session.applySettings(makeSettings({ lessonLength: 200 }));
    session.restartLesson();
    vi.runOnlyPendingTimers();

    expect(session.getPosition()).toEqual(anchor.start);
    expect(session.getLessonAnchor()).toEqual(anchor);
    expect(container.querySelector(".scr-text")?.textContent).toBe(text);
    expect(session.getStats()).toMatchObject({ charsTyped: 0, errors: 0, elapsedMs: 0 });
    expect(onProgress).not.toHaveBeenCalled();
    expect(onLessonComplete).not.toHaveBeenCalled();
    session.destroy();
  });

  test("restart does not steal focus back from an interactive control", () => {
    const session = new TypingSession({
      book: makeBook([{ id: "one", blocks: [{ text: longProse }] }]),
      container,
      settings: makeSettings(),
    });
    session.start();
    const button = document.createElement("button");
    container.appendChild(button);
    button.focus();

    session.restartLesson();

    expect(document.activeElement).toBe(button);
    expect(container.querySelector<HTMLElement>(".scr-caret")?.style.visibility).toBe(
      "hidden",
    );
    button.remove();
    session.destroy();
  });

  test("skip discards the current score and installs the next configured anchor", () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const onLessonComplete = vi.fn();
    const onBookComplete = vi.fn();
    const session = new TypingSession({
      book: makeBook([{ id: "one", blocks: [{ text: longProse }] }]),
      container,
      settings: makeSettings({ lessonLength: 100 }),
      onProgress,
      onLessonComplete,
      onBookComplete,
    });
    session.start();
    const skipped = session.getLessonAnchor();
    pressChar(getHiddenInput(container), "w");
    session.applySettings(makeSettings({ lessonLength: 200 }));

    const transition = session.skipLesson();
    vi.runOnlyPendingTimers();

    expect(transition).toEqual({
      skipped,
      next: session.getLessonAnchor(),
      bookComplete: false,
    });
    expect(session.getPosition()).toEqual(skipped.end);
    expect(session.getLessonAnchor().start).toEqual(skipped.end);
    expect(session.getLessonAnchor().targetNonSpaceChars).toBe(200);
    expect(session.getStats()).toMatchObject({ charsTyped: 0, errors: 0, elapsedMs: 0 });
    expect(onProgress).not.toHaveBeenCalled();
    expect(onLessonComplete).not.toHaveBeenCalled();
    expect(onBookComplete).not.toHaveBeenCalled();
    session.destroy();
  });

  test("final skip reaches terminal position without creating a result or completion callback", () => {
    const onLessonComplete = vi.fn();
    const onBookComplete = vi.fn();
    const session = new TypingSession({
      book: makeBook([{ id: "one", blocks: [{ text: "short" }] }]),
      container,
      settings: makeSettings(),
      onLessonComplete,
      onBookComplete,
    });
    session.start();
    pressChar(getHiddenInput(container), "s");
    const anchor = session.getLessonAnchor();

    expect(session.skipLesson()).toEqual({
      skipped: anchor,
      next: null,
      bookComplete: true,
    });
    expect(session.getPosition()).toEqual(anchor.end);
    expect(session.getStats().charsTyped).toBe(0);
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(0);
    expect(onLessonComplete).not.toHaveBeenCalled();
    expect(onBookComplete).not.toHaveBeenCalled();
    session.destroy();
  });

  test("mounts and completes an exact historical endpoint after settings change", () => {
    const onLessonComplete = vi.fn();
    const book = makeBook([
      { id: "one", blocks: [{ text: `alpha beta ${longProse}` }] },
    ]);
    const historical: LessonAnchor = {
      start: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      // Legacy progress could be an arbitrary mid-word cursor rather than a
      // modern semantic boundary. Exact mounted anchors still remain usable.
      end: { sectionIndex: 0, blockIndex: 0, charIndex: 3 },
      targetNonSpaceChars: 100,
      plannerVersion: 1,
    };
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings({ lessonLength: 200 }),
      onLessonComplete,
    });
    session.start();
    session.mountLesson(historical);

    expect(container.querySelector(".scr-text")?.textContent).toBe("alp");
    typeText(getHiddenInput(container), "alp");

    expect(onLessonComplete).toHaveBeenCalledTimes(1);
    expect(onLessonComplete.mock.calls[0]?.[2]).toEqual(historical);
    expect(session.getPosition()).toEqual(historical.end);
    expect(session.getLessonAnchor().targetNonSpaceChars).toBe(200);
    session.destroy();
  });

  test("rejects malformed anchors and cursors outside the frozen range", () => {
    const book = makeBook([{ id: "one", blocks: [{ text: longProse }] }]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
    });
    const anchor = session.getLessonAnchor();

    expect(() =>
      session.mountLesson({ ...anchor, start: anchor.end }),
    ).toThrow(RangeError);
    expect(() =>
      session.mountLesson(anchor, {
        ...anchor.end,
        charIndex: anchor.end.charIndex + 1,
      }),
    ).toThrow(RangeError);
    session.destroy();
  });
});
