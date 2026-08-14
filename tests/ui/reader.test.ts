import { beforeEach, describe, expect, test, vi } from "vitest";
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
      position: { sectionIndex: 0, blockIndex: 0, charIndex: 1 },
      charsCompleted: 1,
    };
    storage.getBook.mockResolvedValue(stored(parsed));
    storage.getProgress.mockResolvedValue(initial);
    const host = document.createElement("main");
    document.body.appendChild(host);

    const handle = mountReader(host, "book-1");
    await vi.waitFor(() => expect(host.querySelector(".scr-hidden-input")).not.toBeNull());
    await vi.waitFor(() => expect(storage.saveProgress).toHaveBeenCalled());
    storage.saveProgress.mockClear();
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
