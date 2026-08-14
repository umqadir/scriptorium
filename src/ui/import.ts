import type { ParsedBook, ParseResult, Section } from "../types";
import { isSupportedBookFile, parseBookFile } from "../import/parse-book";
import { addBook } from "../store/books";
import {
  computeTotalChars,
  createInitialProgress,
  getProgress,
  saveProgress,
} from "../store/progress";
import { el, clear } from "./dom";
import { iconSpan } from "./icons";
import { navigate } from "./router";
import { showToast } from "./toast";
import { getAppState } from "./state";

export type ScreenHandle = { unmount?: () => void };

// The file being imported can't round-trip through the URL hash, so it's
// held here in memory. A hard reload mid-import loses the in-progress
// import (the user just re-picks the file) — an acceptable trade-off for a
// local-first static app with no server-side upload session to resume from.
let pendingFile: File | undefined;

export function startImportFlow(file: File): void {
  pendingFile = file;
  navigate({ name: "import" });
}

function kindLabel(section: Section): string | undefined {
  switch (section.kind) {
    case "frontmatter":
      return "front matter";
    case "backmatter":
      return "back matter";
    case "body":
      return undefined;
  }
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k chars`;
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "That file couldn't be read. It may be damaged or use an unsupported format.";
}

function noFileFallback(container: HTMLElement): void {
  clear(container);
  container.appendChild(
    el(
      "div",
      { className: "import-screen" },
      el("h1", {}, "add a book"),
      el("p", { className: "text" }, "No file is selected. Go back to the library and choose “add book”."),
      el(
        "button",
        { className: "button active", on: { click: () => navigate({ name: "library" }) } },
        "back to library"
      )
    )
  );
}

export function mountImport(container: HTMLElement): ScreenHandle {
  clear(container);
  let cancelled = false;
  const file = pendingFile;
  pendingFile = undefined;

  if (!file) {
    noFileFallback(container);
    return {};
  }
  // Keep a definitely-present reference for callbacks: TypeScript cannot
  // retain the narrowing of `file` across closures.
  const selectedFile = file;

  const screen = el("div", { className: "import-screen" });
  container.appendChild(screen);

  function showProgress(): void {
    clear(screen);
    screen.appendChild(
      el(
        "div",
        {
          className: "import-progress",
          attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
        },
        el("div", { className: "spinner", attrs: { "aria-hidden": "true" } }),
        el("p", {}, `Reading ${selectedFile.name}…`),
        el("p", { className: "field-sub" }, "Large books with big chapters can take a few seconds.")
      )
    );
  }

  function showError(message: string): void {
    clear(screen);
    screen.removeAttribute("aria-busy");
    screen.append(
      el("h1", {}, "couldn't import that file"),
      el("p", { className: "text", attrs: { role: "alert" } }, message),
      el(
        "div",
        { className: "button-row" },
        el("button", { className: "button active", on: { click: () => navigate({ name: "library" }) } }, "back to library")
      )
    );
  }

  async function showReview(result: ParseResult): Promise<void> {
    const { book } = result;
    // Parser diagnostics are for engineering and tests, not for the person
    // importing a book. Routine repairs (line-number removal, dehyphenation,
    // block splitting, character cleanup) are successful implementation
    // details. Sections with no typeable text offer no useful choice either.
    const readableSections = book.sections.filter((section) => section.charCount > 0);
    let savedOverrides: Record<string, boolean> = {};
    try {
      savedOverrides = (await getProgress(book.meta.id))?.sectionOverrides ?? {};
    } catch (error) {
      // A review can still be useful if IndexedDB is temporarily unavailable;
      // confirmImport performs the required read again before writing anything.
      console.warn("Couldn't load existing section choices", error);
    }
    if (cancelled) return;

    clear(screen);
    screen.removeAttribute("aria-busy");

    const choice = new Map<string, boolean>(
      readableSections.map((section) => [
        section.id,
        savedOverrides[section.id] ?? section.included,
      ])
    );
    const touched = new Set<string>();
    const rows = new Map<string, { row: HTMLElement; checkbox: HTMLInputElement }>();
    let saving = false;
    let startButton: HTMLButtonElement | undefined;

    const sectionListEl = el("div", {
      className: "section-list",
      attrs: { id: "import-section-list", role: "group", "aria-labelledby": "import-section-label" },
    });
    const summaryEl = el("div", {
      className: "import-summary",
      attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    const saveStatusEl = el("p", {
      className: "field-sub",
      attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });

    function renderSummary(): void {
      const includedCount = [...choice.values()].filter(Boolean).length;
      const totalChars = computeTotalChars(
        book.sections,
        mergeSectionOverrides(book.sections, savedOverrides, choice, touched)
      );
      clear(summaryEl);
      summaryEl.append(
        el("span", {}, `${includedCount} of ${readableSections.length} sections included`),
        el("span", {}, formatChars(totalChars))
      );
      if (startButton) {
        startButton.disabled = saving || includedCount === 0 || totalChars === 0;
        startButton.title =
          includedCount === 0
            ? "Select at least one section"
            : totalChars === 0
              ? "The selected sections contain no typeable characters"
              : "";
      }
    }

    function setChoices(include: (section: Section) => boolean): void {
      for (const section of readableSections) {
        const included = include(section);
        choice.set(section.id, included);
        touched.add(section.id);
        const rendered = rows.get(section.id);
        if (rendered) {
          rendered.checkbox.checked = included;
          rendered.row.classList.toggle("excluded", !included);
        }
      }
      renderSummary();
    }

    function setReviewControlsDisabled(disabled: boolean): void {
      for (const control of screen.querySelectorAll("button, input")) {
        if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) {
          control.disabled = disabled;
        }
      }
    }

    function renderRow(section: Section): HTMLElement {
      const row = el("label", {
        className: `section-row ${choice.get(section.id) ? "" : "excluded"}`.trim(),
      });
      const checkbox = el("input", {
        attrs: { type: "checkbox" },
        checked: choice.get(section.id) ?? false,
        on: {
          change: () => {
            choice.set(section.id, checkbox.checked);
            touched.add(section.id);
            row.classList.toggle("excluded", !checkbox.checked);
            renderSummary();
          },
        },
      }) as HTMLInputElement;
      const label = kindLabel(section);
      row.append(
        checkbox,
        el("span", { className: "section-title" }, section.title || `Section ${section.order + 1}`)
      );
      if (label) row.appendChild(el("span", { className: "section-kind" }, label));
      row.appendChild(el("span", { className: "section-chars" }, formatChars(section.charCount)));
      rows.set(section.id, { row, checkbox });
      return row;
    }

    for (const section of [...readableSections].sort((a, b) => a.order - b.order)) {
      sectionListEl.appendChild(renderRow(section));
    }
    renderSummary();

    const selectionControls = el(
      "div",
      { className: "button-row", attrs: { "aria-label": "Choose sections" } },
      el(
        "button",
        {
          className: "button text",
          attrs: { type: "button", "aria-controls": "import-section-list" },
          on: { click: () => setChoices(() => true) },
        },
        "all"
      ),
      el(
        "button",
        {
          className: "button text",
          attrs: { type: "button", "aria-controls": "import-section-list" },
          on: { click: () => setChoices((section) => section.kind === "body") },
        },
        "main text"
      ),
      el(
        "button",
        {
          className: "button text",
          attrs: { type: "button", "aria-controls": "import-section-list" },
          on: { click: () => setChoices(() => false) },
        },
        "none"
      )
    );
    const cancelButton = el(
      "button",
      {
        className: "button text",
        attrs: { type: "button" },
        on: { click: () => navigate({ name: "library" }) },
      },
      "cancel"
    );
    startButton = el(
      "button",
      {
        className: "button active",
        attrs: { type: "button" },
        on: {
          click: () => {
            if (saving || !startButton || startButton.disabled) return;
            saving = true;
            setReviewControlsDisabled(true);
            screen.setAttribute("aria-busy", "true");
            saveStatusEl.textContent = "Saving your book…";
            // Freeze the deliberate choices at click time. Even if a browser
            // dispatches an already-queued change event while IndexedDB is
            // opening, the saved selection remains the one the button showed.
            void confirmImport(book, selectedFile, new Map(choice), new Set(touched)).catch(() => {
              saving = false;
              setReviewControlsDisabled(false);
              screen.removeAttribute("aria-busy");
              saveStatusEl.textContent = "The book wasn't saved. You can try again.";
              renderSummary();
            });
          },
        },
      },
      iconSpan("check"),
      "start typing"
    );

    screen.append(
      el("h1", {}, book.meta.title || "untitled book"),
      el("p", { className: "field-sub" }, book.meta.author || "Unknown author")
    );
    screen.append(
      el("p", { className: "field-label", attrs: { id: "import-section-label" } }, "sections to include"),
      selectionControls,
      sectionListEl,
      summaryEl,
      el(
        "div",
        { className: "button-row" },
        cancelButton,
        startButton
      ),
      saveStatusEl
    );
    renderSummary();
  }

  async function confirmImport(
    book: ParsedBook,
    raw: File,
    choice: Map<string, boolean>,
    touched: Set<string>
  ): Promise<void> {
    try {
      // Re-read immediately before the write so a reimport never replaces a
      // synced/local reading position or accumulated statistics with zeros.
      const existing = await getProgress(book.meta.id);
      const overrides = mergeSectionOverrides(
        book.sections,
        existing?.sectionOverrides ?? {},
        choice,
        touched
      );
      const totalChars = computeTotalChars(book.sections, overrides);
      if (totalChars === 0) throw new Error("No typeable characters are selected.");
      const progress = existing
        ? {
            ...existing,
            totalChars,
            sectionOverrides: overrides,
            updatedAt: Date.now(),
          }
        : createInitialProgress(book.meta.id, totalChars, overrides);
      await addBook(book, raw);
      await saveProgress(progress);
      showToast(`Added "${book.meta.title}" to your library.`, "success");
      navigate({ name: "reader", bookId: book.meta.id });
    } catch (err) {
      console.error("Failed to save imported book", err);
      showToast("Couldn't save that book to storage.", "error");
      throw err;
    }
  }

  if (!isSupportedBookFile(selectedFile)) {
    showError("Choose a supported book file: .epub · .pdf · .txt · .md · .html");
    return {};
  }

  showProgress();
  screen.setAttribute("aria-busy", "true");
  const settings = getAppState().settings;
  parseBookFile(selectedFile, { foldAccents: settings.foldAccents })
    .then((result) => {
      if (cancelled) return;
      if (!result.book.sections.some((section) => section.charCount > 0)) {
        showError("This book doesn't contain any readable text.");
        return;
      }
      void showReview(result).catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to prepare import review", error);
        showError("The book was parsed, but its saved section choices couldn't be loaded.");
      });
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      console.error("Book import failed", err);
      showError(parseErrorMessage(err));
    });

  return {
    unmount: () => {
      cancelled = true;
    },
  };
}

function mergeSectionOverrides(
  sections: Section[],
  existing: Record<string, boolean>,
  choice: Map<string, boolean>,
  touched: Set<string>
): Record<string, boolean> {
  const overrides = { ...existing };
  for (const s of sections) {
    if (!touched.has(s.id)) continue;
    const value = choice.get(s.id) ?? s.included;
    if (value === s.included) {
      delete overrides[s.id];
    } else {
      overrides[s.id] = value;
    }
  }
  return overrides;
}
