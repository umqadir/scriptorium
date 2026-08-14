import { afterEach, describe, expect, test, vi } from "vitest";
import type { BookMeta } from "../../src/types";
import { SUPPORTED_BOOK_ACCEPT } from "../../src/import/parse-book";

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
    expect(host.querySelector<HTMLButtonElement>(".library-toolbar .button")?.hidden).toBe(false);

    handle.unmount?.();
  });

  test("shows one format-neutral add action when the library is empty", async () => {
    vi.doMock("../../src/store/books", () => ({
      listBooks: vi.fn(async () => []),
      deleteBook: vi.fn(),
    }));
    vi.doMock("../../src/store/progress", () => ({ getProgress: vi.fn() }));
    vi.doMock("../../src/ui/router", () => ({ navigate: vi.fn() }));
    vi.doMock("../../src/ui/import", () => ({ startImportFlow: vi.fn() }));
    vi.doMock("../../src/ui/toast", () => ({ showToast: vi.fn() }));

    const { mountLibrary } = await import("../../src/ui/library");
    const host = document.createElement("main");
    document.body.appendChild(host);
    const handle = mountLibrary(host);

    await vi.waitFor(() => expect(host.querySelector(".empty-state")).not.toBeNull());
    expect(host.querySelector<HTMLButtonElement>(".library-toolbar .button")?.hidden).toBe(true);
    expect(host.querySelector(".empty-state p")?.textContent).toBe(
      "Add a book to start typing. Your progress saves automatically."
    );
    expect(host.querySelector(".empty-state button")?.textContent).toContain("add your first book");
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => !button.hidden && button.textContent?.includes("add")
      )
    ).toHaveLength(1);

    handle.unmount?.();
  });

  test("accepts supported book formats and rejects unsupported files", async () => {
    vi.doMock("../../src/store/books", () => ({
      listBooks: vi.fn(async () => []),
      deleteBook: vi.fn(),
    }));
    vi.doMock("../../src/store/progress", () => ({ getProgress: vi.fn() }));
    vi.doMock("../../src/ui/router", () => ({ navigate: vi.fn() }));
    const startImportFlow = vi.fn();
    const showToast = vi.fn();
    vi.doMock("../../src/ui/import", () => ({ startImportFlow }));
    vi.doMock("../../src/ui/toast", () => ({ showToast }));

    const { mountLibrary } = await import("../../src/ui/library");
    const host = document.createElement("main");
    document.body.appendChild(host);
    const handle = mountLibrary(host);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input?.accept).toBe(SUPPORTED_BOOK_ACCEPT);
    for (const file of [
      new File(["epub"], "book.epub", { type: "application/epub+zip" }),
      new File(["pdf"], "book.pdf", { type: "application/pdf" }),
      new File(["text"], "book.txt", { type: "text/plain" }),
      new File(["markdown"], "book.md", { type: "text/markdown" }),
      new File(["html"], "book.htm", { type: "text/html" }),
    ]) {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input?.dispatchEvent(new Event("change"));
    }
    expect(startImportFlow).toHaveBeenCalledTimes(5);

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["doc"], "book.docx")],
    });
    input?.dispatchEvent(new Event("change"));
    expect(startImportFlow).toHaveBeenCalledTimes(5);
    expect(showToast).toHaveBeenCalledWith(
      "Choose an EPUB, PDF, text, Markdown, or HTML book.",
      "warning"
    );

    handle.unmount?.();
  });
});
