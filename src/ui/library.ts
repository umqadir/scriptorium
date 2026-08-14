import type { BookMeta, BookProgress } from "../types";
import { SUPPORTED_BOOK_ACCEPT, isSupportedBookFile } from "../import/parse-book";
import { deleteBook, listBooks } from "../store/books";
import { getProgress } from "../store/progress";
import { el, clear } from "./dom";
import { iconSpan } from "./icons";
import { confirmModal } from "./modal";
import { navigate } from "./router";
import { showToast } from "./toast";
import { startImportFlow } from "./import";

export type ScreenHandle = { unmount?: () => void };

type BookRow = { meta: BookMeta; progress: BookProgress | undefined };

async function loadRows(): Promise<BookRow[]> {
  const metas = await listBooks();
  const progresses = await Promise.all(metas.map((m) => getProgress(m.id)));
  return metas.map((meta, i) => ({ meta, progress: progresses[i] }));
}

function bookCard(row: BookRow, onChange: () => void): HTMLElement {
  const { meta, progress } = row;
  const percent =
    progress && progress.totalChars > 0
      ? Math.min(100, Math.round((progress.charsCompleted / progress.totalChars) * 100))
      : 0;
  const bestWpm = progress && progress.bestWpm > 0 ? Math.round(progress.bestWpm) : undefined;

  const openButton = el(
    "button",
    {
      className: "book-card-open",
      attrs: { type: "button", "aria-label": `Open ${meta.title}` },
      on: {
        click: () => navigate({ name: "reader", bookId: meta.id }),
      },
    },
    el(
      "div",
      { className: "book-cover" },
      meta.coverDataUrl
        ? el("img", { attrs: { src: meta.coverDataUrl, alt: "" } })
        : iconSpan("book")
    ),
    el("div", { className: "book-title" }, meta.title),
    el("div", { className: "book-author" }, meta.author || "Unknown author"),
    el(
      "div",
      {
        className: "book-progress-bar",
        attrs: {
          role: "progressbar",
          "aria-label": `Reading progress for ${meta.title}`,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": percent,
        },
      },
      el("div", { className: "book-progress-fill", attrs: { style: `width:${percent}%` } })
    ),
    el(
      "div",
      { className: "book-meta-row" },
      el("span", {}, `${percent}%`),
      el("span", {}, bestWpm !== undefined ? `${bestWpm} wpm best` : "not started")
    )
  );

  const deleteButton = el(
    "button",
    {
      className: "icon-button book-delete",
      attrs: { type: "button", "aria-label": `Delete ${meta.title}` },
      on: {
        click: async () => {
          const ok = await confirmModal({
            title: "Delete book",
            message: `Delete "${meta.title}" and all its progress? This can't be undone. (Your typing history on other synced devices is unaffected until they sync again.)`,
            confirmLabel: "delete",
            danger: true,
          });
          if (!ok) return;
          await deleteBook(meta.id);
          showToast(`Deleted "${meta.title}".`, "info");
          onChange();
        },
      },
    },
    iconSpan("trash")
  );

  const card = el(
    "article",
    { className: "book-card", attrs: { role: "listitem" } },
    openButton,
    deleteButton
  );
  return card;
}

function emptyState(onAdd: () => void): HTMLElement {
  return el(
    "div",
    { className: "empty-state" },
    iconSpan("book"),
    el("p", {}, "Add a book to start typing. Your progress saves automatically."),
    el(
      "button",
      { className: "button active", on: { click: onAdd } },
      iconSpan("plus"),
      "add your first book"
    )
  );
}

function fileInput(onFile: (file: File) => void): HTMLInputElement {
  const input = el("input", {
    className: "visually-hidden",
    attrs: {
      type: "file",
      accept: SUPPORTED_BOOK_ACCEPT,
      hidden: true,
      tabindex: "-1",
      "aria-hidden": "true",
    },
    on: {
      change: () => {
        const file = input.files?.[0];
        if (file && isSupportedBookFile(file)) onFile(file);
        else if (file) showToast("Choose an EPUB, PDF, text, Markdown, or HTML book.", "warning");
        input.value = "";
      },
    },
  }) as HTMLInputElement;
  return input;
}

export function mountLibrary(container: HTMLElement): ScreenHandle {
  clear(container);

  const addFile = fileInput((file) => startImportFlow(file));
  const addButton = el(
    "button",
    { className: "button active", attrs: { type: "button", hidden: true } },
    iconSpan("plus"),
    "add book"
  );
  addButton.addEventListener("click", () => addFile.click());

  const toolbar = el(
    "div",
    { className: "library-toolbar" },
    el("h1", {}, "your library"),
    el("div", { className: "button-row" }, addButton, addFile)
  );

  const gridHost = el(
    "div",
    { attrs: { "aria-busy": "true" } },
    el("div", { className: "library-loading", attrs: { role: "status" } }, "loading library…")
  );
  container.append(toolbar, gridHost);

  let cancelled = false;

  async function render(): Promise<void> {
    gridHost.setAttribute("aria-busy", "true");
    let rows: BookRow[];
    try {
      rows = await loadRows();
    } catch (err) {
      console.error("Failed to load library", err);
      showToast("Couldn't load your library from storage.", "error");
      rows = [];
    }
    if (cancelled) return;
    gridHost.setAttribute("aria-busy", "false");
    addButton.hidden = rows.length === 0;
    clear(gridHost);
    if (rows.length === 0) {
      gridHost.appendChild(emptyState(() => addFile.click()));
      return;
    }
    const grid = el("div", { className: "book-grid", attrs: { role: "list" } });
    for (const row of rows) {
      grid.appendChild(bookCard(row, () => void render()));
    }
    gridHost.appendChild(grid);
  }

  void render();

  return {
    unmount: () => {
      cancelled = true;
    },
  };
}
