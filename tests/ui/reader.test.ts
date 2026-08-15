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
    ]);
    expect(shell.querySelector('[role="progressbar"]')).toBeNull();
    expect(shell.querySelector(".reader-progress-bar")).toBeNull();

    const topbar = shell.querySelector<HTMLElement>(".reader-topbar")!;
    expect([...topbar.children].map((child) => child.className)).toEqual([
      "reader-topbar-leading",
      "reader-topbar-center",
      "reader-actions reader-topbar-trailing",
    ]);

    const input = shell.querySelector<HTMLElement>(".scr-hidden-input")!;
    const stats = workspace.querySelector<HTMLElement>(".reader-live-stats")!;
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

  test("keeps block runs independent in chrome and lifetime without interrupting between paragraphs", async () => {
    vi.useFakeTimers();
    const parsed = book("ab");
    parsed.sections[0]!.blocks.push({ kind: "paragraph", text: "cd" });
    parsed.sections[0]!.charCount = 4;
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(createInitialProgress("book-1", 4));
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const input = host.querySelector(".scr-hidden-input")!;
    const press = (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press("a");
    await vi.advanceTimersByTimeAsync(1_000);
    press("b");
    await vi.advanceTimersByTimeAsync(1_000);
    press("Enter");

    expect(host.querySelector(".reader-session-results")).toBeNull();
    expect(host.textContent).not.toContain("session paused");
    expect(host.querySelector(".scr-hidden-input")).not.toBeNull();
    expect(host.querySelector(".reader-live-stats")?.textContent).toContain("18 wpm");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.querySelector(".reader-live-stats")?.textContent).toContain("18 wpm");
    press("c");
    // At the exact first-key instant elapsed time is zero, so retain the
    // completed run rather than flashing a meaningless 0 WPM.
    expect(host.querySelector(".reader-live-stats")?.textContent).toContain("18 wpm");
    await vi.advanceTimersByTimeAsync(250);
    const liveStats = host.querySelector<HTMLElement>(".reader-live-stats")!;
    expect(liveStats.textContent).not.toContain("18 wpm");
    expect(host.querySelector(".reader-shell")?.classList).toContain("reader-focused");
    expect(liveStats.hidden).toBe(false);
    expect(liveStats.closest(".reader-chrome")).toBeNull();
    await vi.advanceTimersByTimeAsync(750);
    press("d");

    expect(host.textContent).toContain("book complete");
    handle.unmount?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    const snapshots = (
      storage.saveProgress.mock.calls as unknown as Array<[BookProgress]>
    ).map(([snapshot]) => snapshot);
    const withLifetime = snapshots.filter((snapshot) => snapshot.lifetime.sessions === 1);
    expect(withLifetime.length).toBeGreaterThan(0);
    const latest = withLifetime.at(-1)!;
    expect(latest.lifetime).toEqual({
      charsTyped: 5,
      errors: 0,
      timeMs: 3_000,
      sessions: 1,
    });
    expect(Math.max(...snapshots.map((snapshot) => snapshot.lifetime.sessions))).toBe(1);
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

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(contentsControl);
    expect(host.textContent).toContain("session paused");

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
