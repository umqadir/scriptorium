import { afterEach, describe, expect, test, vi } from "vitest";
import type { BookMeta } from "../../src/types";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.resetModules();
  vi.unmock("../../src/store/books");
  vi.unmock("../../src/store/progress");
  vi.unmock("../../src/ui/router");
  vi.unmock("../../src/ui/import");
  vi.unmock("../../src/ui/toast");
});

describe("library book tiles", () => {
  test("shows loading, uses sibling actions, and exposes reading progress", async () => {
    const meta: BookMeta = {
      id: "book-1",
      title: "A Long Journey",
      author: "A. Reader",
      language: "en",
      addedAt: 1,
    };
    let resolveBooks!: (books: BookMeta[]) => void;
    const books = new Promise<BookMeta[]>((resolve) => {
      resolveBooks = resolve;
    });

    vi.doMock("../../src/store/books", () => ({
      listBooks: () => books,
      deleteBook: vi.fn(),
    }));
    vi.doMock("../../src/store/progress", () => ({
      getProgress: vi.fn(async () => ({
        bookId: meta.id,
        position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
        charsCompleted: 25,
        totalChars: 100,
        updatedAt: 1,
        lifetime: { charsTyped: 0, errors: 0, timeMs: 0, sessions: 0 },
        bestWpm: 0,
        sectionOverrides: {},
      })),
    }));
    vi.doMock("../../src/ui/router", () => ({ navigate: vi.fn() }));
    vi.doMock("../../src/ui/import", () => ({ startImportFlow: vi.fn() }));
    vi.doMock("../../src/ui/toast", () => ({ showToast: vi.fn() }));

    const { mountLibrary } = await import("../../src/ui/library");
    const host = document.createElement("main");
    document.body.appendChild(host);
    const handle = mountLibrary(host);

    expect(host.querySelector(".library-loading")?.textContent).toContain("loading library");
    resolveBooks([meta]);

    await vi.waitFor(() => expect(host.querySelector(".book-card")).not.toBeNull());
    const card = host.querySelector<HTMLElement>(".book-card");
    const open = card?.querySelector<HTMLButtonElement>(".book-card-open");
    const remove = card?.querySelector<HTMLButtonElement>(".book-delete");
    const progress = card?.querySelector<HTMLElement>('[role="progressbar"]');

    expect(card?.tagName).toBe("ARTICLE");
    expect(open?.tagName).toBe("BUTTON");
    expect(remove?.tagName).toBe("BUTTON");
    expect(open?.contains(remove ?? null)).toBe(false);
    expect(progress?.getAttribute("aria-valuenow")).toBe("25");
    expect(progress?.getAttribute("aria-valuemax")).toBe("100");
    expect(host.querySelector('[aria-busy="false"]')).not.toBeNull();

    handle.unmount?.();
  });
});
