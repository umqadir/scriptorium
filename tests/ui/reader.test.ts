import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// The project intentionally omits Node typings; this test parses the real
// reader stylesheet because Vitest stubs CSS imports to an empty string.
// @ts-expect-error Node's runtime module is available to the Vitest process.
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, type BookProgress, type ParsedBook } from "../../src/types";
import { createInitialProgress } from "../../src/store/progress";
import { initAppState } from "../../src/ui/state";

const storage = vi.hoisted(() => ({
  getBook: vi.fn(),
  getProgress: vi.fn(),
  saveProgress: vi.fn(async () => undefined),
  saveSettings: vi.fn(async () => undefined),
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

describe("mountReader", () => {
  beforeEach(() => {
    storage.getBook.mockReset();
    storage.getProgress.mockReset();
    storage.saveProgress.mockReset();
    storage.saveProgress.mockResolvedValue(undefined);
    storage.saveSettings.mockReset();
    storage.saveSettings.mockResolvedValue(undefined);
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
      "reader-live-stats",
      "typing-container",
      "reader-hint",
      "visually-hidden reader-checkpoint-announcement",
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
    handle.unmount?.();
    await vi.waitFor(() =>
      expect(
        (storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>).some(
          ([snapshot]) => snapshot.lifetime.sessions === 1
        )
      ).toBe(true)
    );

    const snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const latest = snapshots.at(-1)!;
    expect(latest.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 1 });
    expect(latest.charsCompleted).toBe(1);
    expect(latest.lifetime.charsTyped).toBe(1);
    expect(latest.lifetime.sessions).toBe(1);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
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

    let snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(0);
    expect(snapshots.at(-1)?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 0,
    });

    // The remounted lesson is idle; the ten-second gap belongs to no result.
    await vi.advanceTimersByTimeAsync(10_000);
    newInput.dispatchEvent(new KeyboardEvent("keydown", { key: text[0]!, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    handle.unmount?.();
    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();

    snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const latest = snapshots.at(-1)!;
    expect(latest.position).toEqual({ sectionIndex: 0, blockIndex: 0, charIndex: 1 });
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
    const input = host.querySelector<HTMLElement>(".scr-hidden-input")!;
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
    let snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(0);

    for (let index = 10; index < 110; index += 1) press(text[index]!);
    expect(host.querySelector(".scr-root")).toBe(root);
    expect(root.querySelectorAll(".scr-char").length).toBeGreaterThan(oldFragmentChars);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
    expect(snapshots.at(-1)?.position).toEqual({
      sectionIndex: 0,
      blockIndex: 0,
      charIndex: 110,
    });

    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
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
    let snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
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
    snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
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

    snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const latest = snapshots.at(-1)!;
    expect(latest.lifetime).toEqual({
      charsTyped: 221,
      errors: 0,
      timeMs: 4_000,
      sessions: 3,
    });
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(3);
    host.remove();
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
    await vi.waitFor(() => expect(storage.saveProgress).toHaveBeenCalled());
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
    expect(items[0]?.textContent).toContain("current · 50%");
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
    let interimSnapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
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
      const saved = storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>;
      expect(
        saved.some(([snapshot]) => snapshot.position.sectionIndex === 1 && snapshot.position.charIndex === 0)
      ).toBe(true);
    });
    const snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const outgoingIndex = snapshots.findIndex(
      (snapshot) => snapshot.position.sectionIndex === 0 && snapshot.position.charIndex === 1
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

    await vi.waitFor(() => expect(storage.saveProgress).toHaveBeenCalled());
    const snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const latest = snapshots.at(-1)!;
    expect(latest.totalChars).toBe(4);
    expect(latest.charsCompleted).toBe(4);
    expect(latest.charsCompleted).toBeLessThanOrEqual(latest.totalChars);
    expect(latest.sectionOverrides).toEqual({ "chapter-2": false });
    handle.unmount?.();
  });
});
