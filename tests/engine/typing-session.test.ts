/**
 * End-to-end TypingSession behaviour: correct/incorrect/backspace character
 * states, word commits, stopOnError modes, and extra characters. All driven
 * through real keydown events at the hidden input, never via private state.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TypingSession } from "../../src/engine/index";
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
    expect(input.value).toBe("");
    session.destroy();
  });

  test("input-only value fallback handles multi-character text and backward deletion", () => {
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    dispatchInput(input, "insertText", "ab");
    expect(session.getPosition().charIndex).toBe(2);
    expect(input.value).toBe("");

    dispatchInput(input, "deleteContentBackward", "");
    expect(session.getPosition().charIndex).toBe(1);

    dispatchInput(input, "insertText", "bc");
    expect(session.getPosition().charIndex).toBe(3);
    expect(session.getStats().accuracy).toBe(100);
    expect(input.value).toBe("");
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

  test("scores each source block independently and excludes idle time at the next caret", () => {
    vi.useFakeTimers();
    const checkpoints = vi.fn();
    const onBookComplete = vi.fn();
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "ab" }, { text: "cd" }] },
    ]);
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onBlockComplete: checkpoints,
      onBookComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a");
    vi.advanceTimersByTime(1_000);
    pressChar(input, "b");
    vi.advanceTimersByTime(1_000);
    pressEnter(input);

    expect(checkpoints).toHaveBeenCalledTimes(1);
    expect(checkpoints.mock.calls[0]?.[0]).toMatchObject({
      charsTyped: 3,
      errors: 0,
      accuracy: 100,
      elapsedMs: 2_000,
    });
    expect(checkpoints.mock.calls[0]?.[1]).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 2,
    });
    expect(session.getStats()).toMatchObject({ charsTyped: 0, elapsedMs: 0 });

    vi.advanceTimersByTime(20_000);
    expect(session.getStats()).toMatchObject({ charsTyped: 0, elapsedMs: 0 });
    pressChar(input, "c");
    vi.advanceTimersByTime(1_000);
    pressChar(input, "d");

    expect(checkpoints).toHaveBeenCalledTimes(2);
    expect(checkpoints.mock.calls[1]?.[0]).toMatchObject({
      charsTyped: 2,
      errors: 0,
      accuracy: 100,
      elapsedMs: 1_000,
    });
    expect(onBookComplete).toHaveBeenCalledTimes(1);
    expect(onBookComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      checkpoints.mock.invocationCallOrder[1]!,
    );
    session.destroy();
  });

  test("requires one Backspace per wrong boundary key and blocks Enter until clear", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "a" }, { text: "b" }] },
    ]);
    const onBlockComplete = vi.fn();
    const session = new TypingSession({
      book,
      container,
      settings: makeSettings(),
      onBlockComplete,
    });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "a");
    pressChar(input, "x");
    pressChar(input, "y");
    const marker = container.querySelector<HTMLSpanElement>(".scr-boundary")!;
    expect(marker.classList).toContain("scr-boundary--incorrect");

    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 1,
    });

    pressBackspace(input);
    expect(marker.classList).toContain("scr-boundary--incorrect");
    expect(session.getPosition().charIndex).toBe(1);
    pressEnter(input);
    expect(session.getPosition().blockIndex).toBe(0);

    pressBackspace(input);
    expect(marker.classList).toContain("scr-boundary--pending");
    expect(session.getPosition().charIndex).toBe(1);
    expect(charSpan(container, 0, 0).classList).toContain("scr-char--correct");

    pressEnter(input);
    expect(session.getPosition()).toEqual({
      sectionIndex: 0,
      blockIndex: 1,
      charIndex: 0,
    });
    // The completed run preserves its permanent error history, while the
    // next block starts with fresh scoring counters.
    expect(onBlockComplete.mock.calls[0]?.[0].errors).toBe(4);
    expect(session.getStats().errors).toBe(0);
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
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(2);
    expect(container.querySelectorAll(".scr-line-break")).toHaveLength(2);
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
    expect(container.querySelectorAll(".scr-boundary")).toHaveLength(1);
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

  test("'word' mode gates a block's final word and completes only after correction", () => {
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

  test("a removed extra remains permanent error history for cross-word backspace", () => {
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
    pressBackspace(input); // allowed into cat because it once had an extra
    expect(session.getPosition().charIndex).toBe(2);

    session.destroy();
  });
});

describe("backspace across word/block boundaries", () => {
  test("cannot backspace into a committed word that had no error", () => {
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
    pressBackspace(input); // at word start of "dog", "cat" had no error -> gated no-op
    expect(session.getPosition().charIndex).toBe(4);

    session.destroy();
  });

  test("can backspace into a committed word that had an error, across a block boundary", () => {
    const book = makeBook([
      { id: "ch1", blocks: [{ text: "cat" }, { text: "dog" }] },
    ]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();
    const input = getHiddenInput(container);

    pressChar(input, "x"); // wrong 'c' -> incorrect
    pressChar(input, "a");
    pressChar(input, "t");
    // The block remains at its explicit boundary until Enter commits it.
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 3 });
    pressEnter(input);
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 1, charIndex: 0 });

    pressBackspace(input); // crosses back into block 0 since it had an error
    expect(session.getPosition()).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 2 });

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

  test("keeps a section mounted across source-block boundaries", () => {
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

  test("resume renders completed source blocks as completed context", () => {
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
    expect(
      [...blocks[0]!.querySelectorAll(".scr-char")].every((span) =>
        span.classList.contains("scr-char--correct")
      )
    ).toBe(true);
    expect(
      [...blocks[1]!.querySelectorAll(".scr-char")].slice(0, 2).every((span) =>
        span.classList.contains("scr-char--correct")
      )
    ).toBe(true);
    expect(blocks[1]!.querySelectorAll(".scr-char")[2]?.classList).toContain("scr-char--pending");
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

  test("applySettings updates caret style and visible viewport height", () => {
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
    ).toBe("12.8em");

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

  test("blur does not steal focus from interactive controls or while paused", () => {
    vi.useFakeTimers();
    const book = makeBook([{ id: "ch1", blocks: [{ text: "abc" }] }]);
    const session = new TypingSession({ book, container, settings: makeSettings() });
    session.start();

    const button = document.createElement("button");
    container.appendChild(button);
    button.focus();
    button.click(); // the container's bubbling click handler must also abstain
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(button);

    getHiddenInput(container).focus();
    session.pause();
    button.focus();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(button);

    button.remove();
    session.destroy();
  });
});
