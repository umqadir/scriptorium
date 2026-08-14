import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ParseResult, ParseWarning } from "../../src/types";

const mocks = vi.hoisted(() => ({
  parseEpub: vi.fn(),
  getProgress: vi.fn(async () => undefined),
  navigate: vi.fn(),
}));

vi.mock("../../src/epub", () => ({ parseEpub: mocks.parseEpub }));
vi.mock("../../src/store/books", () => ({ addBook: vi.fn(async () => undefined) }));
vi.mock("../../src/store/progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/progress")>();
  return {
    ...actual,
    getProgress: mocks.getProgress,
    saveProgress: vi.fn(async () => undefined),
  };
});
vi.mock("../../src/ui/router", () => ({ navigate: mocks.navigate }));
vi.mock("../../src/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../src/ui/state", () => ({
  getAppState: () => ({ settings: { foldAccents: true } }),
}));

import { mountImport, startImportFlow } from "../../src/ui/import";

function diagnostic(code: ParseWarning["code"], message: string): ParseWarning {
  return { code, message, sectionId: "chapter-1" };
}

describe("import review", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    mocks.parseEpub.mockReset();
    mocks.getProgress.mockClear();
    mocks.navigate.mockClear();
  });

  test("keeps parser cleanup invisible and only lists readable sections", async () => {
    const warnings: ParseWarning[] = [
      ...Array.from({ length: 23 }, () =>
        diagnostic("verse-numbers-stripped", "Stripped literal verse line numbers from the text.")
      ),
      diagnostic("dropped-chars", "Removed 14 characters that cannot be typed on a standard keyboard."),
      diagnostic("empty-section", "This section contains no readable text."),
      diagnostic("blocks-split", "Split 57 oversized paragraphs into readable chunks at sentence boundaries."),
      diagnostic("dehyphenated", "Repaired 1 broken hyphenations (0 rejoined into whole words)."),
    ];
    const result: ParseResult = {
      book: {
        meta: {
          id: "iliad",
          title: "The Iliad of Homer",
          author: "Richmond Lattimore",
          language: "en",
          addedAt: 1,
        },
        sections: [
          {
            id: "empty",
            href: "empty.xhtml",
            title: "Empty",
            order: 0,
            kind: "frontmatter",
            included: false,
            blocks: [],
            charCount: 0,
          },
          {
            id: "chapter-1",
            href: "chapter-1.xhtml",
            title: "Book One",
            order: 1,
            kind: "body",
            included: true,
            blocks: [{ kind: "paragraph", text: "Sing, goddess" }],
            charCount: 12,
          },
        ],
      },
      warnings,
    };
    mocks.parseEpub.mockResolvedValue(result);

    startImportFlow(new File(["epub"], "iliad.epub", { type: "application/epub+zip" }));
    const host = document.createElement("main");
    document.body.appendChild(host);
    mountImport(host);

    await vi.waitFor(() => expect(host.querySelectorAll(".section-row")).toHaveLength(1));
    expect(host.textContent).toContain("The Iliad of Homer");
    expect(host.textContent).toContain("Book One");
    expect(host.textContent).toContain("main text");
    expect(host.textContent).not.toContain("things worth knowing");
    expect(host.textContent).not.toContain("Stripped literal verse line numbers");
    expect(host.textContent).not.toContain("cannot be typed");
    expect(host.textContent).not.toContain("no readable text");
    expect(host.textContent).not.toContain("oversized paragraphs");
    expect(host.textContent).not.toContain("hyphenations");
    expect(host.textContent).not.toContain("Empty");
    expect(host.querySelector(".warning-panel")).toBeNull();
  });
});
