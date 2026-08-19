import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// The project intentionally omits Node typings; this test parses the real
// reader stylesheet because Vitest stubs CSS imports to an empty string.
// @ts-expect-error Node's runtime module is available to the Vitest process.
import { readFileSync } from "node:fs";
import {
  DEFAULT_SETTINGS,
  type BookProgress,
  type LessonNavigationState,
  type ParsedBook,
} from "../../src/types";
import { createInitialProgress } from "../../src/store/progress";
import { initAppState } from "../../src/ui/state";
import {
  isValidLessonAnchor,
  lessonCorpusSignature,
  makeLessonAnchor,
} from "../../src/engine";

const storage = vi.hoisted(() => ({
  getBook: vi.fn(),
  getProgress: vi.fn(),
  saveProgress: vi.fn(async () => undefined),
  saveSettings: vi.fn(async () => undefined),
  getLessonNavigation: vi.fn<() => Promise<LessonNavigationState | undefined>>(),
  saveReaderCheckpoint: vi.fn(
    async (_progress: BookProgress, _navigation?: LessonNavigationState) => undefined
  ),
}));

vi.mock("../../src/store/books", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/books")>()),
  getBook: storage.getBook,
}));

vi.mock("../../src/store/progress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/progress")>()),
  getProgress: storage.getProgress,
  saveProgress: storage.saveProgress,
}));

vi.mock("../../src/store/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/settings")>()),
  saveSettings: storage.saveSettings,
}));

vi.mock("../../src/store/lesson-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/lesson-navigation")>()),
  getLessonNavigation: storage.getLessonNavigation,
  saveReaderCheckpoint: storage.saveReaderCheckpoint,
}));

import { mountReader } from "../../src/ui/reader";

const readerCss = readFileSync("src/ui/reader.css", "utf8");

function book(text = "a", included = true): ParsedBook {
  return {
    meta: {
      id: "book-1",
      title: "Small Book",
      author: "An Author",
      language: "en",
      addedAt: 1,
    },
    sections: [
      {
        id: "chapter-1",
        href: "chapter.xhtml",
        title: "Chapter One",
        order: 0,
        kind: "body",
        included,
        blocks: text ? [{ kind: "paragraph", text }] : [],
        charCount: text.length,
      },
    ],
  };
}

function stored(parsed: ParsedBook) {
  return { ...parsed, raw: new Blob(["epub"]) };
}

function savedProgressSnapshots(): BookProgress[] {
  const direct = storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>;
  const checkpoints = storage.saveReaderCheckpoint.mock.calls;
  return [
    ...direct.map(([progress], index) => ({
      order: storage.saveProgress.mock.invocationCallOrder[index] ?? 0,
      progress,
    })),
    ...checkpoints.map(([progress], index) => ({
      order: storage.saveReaderCheckpoint.mock.invocationCallOrder[index] ?? 0,
      progress,
    })),
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ progress }) => progress);
}

function savedNavigationSnapshots(): Array<LessonNavigationState | undefined> {
  return storage.saveReaderCheckpoint.mock.calls.map(([, navigation]) => navigation);
}

describe("mountReader", () => {
  beforeEach(() => {
    storage.getBook.mockReset();
    storage.getProgress.mockReset();
    storage.saveProgress.mockReset();
    storage.saveProgress.mockResolvedValue(undefined);
    storage.saveSettings.mockReset();
    storage.saveSettings.mockResolvedValue(undefined);
    storage.getLessonNavigation.mockReset();
    storage.getLessonNavigation.mockResolvedValue(undefined);
    storage.saveReaderCheckpoint.mockReset();
    storage.saveReaderCheckpoint.mockResolvedValue(undefined);
    initAppState({ ...DEFAULT_SETTINGS, soundOnClick: false });
    location.hash = "#/reader/book-1";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("handles a missing local book without starting the engine", async () => {
    storage.getBook.mockResolvedValue(undefined);
    storage.getProgress.mockResolvedValue(undefined);
    const host = document.createElement("main");

    const handle = mountReader(host, "missing");
    await vi.waitFor(() => expect(host.textContent).toContain("Book not found"));

    expect(host.querySelector(".scr-hidden-input")).toBeNull();
    handle.unmount?.();
  });

  test("shows an actionable configuration state when no nonempty section is included", async () => {
    const parsed = book("", false);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 0));
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.textContent).toContain("No sections are included"));

    expect(host.textContent).toContain("choose sections");
    expect(host.querySelector(".scr-hidden-input")).toBeNull();
    expect(storage.saveReaderCheckpoint).not.toHaveBeenCalled();
    handle.unmount?.();
  });

  test("reseeds instead of mounting a stale frontier whose exclusive end is already persisted", async () => {
    const text = Array.from({ length: 70 }, (_, index) => `word${index}`).join(" ");
    const parsed = book(text);
    const staleFrontier = makeLessonAnchor(
      parsed,
      { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      100,
    );
    expect(staleFrontier.end.charIndex).toBeLessThan(text.length);
    const saved = {
      ...createInitialProgress("book-1", text.length),
      position: { ...staleFrontier.end },
      charsCompleted: staleFrontier.end.charIndex,
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(saved);
    storage.getLessonNavigation.mockResolvedValue({
      bookId: "book-1",
      corpusSignature: lessonCorpusSignature(parsed),
      history: [],
      frontier: staleFrontier,
    });
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());

    expect(host.querySelector(".scr-char")?.textContent).toBe(
      text[staleFrontier.end.charIndex],
    );
    await vi.waitFor(() => {
      const reseeded = savedNavigationSnapshots().at(-1);
      expect(reseeded?.frontier.start).toEqual(staleFrontier.end);
      expect(reseeded?.frontier.end).not.toEqual(staleFrontier.end);
    });
    handle.unmount?.();
  });

  test("normalizes a legacy mid-lesson bookmark to its stored anchor start", async () => {
    const text = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
    const parsed = book(text);
    const frontier = makeLessonAnchor(
      parsed,
      { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      100
    );
    const saved = {
      ...createInitialProgress("book-1", text.length),
      position: { sectionIndex: 0, blockIndex: 0, charIndex: 5 },
      charsCompleted: 5,
      lifetime: { charsTyped: 5, errors: 1, timeMs: 1_000, sessions: 1 },
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(saved);
    storage.getLessonNavigation.mockResolvedValue({
      bookId: "book-1",
      corpusSignature: lessonCorpusSignature(parsed),
      history: [],
      frontier,
    });
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());

    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[0]);
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(0);
    await vi.waitFor(() => {
      const snapshots = savedProgressSnapshots();
      expect(snapshots.at(-1)?.position).toEqual(frontier.start);
      expect(snapshots.at(-1)?.charsCompleted).toBe(0);
      expect(snapshots.at(-1)?.lifetime).toEqual(saved.lifetime);
    });
    handle.unmount?.();
  });

  test("invalidates cross-section anchors when the runtime inclusion corpus changes", async () => {
    const section = (id: string, text: string, order: number) => ({
      id,
      href: `${id}.xhtml`,
      title: id,
      order,
      kind: "body" as const,
      included: true,
      blocks: [{ kind: "paragraph" as const, text }],
      charCount: text.length,
    });
    const parsed: ParsedBook = {
      meta: {
        id: "book-1",
        title: "Corpus Book",
        author: "An Author",
        language: "en",
        addedAt: 1,
      },
      sections: [
        section("first", "alpha ".repeat(6), 0),
        section("middle", "middle-only ".repeat(3), 1),
        section("last", "omega ".repeat(30), 2),
      ],
    };
    const staleFrontier = makeLessonAnchor(
      parsed,
      { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      100,
    );
    const progress = createInitialProgress("book-1", 0, { middle: false });
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(progress);
    storage.getLessonNavigation.mockResolvedValue({
      bookId: "book-1",
      corpusSignature: lessonCorpusSignature(parsed),
      history: [],
      frontier: staleFrontier,
    });
    const currentRuntime = {
      ...parsed,
      sections: parsed.sections.map((item) =>
        item.id === "middle" ? { ...item, included: false } : item,
      ),
    };
    const expectedSignature = lessonCorpusSignature(currentRuntime);
    // Both endpoints remain canonical after excluding the interior section;
    // the corpus fingerprint is what invalidates this otherwise-valid range.
    expect(isValidLessonAnchor(currentRuntime, staleFrontier)).toBe(true);
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    await vi.waitFor(() => {
      expect(savedNavigationSnapshots().at(-1)?.corpusSignature).toBe(
        expectedSignature,
      );
    });
    expect(host.querySelector(".scr-text")?.textContent).not.toContain("middle-only");
    expect(expectedSignature).not.toBe(lessonCorpusSignature(parsed));
    handle.unmount?.();
  });

  test("uses one two-row reader grid without a progress bar", async () => {
    const parsed = book("ab");
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 2));
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());

    const shell = host.querySelector<HTMLElement>(".reader-shell")!;
    const workspace = shell.querySelector<HTMLElement>(".reader-workspace")!;
    expect([...shell.children].map((child) => child.className)).toEqual([
      "reader-chrome",
      "reader-workspace",
    ]);
    expect([...workspace.children].map((child) => child.className)).toEqual([
      "reader-stage-bar",
      "typing-container",
      "reader-hint",
      "visually-hidden reader-checkpoint-announcement",
    ]);
    expect(
      [...workspace.querySelector(".reader-stage-bar")!.children].map(
        (child) => child.className
      )
    ).toEqual(["reader-live-stats", "reader-lesson-nav"]);
    expect(
      [...workspace.querySelectorAll<HTMLButtonElement>(".reader-lesson-nav button")].map(
        (button) => button.getAttribute("aria-label")
      )
    ).toEqual([
      "Previous passage",
      "Restart passage",
      "Copy passage",
      "Skip passage",
    ]);
    expect(shell.querySelector('[role="progressbar"]')).toBeNull();
    expect(shell.querySelector(".reader-progress-bar")).toBeNull();

    const topbar = shell.querySelector<HTMLElement>(".reader-topbar")!;
    expect([...topbar.children].map((child) => child.className)).toEqual([
      "reader-topbar-leading",
      "reader-topbar-center",
      "reader-actions reader-topbar-trailing",
    ]);
    expect(shell.querySelector(".reader-line-count-select")).toBeNull();
    expect(shell.querySelector(".reader-lesson-size")).toBeNull();
    const lessonLength = shell.querySelector<HTMLSelectElement>(
      ".reader-lesson-length-select"
    )!;
    expect(lessonLength.getAttribute("aria-label")).toBe("Lesson length");
    expect([...lessonLength.options].map((option) => option.textContent)).toEqual([
      "100 chars",
      "125 chars",
      "150 chars",
      "175 chars",
      "200 chars",
    ]);
    expect(lessonLength.value).toBe("100");

    const input = shell.querySelector<HTMLElement>(".scr-hidden-input")!;
    const stats = workspace.querySelector<HTMLElement>(".reader-live-stats")!;
    const checkpointAnnouncement = workspace.querySelector<HTMLElement>(
      ".reader-checkpoint-announcement"
    )!;
    expect(stats.hasAttribute("aria-live")).toBe(false);
    expect(checkpointAnnouncement.getAttribute("aria-live")).toBe("polite");
    expect(checkpointAnnouncement.getAttribute("aria-atomic")).toBe("true");
    expect(readerCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.reader-live-stats-complete\s*{\s*animation:\s*none;/
    );
    expect(readerCss).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.reader-lesson-length-select\s*{[\s\S]*min-height:\s*2\.75rem;[\s\S]*\.reader-topbar \.icon-button,[\s\S]*\.reader-contents-control\s*{[\s\S]*min-height:\s*2\.75rem;/
    );
    const style = document.createElement("style");
    style.textContent = readerCss;
    document.head.appendChild(style);
    const gridRowFor = (selector: string): string => {
      const rule = [...(style.sheet?.cssRules ?? [])].find(
        (candidate) => (candidate as CSSStyleRule).selectorText === selector
      ) as CSSStyleRule | undefined;
      return rule?.style.getPropertyValue("grid-row") ?? "";
    };
    expect(stats.hidden).toBe(true);
    expect(gridRowFor(".reader-live-stats")).toBe("1");
    expect(gridRowFor(".typing-container")).toBe("2");
    expect(gridRowFor(".reader-hint")).toBe("3");
    const typingRowBeforeStats = gridRowFor(".typing-container");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await vi.waitFor(() => expect(stats.hidden).toBe(false));
    expect(gridRowFor(".typing-container")).toBe(typingRowBeforeStats);
    expect(shell.classList).toContain("reader-focused");
    expect(workspace.contains(shell.querySelector(".reader-live-stats"))).toBe(true);
    expect(shell.querySelector(".reader-live-stats")?.closest(".reader-chrome")).toBeNull();
    style.remove();
    handle.unmount?.();
  });

  test("copies canonical passage text at any typing state", async () => {
    const parsed = book("one two");
    parsed.sections[0]!.blocks = [
      { kind: "paragraph", text: "one two" },
      { kind: "paragraph", text: "three" },
    ];
    parsed.sections[0]!.charCount = 12;
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 12));
    const writeText = vi.fn(async (_text: string) => undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    const input = host.querySelector<HTMLInputElement>(".scr-hidden-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true }));
    host.querySelector<HTMLButtonElement>('[aria-label="Copy passage"]')!.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("one two\nthree"));
    expect(writeText).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.activeElement).toBe(input));

    handle.unmount?.();
    host.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("persists completion and accumulates lifetime exactly once across completion and unmount", async () => {
    const parsed = book("a");
    const initial = createInitialProgress("book-1", 1);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    const input = host.querySelector(".scr-hidden-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("book complete"));
    expect(host.querySelector(".reader-checkpoint-announcement")?.textContent).toContain(
      "Book complete."
    );
    handle.unmount?.();
    await vi.waitFor(() =>
      expect(
        savedProgressSnapshots().some((snapshot) => snapshot.lifetime.sessions === 1)
      ).toBe(true)
    );

    const snapshots = savedProgressSnapshots();
    const latest = snapshots.at(-1)!;
    expect(latest.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 1 });
    expect(latest.charsCompleted).toBe(1);
    expect(latest.lifetime.charsTyped).toBe(1);
    expect(latest.lifetime.sessions).toBe(1);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    const navigationSnapshots = savedNavigationSnapshots();
    expect(navigationSnapshots.at(-1)?.history).toEqual([]);
    expect(navigationSnapshots.at(-1)?.frontier).toMatchObject({
      start: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      end: { sectionIndex: 0, blockIndex: 0, charIndex: 1 },
    });
    const boundaryCheckpoint = [...storage.saveReaderCheckpoint.mock.calls]
      .reverse()
      .find(([snapshot]) => snapshot.position.charIndex === 1);
    expect(boundaryCheckpoint?.[0].lifetime.sessions).toBe(1);
    expect(boundaryCheckpoint?.[1]?.frontier.end.charIndex).toBe(1);
    expect(storage.saveProgress).not.toHaveBeenCalled();
  });

  test("type again atomically resets progress and clears navigation without teardown overwrite", async () => {
    const parsed = book("a");
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 1));
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    host.querySelector(".scr-hidden-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true })
    );
    await vi.waitFor(() => expect(host.textContent).toContain("book complete"));
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    storage.saveReaderCheckpoint.mockClear();
    storage.saveProgress.mockClear();
    let releaseCheckpoint: (() => void) | undefined;
    storage.saveReaderCheckpoint.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        releaseCheckpoint = () => resolve(undefined);
      })
    );
    const typeAgain = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "type again"
    );
    if (!typeAgain) throw new Error("type again button missing");
    typeAgain.click();
    await vi.waitFor(() => expect(storage.saveReaderCheckpoint).toHaveBeenCalledTimes(1));

    const [resetProgress, resetNavigation] = storage.saveReaderCheckpoint.mock.calls[0]!;
    expect(resetProgress.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(resetProgress.charsCompleted).toBe(0);
    expect(resetNavigation).toBeUndefined();
    handle.unmount?.();
    releaseCheckpoint?.();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expect(storage.saveReaderCheckpoint).toHaveBeenCalledTimes(1);
    expect(storage.saveProgress).not.toHaveBeenCalled();
  });

  test("allows terminal Skip by control and shortcut without manufacturing a score", async () => {
    const parsed = book("abcdef");
    const initial = createInitialProgress("book-1", 6);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);

    const mountAndWait = async () => {
      const host = document.createElement("main");
      document.body.appendChild(host);
      const handle = mountReader(host, "book-1");
      await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
      return { host, handle };
    };

    const first = await mountAndWait();
    const skip = first.host.querySelector<HTMLButtonElement>('[aria-label="Skip passage"]')!;
    expect(skip.disabled).toBe(false);
    skip.click();
    await vi.waitFor(() => expect(first.host.textContent).toContain("book complete"));
    let snapshots = savedProgressSnapshots();
    expect(snapshots.at(-1)?.position.charIndex).toBe(6);
    expect(snapshots.at(-1)?.lifetime.sessions).toBe(0);
    expect(skip.disabled).toBe(true);
    first.handle.unmount?.();
    first.host.remove();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    storage.saveProgress.mockClear();
    storage.saveReaderCheckpoint.mockClear();
    const second = await mountAndWait();
    const shortcut = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(second.host.textContent).toContain("book complete"));
    snapshots = savedProgressSnapshots();
    expect(snapshots.at(-1)?.position.charIndex).toBe(6);
    expect(snapshots.at(-1)?.lifetime.sessions).toBe(0);
    second.handle.unmount?.();
    second.host.remove();
  });

  test("remounts an untouched lesson length immediately without manufacturing a result", async () => {
    vi.useFakeTimers();
    const text = Array.from(
      { length: 25 },
      (_, index) => String.fromCharCode("a".charCodeAt(0) + index).repeat(10)
    ).join(" ");
    const parsed = book(text);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", text.length));
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const oldRoot = host.querySelector<HTMLElement>(".scr-root")!;
    const oldFragmentChars = oldRoot.querySelectorAll(".scr-char").length;

    const lessonLength = host.querySelector<HTMLSelectElement>(
      ".reader-lesson-length-select"
    )!;
    lessonLength.focus();
    lessonLength.value = "200";
    lessonLength.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();

    const newRoot = host.querySelector<HTMLElement>(".scr-root")!;
    const newInput = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    expect(newRoot).not.toBe(oldRoot);
    expect(newRoot.querySelectorAll(".scr-char").length).toBeGreaterThan(oldFragmentChars);
    expect(newRoot.querySelectorAll(".scr-char--correct")).toHaveLength(0);
    expect(document.activeElement).toBe(newInput);
    expect(lessonLength.value).toBe("200");
    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(storage.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lessonLength: 200 })
    );

    let snapshots = savedProgressSnapshots();
    expect(snapshots.every((snapshot) => snapshot.lifetime.sessions === 0)).toBe(true);

    // The remounted lesson is idle; the ten-second gap belongs to no result.
    await vi.advanceTimersByTimeAsync(10_000);
    newInput.dispatchEvent(new KeyboardEvent("keydown", { key: text[0]!, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    handle.unmount?.();
    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();

    snapshots = savedProgressSnapshots();
    const latest = snapshots.at(-1)!;
    expect(latest.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(latest.charsCompleted).toBe(0);
    expect(latest.lifetime).toEqual({
      charsTyped: 1,
      errors: 0,
      timeMs: 1_000,
      sessions: 1,
    });
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    host.remove();
  });

  test("defers an active lesson length change without rebuilding or committing the run", async () => {
    vi.useFakeTimers();
    const text = Array.from(
      { length: 30 },
      (_, index) => String.fromCharCode("a".charCodeAt(0) + (index % 26)).repeat(10)
    ).join(" ");
    const parsed = book(text);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", text.length));
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const root = host.querySelector<HTMLElement>(".scr-root")!;
    let input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    const oldFragmentChars = root.querySelectorAll(".scr-char").length;
    const press = (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press(text[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 1; index < 10; index += 1) press(text[index]!);
    const lessonLength = host.querySelector<HTMLSelectElement>(
      ".reader-lesson-length-select"
    )!;
    lessonLength.focus();
    lessonLength.value = "150";
    lessonLength.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    expect(host.querySelector(".scr-root")).toBe(root);
    expect(host.querySelector(".scr-hidden-input")).toBe(input);
    expect(root.querySelectorAll(".scr-char--correct")).toHaveLength(10);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(".toast:last-child")?.textContent).toBe(
      "150 chars from next lesson"
    );
    expect(storage.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lessonLength: 150 })
    );
    let snapshots = savedProgressSnapshots();
    expect(snapshots.every((snapshot) => snapshot.lifetime.sessions === 0)).toBe(true);

    for (let index = 10; index < 110; index += 1) press(text[index]!);
    expect(host.querySelector(".scr-root")).toBe(root);
    expect(root.querySelectorAll(".scr-char").length).toBeGreaterThan(oldFragmentChars);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    snapshots = savedProgressSnapshots();
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    expect(snapshots.at(-1)?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 110,
    });

    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    snapshots = savedProgressSnapshots();
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    host.remove();
  });

  test("persists two rolling lessons exactly once and keeps the latest score through idle handoff", async () => {
    vi.useFakeTimers();
    initAppState({ ...DEFAULT_SETTINGS, soundOnClick: false, showLiveWpm: false });
    const text = Array.from(
      // Keep the second target away from the paragraph end so semantic
      // lesson planning does not correctly carry it through the final word.
      { length: 31 },
      (_, index) => String.fromCharCode("a".charCodeAt(0) + index).repeat(10)
    ).join(" ");
    const parsed = book(text);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", text.length));
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const input = host.querySelector(".scr-hidden-input")!;
    const liveStats = host.querySelector<HTMLElement>(".reader-live-stats")!;
    const announcement = host.querySelector<HTMLElement>(
      ".reader-checkpoint-announcement"
    )!;
    expect(announcement.textContent).toBe("");
    expect(liveStats.hidden).toBe(true);
    const press = (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    // Ten ten-letter words plus their delimiters form the first 100-letter
    // finite lesson. Give each lesson a distinct active duration so its WPM
    // is observably independent from the idle gap and prior result.
    press(text[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 1; index < 110; index += 1) press(text[index]!);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(host.querySelector(".scr-hidden-input")).not.toBeNull();
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe("k");
    const firstResult = host.querySelector(".reader-live-stats")?.textContent;
    expect(firstResult).toContain("1320 wpm");
    expect(liveStats.hidden).toBe(false);
    expect(
      host.querySelector(".reader-checkpoint-announcement")?.textContent
    ).toBe("Lesson complete: 1320 WPM, 100% accuracy. Next passage.");
    expect(liveStats.classList).toContain("reader-live-stats-complete");
    await vi.advanceTimersByTimeAsync(200);
    expect(liveStats.classList).not.toContain("reader-live-stats-complete");

    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    let snapshots = savedProgressSnapshots();
    expect(snapshots.some((snapshot) => snapshot.lifetime.sessions === 1)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(firstResult);
    expect(announcement.textContent).toBe(
      "Lesson complete: 1320 WPM, 100% accuracy. Next passage."
    );
    press(text[110]!);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(firstResult);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(firstResult);
    for (let index = 111; index < 220; index += 1) press(text[index]!);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(host.textContent).not.toContain("session paused");
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe("u");
    const secondResult = host.querySelector(".reader-live-stats")?.textContent;
    expect(secondResult).toContain("660 wpm");
    expect(secondResult).not.toBe(firstResult);
    expect(
      host.querySelector(".reader-checkpoint-announcement")?.textContent
    ).toBe("Lesson complete: 660 WPM, 100% accuracy. Next passage.");

    // A completed lesson is durable before route teardown (crash/reload
    // boundary), not deferred until the whole reader session finishes.
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    snapshots = savedProgressSnapshots();
    const durableCheckpoint = [...snapshots].reverse().find(
      (snapshot) => snapshot.lifetime.sessions === 2
    );
    expect(durableCheckpoint?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 220,
    });
    expect(durableCheckpoint?.charsCompleted).toBe(220);
    expect(durableCheckpoint?.lifetime).toEqual({
      charsTyped: 220,
      errors: 0,
      timeMs: 3_000,
      sessions: 2,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(secondResult);
    press(text[220]!);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(secondResult);
    await vi.advanceTimersByTimeAsync(1_000);
    handle.unmount?.();
    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    snapshots = savedProgressSnapshots();
    const latest = snapshots.at(-1)!;
    expect(latest.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 220 });
    expect(latest.charsCompleted).toBe(220);
    expect(latest.lifetime).toEqual({
      charsTyped: 221,
      errors: 0,
      timeMs: 4_000,
      sessions: 3,
    });
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(3);
    host.remove();
  });

  test("replays exact passage history without regressing the saved frontier and skips without a score", async () => {
    vi.useFakeTimers();
    const text = Array.from(
      { length: 41 },
      (_, index) => String.fromCharCode("a".charCodeAt(0) + (index % 26)).repeat(10)
    ).join(" ");
    const parsed = book(text);
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", text.length));
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    let input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    const press = (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press(text[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 1; index < 110; index += 1) press(text[index]!);
    press(text[110]!);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 111; index < 220; index += 1) press(text[index]!);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    const previous = host.querySelector<HTMLButtonElement>(
      '[aria-label="Previous passage"]'
    )!;
    const forward = () => host.querySelector<HTMLButtonElement>(
      ".reader-lesson-nav button:last-child"
    )!;
    expect(previous.disabled).toBe(false);
    expect(forward().getAttribute("aria-label")).toBe("Skip passage");

    // Previous snapshots the live frontier synchronously; mountLesson would
    // otherwise cancel this character's still-pending debounce.
    press(text[220]!);
    const toPrevious = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(toPrevious);
    expect(toPrevious.defaultPrevented).toBe(true);
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[110]);
    expect(document.activeElement).toBe(input);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    const immediateSnapshots = savedProgressSnapshots();
    expect(immediateSnapshots.at(-1)?.position.charIndex).toBe(220);

    // A pause rebuilds the session but must remount the exact historical
    // anchor, including its frozen end, rather than recomposing from settings.
    const historicalPassage = host.querySelector(".scr-text")?.textContent;
    const historicalLastCharacter = host.querySelectorAll(".scr-text .scr-char").item(109)
      .textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const resume = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "resume"
    );
    if (!resume) throw new Error("resume button missing");
    resume.click();
    input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    expect(host.querySelector(".scr-text")?.textContent).toBe(historicalPassage);
    expect(host.querySelectorAll(".scr-text .scr-char").item(109).textContent).toBe(
      historicalLastCharacter
    );
    expect(forward().getAttribute("aria-label")).toBe("Return to current passage");
    expect(document.activeElement).toBe(input);

    // A partial historical attempt is discarded when moving farther back.
    press(text[110]!);
    previous.click();
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[0]);
    expect(forward().getAttribute("aria-label")).toBe("Next passage");

    const next = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(true);
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[110]);
    expect(forward().getAttribute("aria-label")).toBe("Return to current passage");
    forward().click();
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[220]);
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(1);
    expect(forward().getAttribute("aria-label")).toBe("Skip passage");

    let progressSnapshots = savedProgressSnapshots();
    expect(progressSnapshots.at(-1)?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 220,
    });
    expect(progressSnapshots.at(-1)?.lifetime.sessions).toBe(2);

    // Skip advances the durable cursor but does not manufacture a result.
    forward().click();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    progressSnapshots = savedProgressSnapshots();
    expect(progressSnapshots.at(-1)?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 330,
    });
    expect(progressSnapshots.at(-1)?.lifetime.sessions).toBe(2);
    const navigation = savedNavigationSnapshots().at(-1);
    expect(navigation?.history.at(-1)?.outcome).toBe("skipped");
    expect(navigation?.frontier.start.charIndex).toBe(330);

    // Restart replaces only the in-memory attempt and returns typing focus.
    press(text[330]!);
    const restartShortcut = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(restartShortcut);
    expect(restartShortcut.defaultPrevented).toBe(true);
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(0);
    expect(document.activeElement).toBe(input);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    progressSnapshots = savedProgressSnapshots();
    expect(progressSnapshots.at(-1)?.position.charIndex).toBe(330);
    expect(progressSnapshots.at(-1)?.lifetime.sessions).toBe(2);

    // Escape/resume rebuilds the exact anchor while the bookmark remains at
    // the passage boundary.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const resumeAfterRestart = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "resume"
    );
    if (!resumeAfterRestart) throw new Error("resume button missing after restart");
    resumeAfterRestart.click();
    input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe(text[330]);
    expect(document.activeElement).toBe(input);
    progressSnapshots = savedProgressSnapshots();
    expect(progressSnapshots.at(-1)?.position.charIndex).toBe(330);

    const navigationSavesBeforeUnmount = savedNavigationSnapshots().length;
    handle.unmount?.();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    progressSnapshots = savedProgressSnapshots();
    expect(progressSnapshots.at(-1)?.position.charIndex).toBe(330);
    expect(savedNavigationSnapshots()).toHaveLength(navigationSavesBeforeUnmount);
    expect(savedNavigationSnapshots().at(-1)?.frontier.start.charIndex).toBe(330);
    host.remove();
  });

  test("keeps a partial lesson route-local and restarts its anchor after remount", async () => {
    vi.useFakeTimers();
    const parsed = book("abcdef ghijkl");
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 13));
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    const input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
    const press = (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press("a");
    press("b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storage.saveProgress).not.toHaveBeenCalled();
    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    const saved = savedProgressSnapshots();
    const durable = saved.at(-1);
    expect(durable?.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 0 });
    expect(durable?.charsCompleted).toBe(0);
    expect(durable?.lifetime).toMatchObject({ charsTyped: 2, sessions: 1 });
    const navigation = savedNavigationSnapshots().at(-1);
    storage.getProgress.mockResolvedValue(durable);
    storage.getLessonNavigation.mockResolvedValue(navigation);

    const remounted = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector(".scr-text .scr-char")?.textContent).toBe("a");
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(0);
    remounted.unmount?.();
  });

  test("shows useful session results on Escape and can resume in place", async () => {
    const parsed = book("ab");
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 2));
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    host.querySelector(".scr-hidden-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true })
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(host.textContent).toContain("session paused");
    expect(host.textContent).toContain("accuracy");
    expect(host.textContent).toContain("consistency");
    expect(host.querySelector(".scr-hidden-input")).toBeNull();
    const resume = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "resume"
    );
    if (!resume) throw new Error("resume button missing");
    resume.click();
    expect(host.querySelector(".scr-hidden-input")).not.toBeNull();
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(1);
    await vi.waitFor(() => {
      const saved = savedProgressSnapshots();
      expect(saved.at(-1)?.position.charIndex).toBe(0);
      expect(saved.at(-1)?.charsCompleted).toBe(0);
    });
    handle.unmount?.();
  });

  test("opens contents, marks the current section, restores focus, and saves before jumping", async () => {
    const parsed = book("ab");
    parsed.sections[0]!.order = 8;
    parsed.sections.push(
      {
        id: "chapter-2",
        href: "chapter-2.xhtml",
        title: "Chapter Two",
        order: 9,
        kind: "body",
        included: true,
        blocks: [{ kind: "paragraph", text: "cd" }],
        charCount: 2,
      },
      {
        id: "notes",
        href: "notes.xhtml",
        title: "Notes",
        order: 2,
        kind: "backmatter",
        included: false,
        blocks: [{ kind: "paragraph", text: "ef" }],
        charCount: 2,
      }
    );
    const initial: BookProgress = {
      ...createInitialProgress("book-1", 4),
      position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
      charsCompleted: 0,
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    storage.saveProgress.mockClear();
    host.querySelector(".scr-hidden-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true })
    );
    const originalRoot = host.querySelector(".scr-root")!;
    const originalSpan = host.querySelector(".scr-char")!;
    const originalCaret = host.querySelector(".scr-caret")!;
    const originalStats = host.querySelector(".reader-live-stats")?.textContent;
    const originalCorrectCount = host.querySelectorAll(".scr-char--correct").length;
    const contentsControl = host.querySelector(
      ".reader-contents-control"
    ) as HTMLButtonElement;
    contentsControl.focus();
    contentsControl.click();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("contents");
    const items = [...dialog.querySelectorAll<HTMLButtonElement>(".reader-contents-item")];
    expect(items).toHaveLength(2);
    expect(dialog.textContent).not.toContain("Notes");
    expect(items[0]?.querySelector(".reader-contents-order")?.textContent).toBe("01");
    expect(items[1]?.querySelector(".reader-contents-order")?.textContent).toBe("02");
    expect(items[0]?.getAttribute("aria-current")).toBe("location");
    expect(items[0]?.textContent).toContain("current · 0%");
    expect(host.hasAttribute("inert")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".scr-root")).toBe(originalRoot);
    expect(host.querySelector(".scr-char")).toBe(originalSpan);
    expect(host.querySelector(".scr-caret")).toBe(originalCaret);
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe(originalStats);
    expect(host.querySelectorAll(".scr-char--correct")).toHaveLength(originalCorrectCount);

    const dialogButtons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    dialogButtons.at(-1)!.focus();
    dialogButtons.at(-1)!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(dialogButtons[0]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(contentsControl);
    expect(host.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(host.querySelector(".scr-root")).toBe(originalRoot);
    expect(host.querySelector(".scr-char")).toBe(originalSpan);
    expect(host.querySelector(".scr-caret")).toBe(originalCaret);
    const interimSnapshots = savedProgressSnapshots();
    expect(
      interimSnapshots.every((snapshot) => snapshot.lifetime.sessions === 0)
    ).toBe(true);

    contentsControl.click();
    const chapterTwo = [...document.querySelectorAll<HTMLButtonElement>(".reader-contents-item")].find(
      (button) => button.textContent?.includes("Chapter Two")
    );
    if (!chapterTwo) throw new Error("Chapter Two missing from contents");
    chapterTwo.click();
    await vi.waitFor(() =>
      expect(host.querySelector(".reader-section-title")?.textContent).toBe("Chapter Two")
    );

    await vi.waitFor(() => {
      const saved = savedProgressSnapshots();
      expect(
        saved.some(
          (snapshot) =>
            snapshot.position.sectionIndex === 1 && snapshot.position.charIndex === 0
        )
      ).toBe(true);
    });
    const snapshots = savedProgressSnapshots();
    const outgoingIndex = snapshots.findIndex(
      (snapshot) =>
        snapshot.position.sectionIndex === 0 &&
        snapshot.position.charIndex === 0 &&
        snapshot.lifetime.sessions === 1
    );
    const targetIndex = snapshots.findIndex(
      (snapshot) => snapshot.position.sectionIndex === 1 && snapshot.position.charIndex === 0
    );
    expect(outgoingIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeGreaterThan(outgoingIndex);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    handle.unmount?.();
    host.remove();
  });

  test("closing contents before typing resumes silently at the same idle position", async () => {
    const parsed = book("ab");
    parsed.sections[0]!.blocks.push({ kind: "paragraph", text: "cd" });
    parsed.sections[0]!.charCount = 4;
    const initial: BookProgress = {
      ...createInitialProgress("book-1", 4),
      position: { sectionIndex: 0, blockIndex: 0, charIndex: 1 },
      charsCompleted: 1,
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    (host.querySelector(".reader-contents-control") as HTMLButtonElement).click();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(host.textContent).not.toContain("session paused");
    expect(host.querySelector(".reader-live-stats")?.textContent).toBe("0 wpm100% accuracy");
    expect(host.querySelector(".reader-live-stats")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector(".scr-hidden-input")).not.toBeNull();
    expect(host.querySelector(".reader-section-title")?.textContent).toBe("Chapter One");
    handle.unmount?.();
  });

  test("canonicalizes overrides and clamps completion when the included corpus shrinks", async () => {
    const parsed = book("abcd");
    parsed.sections.push({
      id: "chapter-2",
      href: "chapter-2.xhtml",
      title: "Chapter Two",
      order: 1,
      kind: "body",
      included: true,
      blocks: [{ kind: "paragraph", text: "ef" }],
      charCount: 2,
    });
    const initial: BookProgress = {
      ...createInitialProgress("book-1", 6, { "chapter-1": true }),
      position: { sectionIndex: 1, blockIndex: 0, charIndex: 2 },
      charsCompleted: 6,
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);
    const host = document.createElement("main");

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.textContent).toContain("book complete"));
    (host.querySelector(".reader-contents-control") as HTMLButtonElement).click();
    const editIncluded = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "edit included sections"
    );
    if (!editIncluded) throw new Error("edit included sections button missing");
    editIncluded.click();
    const chapterTwo = document.querySelector(
      '[aria-label="Include Chapter Two"]'
    ) as HTMLInputElement;
    chapterTwo.click();
    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "apply"
    )!;
    apply.click();

    await vi.waitFor(() => expect(storage.saveReaderCheckpoint).toHaveBeenCalled());
    const snapshots = savedProgressSnapshots();
    const latest = snapshots.at(-1)!;
    expect(latest.totalChars).toBe(4);
    expect(latest.charsCompleted).toBe(4);
    expect(latest.charsCompleted).toBeLessThanOrEqual(latest.totalChars);
    expect(latest.sectionOverrides).toEqual({ "chapter-2": false });
    handle.unmount?.();
  });
});
