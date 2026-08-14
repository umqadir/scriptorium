import { TypingSession, calculateAccuracy, calculateWpm } from "../engine";
import { getBook, type StoredBook } from "../store/books";
import {
  accumulateLifetime,
  applyProgressUpdate,
  applySectionOverride,
  computeTotalChars,
  createInitialProgress,
  getProgress,
  isSectionIncluded,
  resolveSections,
  saveProgress,
} from "../store/progress";
import type { BookProgress, ParsedBook, Position, Section, SessionStats } from "../types";
import { clear, el, formatDuration, formatPercent } from "./dom";
import { icons, iconSpan } from "./icons";
import { navigate } from "./router";
import { getAppState } from "./state";
import { showToast } from "./toast";
import "./reader.css";

export type ScreenHandle = { unmount?: () => void };

type SessionTotals = {
  charsTyped: number;
  errors: number;
  timeMs: number;
  consistencyTimeTotal: number;
};

const EMPTY_TOTALS: SessionTotals = {
  charsTyped: 0,
  errors: 0,
  timeMs: 0,
  consistencyTimeTotal: 0,
};

const ACTIVE_READER_HINT = "enter at ¶ · esc to pause";

function sectionTitle(section: Section | undefined, index: number): string {
  return section?.title || `Section ${index + 1}`;
}

function charsAtPosition(book: ParsedBook, position: Position): number {
  let total = 0;
  for (let sectionIndex = 0; sectionIndex < book.sections.length; sectionIndex += 1) {
    const section = book.sections[sectionIndex]!;
    if (!section.included) continue;
    if (sectionIndex < position.sectionIndex) {
      total += section.charCount;
      continue;
    }
    if (sectionIndex > position.sectionIndex) break;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex += 1) {
      const block = section.blocks[blockIndex]!;
      if (blockIndex < position.blockIndex) total += block.text.length;
      else if (blockIndex === position.blockIndex) {
        total += Math.max(0, Math.min(position.charIndex, block.text.length));
        break;
      } else break;
    }
    break;
  }
  return total;
}

function firstIncludedPosition(book: ParsedBook): Position {
  const sectionIndex = book.sections.findIndex(
    (section) => section.included && section.blocks.some((block) => block.text.length > 0)
  );
  return { sectionIndex: Math.max(0, sectionIndex), blockIndex: 0, charIndex: 0 };
}

function runtimeSections(
  sections: Section[],
  overrides: Record<string, boolean>
): Section[] {
  return resolveSections(sections, overrides).map((section) => ({
    ...section,
    // The engine requires an included section to contain a real block. Keep
    // the user's override intact in storage, but don't route through an empty
    // EPUB spine item at runtime.
    included:
      section.included && section.blocks.some((block) => block.text.length > 0),
  }));
}

function hasTypeableSection(book: ParsedBook): boolean {
  return book.sections.some(
    (section) => section.included && section.blocks.some((block) => block.text.length > 0)
  );
}

function statsFromTotals(totals: SessionTotals): SessionStats {
  const correct = Math.max(0, totals.charsTyped - totals.errors);
  return {
    wpm: calculateWpm(correct, totals.timeMs),
    rawWpm: calculateWpm(totals.charsTyped, totals.timeMs),
    accuracy: calculateAccuracy(correct, totals.charsTyped),
    consistency:
      totals.timeMs > 0 ? totals.consistencyTimeTotal / totals.timeMs : 0,
    charsTyped: totals.charsTyped,
    errors: totals.errors,
    elapsedMs: totals.timeMs,
  };
}

/**
 * Mount the local-only reader. Loading is intentionally asynchronous behind
 * a synchronous handle so the router can cancel an obsolete mount while its
 * IndexedDB reads are still in flight.
 */
export function mountReader(container: HTMLElement, bookId: string): ScreenHandle {
  clear(container);

  let cancelled = false;
  let storedBook: StoredBook | undefined;
  let runtimeBook: ParsedBook | undefined;
  let progress: BookProgress | undefined;
  let session: TypingSession | null = null;
  let sessionGeneration = 0;
  let unsubscribeSettings: (() => void) | undefined;
  let chooser: HTMLElement | null = null;
  let lifetimeFinalized = false;
  let finalStats: SessionStats | undefined;
  let segmentTotals: SessionTotals = { ...EMPTY_TOTALS };
  let peakWpm = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let chooserResumePosition: Position | undefined;
  let pausedPosition: Position | undefined;
  let audioContext: AudioContext | undefined;
  let overlayReturnFocus: HTMLElement | null = null;
  let overlayInterruptedSession = false;

  const shell = el("section", { className: "reader-shell", attrs: { "aria-live": "off" } });
  const loading = el(
    "div",
    { className: "reader-loading", attrs: { role: "status" } },
    el("div", { className: "spinner", attrs: { role: "presentation" } }),
    el("p", {}, "Opening your book…")
  );
  shell.appendChild(loading);
  container.appendChild(shell);

  const queueSave = (snapshot: BookProgress): void => {
    saveChain = saveChain
      .then(() => saveProgress(snapshot))
      .catch((error: unknown) => {
        console.error("Failed to save reader progress", error);
        if (!cancelled) showToast("Couldn't save your reading progress.", "error");
      });
  };

  const persistProgress = (
    position: Position,
    charsCompleted: number,
    wpm?: number,
    shouldQueue = true
  ): void => {
    if (!progress) return;
    progress = applyProgressUpdate(progress, { position, charsCompleted, wpm });
    if (shouldQueue) queueSave(progress);
  };

  let bookTitleEl: HTMLElement;
  let currentSectionEl: HTMLButtonElement;
  let progressFillEl: HTMLElement;
  let progressBarEl: HTMLElement;
  let wpmValueEl: HTMLElement;
  let accuracyValueEl: HTMLElement;
  let statsEl: HTMLElement;
  let typingHost: HTMLElement;
  let hintEl: HTMLElement;
  let latestStats: SessionStats | undefined;

  const updateChrome = (
    position: Position,
    charsCompleted: number,
    stats?: SessionStats
  ): void => {
    if (!runtimeBook || !progress || !bookTitleEl) return;
    bookTitleEl.textContent = runtimeBook.meta.title || "Untitled book";
    currentSectionEl.textContent = sectionTitle(
      runtimeBook.sections[position.sectionIndex],
      position.sectionIndex
    );
    const percent =
      progress.totalChars > 0
        ? Math.max(0, Math.min(100, (charsCompleted / progress.totalChars) * 100))
        : 0;
    progressFillEl.style.width = `${percent}%`;
    progressBarEl.setAttribute("aria-valuenow", String(Math.round(percent)));
    progressBarEl.setAttribute("aria-valuetext", `${Math.round(percent)}% complete`);
    if (stats) {
      latestStats = stats;
      wpmValueEl.textContent = String(Math.round(stats.wpm));
      accuracyValueEl.textContent = formatPercent(stats.accuracy);
      statsEl.hidden = !getAppState().settings.showLiveWpm || stats.charsTyped === 0;
    }
  };

  const addSegment = (stats: SessionStats): void => {
    segmentTotals = {
      charsTyped: segmentTotals.charsTyped + stats.charsTyped,
      errors: segmentTotals.errors + stats.errors,
      timeMs: segmentTotals.timeMs + stats.elapsedMs,
      consistencyTimeTotal:
        segmentTotals.consistencyTimeTotal + stats.consistency * stats.elapsedMs,
    };
    peakWpm = Math.max(peakWpm, stats.wpm);
  };

  const stopCurrentSegment = (): { position: Position; stats: SessionStats } | undefined => {
    const current = session;
    if (!current) return undefined;
    sessionGeneration += 1;
    current.pause();
    const position = current.getPosition();
    const stats = current.getStats();
    addSegment(stats);
    if (runtimeBook && progress) {
      persistProgress(position, charsAtPosition(runtimeBook, position), stats.wpm);
    }
    current.destroy();
    session = null;
    return { position, stats };
  };

  const finalizeLifetime = (completed: boolean): SessionStats => {
    if (lifetimeFinalized && finalStats) return finalStats;

    const stopped = stopCurrentSegment();
    const combined = statsFromTotals(segmentTotals);
    peakWpm = Math.max(peakWpm, combined.wpm);
    finalStats = combined;
    lifetimeFinalized = true;

    if (progress && runtimeBook) {
      const position = stopped?.position ?? progress.position;
      const charsCompleted = completed
        ? progress.totalChars
        : charsAtPosition(runtimeBook, position);
      progress = applyProgressUpdate(progress, {
        position,
        charsCompleted,
        wpm: peakWpm,
      });
      // Merely opening and closing a book is not a typing session. Once at
      // least one key was recorded, fold the aggregate exactly once.
      if (combined.charsTyped > 0) {
        progress = accumulateLifetime(progress, {
          charsTyped: combined.charsTyped,
          errors: combined.errors,
          timeMs: combined.elapsedMs,
        });
      }
      queueSave(progress);
      if (!cancelled) updateChrome(position, charsCompleted, combined);
    }
    return combined;
  };

  const renderCompletion = (stats?: SessionStats): void => {
    if (!progress || !runtimeBook || cancelled) return;
    clear(typingHost);
    shell.classList.remove("reader-focused");
    const shown = stats;
    const lifetime = progress.lifetime;
    const lifetimeAccuracy = calculateAccuracy(
      Math.max(0, lifetime.charsTyped - lifetime.errors),
      lifetime.charsTyped
    );
    const displayWpm = shown?.wpm || progress.bestWpm;
    const displayAccuracy = shown?.accuracy ?? lifetimeAccuracy;
    const displayTime = shown?.elapsedMs ?? lifetime.timeMs;

    typingHost.appendChild(
      el(
        "div",
        { className: "reader-complete", attrs: { role: "status" } },
        iconSpan("check", "reader-complete-icon"),
        el("p", { className: "reader-complete-kicker" }, "book complete"),
        el("h1", {}, runtimeBook.meta.title || "Untitled book"),
        el(
          "div",
          { className: "results-grid" },
          el(
            "div",
            { className: "results-stat" },
            el("span", { className: "value" }, String(Math.round(displayWpm))),
            el("span", { className: "label" }, shown ? "wpm" : "best wpm")
          ),
          el(
            "div",
            { className: "results-stat" },
            el("span", { className: "value" }, formatPercent(displayAccuracy)),
            el("span", { className: "label" }, "accuracy")
          ),
          el(
            "div",
            { className: "results-stat" },
            el("span", { className: "value" }, formatDuration(displayTime)),
            el("span", { className: "label" }, shown ? "session" : "lifetime")
          )
        ),
        el(
          "div",
          { className: "button-row reader-complete-actions" },
          el(
            "button",
            {
              className: "button active",
              attrs: { type: "button" },
              on: {
                click: async (event: Event) => {
                  const button = event.currentTarget as HTMLButtonElement;
                  button.disabled = true;
                  const start = firstIncludedPosition(runtimeBook!);
                  persistProgress(start, 0, undefined);
                  await saveChain;
                  if (!cancelled) navigate({ name: "reader", bookId });
                },
              },
            },
            "type again"
          ),
          el(
            "button",
            {
              className: "button text",
              attrs: { type: "button" },
              on: { click: () => navigate({ name: "library" }) },
            },
            "back to library"
          )
        )
      )
    );
    hintEl.textContent = "";
  };

  const closeChooser = (showPausedResults = true): void => {
    const returnFocus = overlayReturnFocus;
    const interrupted = overlayInterruptedSession;
    chooser?.remove();
    chooser = null;
    overlayReturnFocus = null;
    overlayInterruptedSession = false;
    if (showPausedResults && interrupted && !lifetimeFinalized) {
      renderSessionResults();
    }
    returnFocus?.focus();
  };

  const startSession = (startAt: Position): void => {
    if (!runtimeBook || !progress || cancelled || lifetimeFinalized) return;
    clear(typingHost);
    const generation = ++sessionGeneration;
    let created: TypingSession;
    created = new TypingSession({
      book: runtimeBook,
      container: typingHost,
      settings: getAppState().settings,
      startAt,
      onProgress: (position, charsCompleted) => {
        if (cancelled || generation !== sessionGeneration) return;
        const stats = created.getStats();
        peakWpm = Math.max(peakWpm, stats.wpm);
        persistProgress(position, charsCompleted, stats.wpm);
        updateChrome(position, charsCompleted, stats);
      },
      onStats: (stats) => {
        if (cancelled || generation !== sessionGeneration) return;
        peakWpm = Math.max(peakWpm, stats.wpm);
        updateChrome(created.getPosition(), charsAtPosition(runtimeBook!, created.getPosition()), stats);
      },
      onSectionComplete: () => {
        if (cancelled || generation !== sessionGeneration) return;
        queueMicrotask(() => {
          if (cancelled || generation !== sessionGeneration) return;
          const position = created.getPosition();
          updateChrome(position, charsAtPosition(runtimeBook!, position), created.getStats());
        });
      },
      onBookComplete: () => {
        if (cancelled || generation !== sessionGeneration) return;
        const stats = finalizeLifetime(true);
        renderCompletion(stats);
      },
    });
    session = created;
    const normalized = created.getPosition();
    const absoluteChars = charsAtPosition(runtimeBook, normalized);
    progress = { ...progress, totalChars: computeTotalChars(runtimeBook.sections, {}) };
    persistProgress(normalized, absoluteChars, undefined);
    updateChrome(normalized, absoluteChars, created.getStats());
    created.start();
  };

  const renderNoSections = (): void => {
    if (cancelled) return;
    clear(typingHost);
    typingHost.appendChild(
      el(
        "div",
        { className: "reader-no-sections" },
        el("h2", {}, "No sections are included"),
        el("p", {}, "Choose at least one section to start typing."),
        el(
          "button",
          { className: "button active", attrs: { type: "button" }, on: { click: () => openInclusionEditor() } },
          "choose sections"
        )
      )
    );
    hintEl.textContent = "You can include front matter, body chapters, or appendices.";
  };

  const applySectionChoices = (choices: Map<string, boolean>): void => {
    if (!storedBook || !progress) return;
    const wasFinalized = lifetimeFinalized;
    const stopped = stopCurrentSegment();
    let updated = progress;
    for (const section of storedBook.sections) {
      const selected = choices.get(section.id) ?? section.included;
      updated = applySectionOverride(updated, section.id, selected, section.included);
    }
    updated = {
      ...updated,
      totalChars: computeTotalChars(storedBook.sections, updated.sectionOverrides),
    };
    runtimeBook = {
      meta: storedBook.meta,
      sections: runtimeSections(storedBook.sections, updated.sectionOverrides),
    };
    progress = {
      ...updated,
      totalChars: computeTotalChars(runtimeBook.sections, {}),
    };
    progress = {
      ...progress,
      charsCompleted: Math.min(
        progress.totalChars,
        charsAtPosition(runtimeBook, progress.position)
      ),
    };
    closeChooser(false);

    if (!hasTypeableSection(runtimeBook)) {
      queueSave(progress);
      renderNoSections();
      return;
    }
    const currentAbsolute = charsAtPosition(runtimeBook, progress.position);
    if (wasFinalized && currentAbsolute >= progress.totalChars) {
      queueSave(progress);
      updateChrome(progress.position, progress.totalChars);
      renderCompletion();
      return;
    }
    if (wasFinalized) {
      lifetimeFinalized = false;
      finalStats = undefined;
      segmentTotals = { ...EMPTY_TOTALS };
      peakWpm = 0;
    }
    const requested =
      stopped?.position ?? chooserResumePosition ?? progress.position;
    chooserResumePosition = undefined;
    pausedPosition = undefined;
    startSession(requested);
  };

  const sectionProgressLabel = (sectionIndex: number, position: Position): string => {
    if (!runtimeBook) return "not started";
    if (sectionIndex < position.sectionIndex) return "complete";
    if (sectionIndex > position.sectionIndex) return "not started";
    const section = runtimeBook.sections[sectionIndex];
    if (!section || section.charCount <= 0) return "current";
    let chars = 0;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex += 1) {
      const block = section.blocks[blockIndex]!;
      if (blockIndex < position.blockIndex) chars += block.text.length;
      else if (blockIndex === position.blockIndex) {
        chars += Math.min(position.charIndex, block.text.length);
        break;
      } else break;
    }
    return `current · ${Math.round((chars / section.charCount) * 100)}%`;
  };

  const jumpToSection = async (sectionIndex: number): Promise<void> => {
    if (!runtimeBook || !progress) return;
    const wasFinalized = lifetimeFinalized;
    const target = { sectionIndex, blockIndex: 0, charIndex: 0 };
    closeChooser(false);
    // Opening contents stops the active engine and queues its exact outgoing
    // position. Do not start the new engine until that snapshot is durable.
    await saveChain;
    if (cancelled) return;
    if (wasFinalized) {
      lifetimeFinalized = false;
      finalStats = undefined;
      segmentTotals = { ...EMPTY_TOTALS };
      peakWpm = 0;
    }
    chooserResumePosition = undefined;
    pausedPosition = undefined;
    startSession(target);
  };

  function openContents(returnFocus = document.activeElement as HTMLElement | null): void {
    if (!runtimeBook || !progress || chooser) return;
    const stopped = stopCurrentSegment();
    const currentPosition = stopped?.position ?? pausedPosition ?? progress.position;
    if (stopped) pausedPosition = stopped.position;
    chooserResumePosition = currentPosition;
    overlayInterruptedSession = stopped !== undefined;
    overlayReturnFocus = returnFocus;
    shell.classList.remove("reader-focused");

    const entries = runtimeBook.sections
      .map((section, index) => ({ section, index }))
      .filter(
        ({ section }) =>
          section.included && section.blocks.some((block) => block.text.length > 0)
      )
      .sort((a, b) => a.section.order - b.section.order);
    const list = el("nav", {
      className: "reader-contents-list ffscroll",
      attrs: { "aria-label": "Book contents" },
    });
    let currentButton: HTMLButtonElement | undefined;
    for (const [entryIndex, { section, index }] of entries.entries()) {
      const isCurrent = index === currentPosition.sectionIndex;
      const button = el(
        "button",
        {
          className: `reader-contents-item${isCurrent ? " current" : ""}`,
          attrs: {
            type: "button",
            ...(isCurrent ? { "aria-current": "location" } : {}),
          },
          on: {
            click: (event: Event) => {
              const selected = event.currentTarget as HTMLButtonElement;
              selected.disabled = true;
              void jumpToSection(index);
            },
          },
        },
        el("span", { className: "reader-contents-order" }, String(entryIndex + 1).padStart(2, "0")),
        el("span", { className: "reader-contents-name" }, sectionTitle(section, index)),
        el("span", { className: "reader-contents-progress" }, sectionProgressLabel(index, currentPosition))
      );
      if (isCurrent) currentButton = button;
      list.appendChild(button);
    }

    const titleId = `reader-contents-${bookId}`;
    const panel = el(
      "div",
      {
        className: "reader-chooser-panel reader-contents-panel",
        attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
      },
      el(
        "div",
        { className: "reader-chooser-heading" },
        el(
          "div",
          {},
          el("h2", { attrs: { id: titleId } }, "contents"),
          el("p", { className: "reader-chooser-summary" }, `${entries.length} included section${entries.length === 1 ? "" : "s"}`)
        ),
        el("button", {
          className: "icon-button",
          attrs: { type: "button", "aria-label": "Close contents" },
          on: { click: () => closeChooser() },
          html: icons.x,
        })
      ),
      list,
      el(
        "div",
        { className: "reader-contents-footer" },
        el(
          "button",
          {
            className: "button text reader-edit-included",
            attrs: { type: "button" },
            on: {
              click: () => {
                const returnTo = overlayReturnFocus;
                const interrupted = overlayInterruptedSession;
                closeChooser(false);
                openInclusionEditor(returnTo, interrupted);
              },
            },
          },
          "edit included sections"
        )
      )
    );
    chooser = el(
      "div",
      {
        className: "reader-chooser-backdrop",
        on: {
          mousedown: (event: Event) => {
            if (event.target === chooser) closeChooser();
          },
        },
      },
      panel
    );
    document.body.appendChild(chooser);
    (currentButton ?? (panel.querySelector("button") as HTMLButtonElement | null))?.focus();
  }

  function openInclusionEditor(
    returnFocus = document.activeElement as HTMLElement | null,
    inheritedInterruption = false
  ): void {
    if (!storedBook || !progress || chooser) return;
    const stopped = stopCurrentSegment();
    chooserResumePosition = stopped?.position ?? pausedPosition;
    if (stopped) pausedPosition = stopped.position;
    overlayInterruptedSession = stopped !== undefined || inheritedInterruption;
    overlayReturnFocus = returnFocus;
    shell.classList.remove("reader-focused");
    const choices = new Map(
      storedBook.sections.map((section) => [
        section.id,
        isSectionIncluded(section, progress!.sectionOverrides),
      ])
    );
    const list = el("div", { className: "reader-section-list ffscroll" });
    const summary = el("p", { className: "reader-chooser-summary" });
    const applyButton = el("button", {
      className: "button active",
      attrs: { type: "button" },
      on: { click: () => applySectionChoices(choices) },
    }) as HTMLButtonElement;
    applyButton.textContent = "apply";

    const refreshSummary = (): void => {
      const count = [...choices.values()].filter(Boolean).length;
      const typeableCount = storedBook!.sections.filter(
        (section) =>
          choices.get(section.id) && section.blocks.some((block) => block.text.length > 0)
      ).length;
      summary.textContent = `${count} of ${storedBook!.sections.length} sections included`;
      applyButton.disabled = typeableCount === 0;
    };

    for (const [index, section] of storedBook.sections.entries()) {
      const checkbox = el("input", {
        attrs: { type: "checkbox", "aria-label": `Include ${sectionTitle(section, index)}` },
        checked: choices.get(section.id) ?? false,
      }) as HTMLInputElement;
      const details = el(
        "div",
        { className: "reader-section-details" },
        el("span", { className: "reader-section-name" }, sectionTitle(section, index)),
        el("span", { className: "reader-section-meta" }, `${section.kind} · ${section.charCount.toLocaleString()} chars`)
      );
      checkbox.addEventListener("change", () => {
        choices.set(section.id, checkbox.checked);
        row.classList.toggle("excluded", !checkbox.checked);
        refreshSummary();
      });
      const row = el(
        "div",
        { className: `reader-section-row${checkbox.checked ? "" : " excluded"}` },
        checkbox,
        details
      );
      list.appendChild(row);
    }
    refreshSummary();

    const titleId = `reader-included-sections-${bookId}`;
    const panel = el(
      "div",
      {
        className: "reader-chooser-panel",
        attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
      },
      el(
        "div",
        { className: "reader-chooser-heading" },
        el("div", {}, el("h2", { attrs: { id: titleId } }, "included sections"), summary),
        el("button", {
          className: "icon-button",
          attrs: { type: "button", "aria-label": "Close included sections" },
          on: { click: () => closeChooser() },
          html: icons.x,
        })
      ),
      list,
      el(
        "div",
        { className: "button-row reader-chooser-actions" },
        el(
          "button",
          { className: "button text", attrs: { type: "button" }, on: { click: () => closeChooser() } },
          "cancel"
        ),
        applyButton
      )
    );
    chooser = el("div", {
      className: "reader-chooser-backdrop",
      on: {
        mousedown: (event: Event) => {
          if (event.target === chooser) closeChooser();
        },
      },
    }, panel);
    document.body.appendChild(chooser);
    (panel.querySelector("button") as HTMLButtonElement | null)?.focus();
  }

  const renderSessionResults = (): void => {
    if (!runtimeBook || !progress || cancelled) return;
    const stats = statsFromTotals(segmentTotals);
    latestStats = stats;
    clear(typingHost);
    shell.classList.remove("reader-focused");
    typingHost.appendChild(
      el(
        "section",
        { className: "reader-session-results", attrs: { "aria-labelledby": "session-results-title" } },
        el("h2", { attrs: { id: "session-results-title" } }, "session paused"),
        el(
          "div",
          { className: "results-grid reader-session-primary" },
          el(
            "div",
            { className: "results-stat" },
            el("span", { className: "value" }, String(Math.round(stats.wpm))),
            el("span", { className: "label" }, "wpm")
          ),
          el(
            "div",
            { className: "results-stat" },
            el("span", { className: "value" }, formatPercent(stats.accuracy)),
            el("span", { className: "label" }, "accuracy")
          )
        ),
        el(
          "div",
          { className: "reader-session-details" },
          el("div", {}, el("span", { className: "label" }, "raw"), el("span", {}, `${Math.round(stats.rawWpm)} wpm`)),
          el("div", {}, el("span", { className: "label" }, "consistency"), el("span", {}, formatPercent(stats.consistency))),
          el("div", {}, el("span", { className: "label" }, "characters"), el("span", {}, `${Math.max(0, stats.charsTyped - stats.errors)}/${stats.errors}`)),
          el("div", {}, el("span", { className: "label" }, "time"), el("span", {}, formatDuration(stats.elapsedMs)))
        ),
        el(
          "div",
          { className: "button-row reader-session-actions" },
          el(
            "button",
            {
              className: "button active",
              attrs: { type: "button" },
              on: {
                click: () => {
                  const resumeAt = pausedPosition ?? progress!.position;
                  pausedPosition = undefined;
                  startSession(resumeAt);
                  hintEl.textContent = ACTIVE_READER_HINT;
                },
              },
            },
            "resume"
          ),
          el(
            "button",
            {
              className: "button text",
              attrs: { type: "button" },
              on: { click: () => navigate({ name: "library" }) },
            },
            "library"
          )
        )
      )
    );
    hintEl.textContent = "your exact place is saved";
  };

  const pauseSession = (): void => {
    if (!session) return;
    pausedPosition = stopCurrentSegment()?.position;
    renderSessionResults();
  };

  const buildReader = (): void => {
    clear(shell);
    bookTitleEl = el("span", { className: "reader-book-title" });
    currentSectionEl = el("button", {
      className: "reader-section-title",
      attrs: { type: "button", title: "Open table of contents", "aria-label": "Open table of contents" },
      on: { click: () => openContents() },
    });
    progressFillEl = el("div", { className: "reader-progress-fill" });
    progressBarEl = el(
      "div",
      {
        className: "reader-progress-bar",
        attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" },
      },
      progressFillEl
    );
    wpmValueEl = el("span", { className: "stat-value" }, "0");
    accuracyValueEl = el("span", { className: "stat-value" }, "100%");
    statsEl = el(
      "div",
      { className: "reader-live-stats", attrs: { "aria-live": "polite" } },
      el("span", {}, wpmValueEl, " wpm"),
      el("span", {}, accuracyValueEl, " accuracy")
    );
    typingHost = el("div", {
      className: "typing-container",
      on: {
        click: () => {
          if (!session && pausedPosition && !lifetimeFinalized) {
            const resumeAt = pausedPosition;
            pausedPosition = undefined;
            startSession(resumeAt);
          } else {
            session?.resume();
          }
          hintEl.textContent = ACTIVE_READER_HINT;
        },
        keydown: (event: Event) => {
          const key = event as KeyboardEvent;
          if (key.key.length === 1 || key.key === "Backspace" || key.key === "Enter") {
            shell.classList.add("reader-focused");
            playTypingClick();
          }
        },
      },
    });
    hintEl = el("p", { className: "reader-hint" }, ACTIVE_READER_HINT);
    const chrome = el(
      "div",
      { className: "reader-chrome" },
      el(
        "div",
        { className: "reader-topbar" },
        el("button", {
          className: "icon-button",
          attrs: { type: "button", "aria-label": "Back to library" },
          on: { click: () => navigate({ name: "library" }) },
          html: icons.arrowLeft,
        }),
        el("div", { className: "reader-titles" }, bookTitleEl, currentSectionEl),
        el(
          "div",
          { className: "reader-actions" },
          el(
            "button",
            {
              className: "reader-contents-control",
              attrs: { type: "button", "aria-label": "Open table of contents" },
              on: { click: () => openContents() },
            },
            iconSpan("list"),
            el("span", {}, "contents")
          ),
          el("button", {
            className: "icon-button",
            attrs: { type: "button", "aria-label": "Pause and view session results" },
            on: { click: pauseSession },
            html: icons.pause,
          }),
          el("button", {
            className: "icon-button",
            attrs: { type: "button", "aria-label": "Open settings" },
            on: { click: () => navigate({ name: "settings" }) },
            html: icons.gear,
          })
        )
      ),
      progressBarEl,
      statsEl
    );
    shell.append(chrome, typingHost, hintEl);
    shell.addEventListener("pointermove", () => shell.classList.remove("reader-focused"));
    statsEl.hidden = true;
  };

  const showMissingBook = (loadFailed = false): void => {
    if (cancelled) return;
    clear(shell);
    shell.append(
      el("h1", {}, loadFailed ? "Couldn't open that book" : "Book not found"),
      el(
        "p",
        { className: "reader-error-copy" },
        loadFailed
          ? "Your local library couldn't be read. Try again, or return to the library."
          : "This book is no longer in your local library. It may have been removed on this device."
      ),
      el(
        "button",
        { className: "button active reader-error-action", on: { click: () => navigate({ name: "library" }) } },
        "back to library"
      )
    );
  };

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (chooser) {
      event.preventDefault();
      closeChooser();
      return;
    }
    if (session) {
      pauseSession();
    }
  };

  const playTypingClick = (): void => {
    if (!getAppState().settings.soundOnClick) return;
    try {
      audioContext ??= new AudioContext();
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(680, now);
      gain.gain.setValueAtTime(0.018, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.02);
    } catch {
      // Audio can be unavailable in embedded/private contexts. Typing stays
      // fully functional and we retry only after another user gesture.
    }
  };
  document.addEventListener("keydown", onDocumentKeydown);

  void (async () => {
    try {
      const [book, saved] = await Promise.all([getBook(bookId), getProgress(bookId)]);
      if (cancelled) return;
      if (!book) {
        showMissingBook();
        return;
      }
      storedBook = book;
      const initial = saved ?? createInitialProgress(bookId, computeTotalChars(book.sections, {}));
      const totalChars = computeTotalChars(book.sections, initial.sectionOverrides);
      progress = { ...initial, totalChars };
      runtimeBook = {
        meta: book.meta,
        sections: runtimeSections(book.sections, initial.sectionOverrides),
      };
      progress = {
        ...progress,
        totalChars: computeTotalChars(runtimeBook.sections, {}),
      };
      buildReader();
      unsubscribeSettings = getAppState().subscribe((settings) => {
        if (cancelled) return;
        session?.applySettings(settings);
        statsEl.hidden =
          !settings.showLiveWpm || !latestStats || latestStats.charsTyped === 0;
      });

      if (!hasTypeableSection(runtimeBook)) {
        updateChrome(progress.position, 0);
        renderNoSections();
        return;
      }
      const totalAtSavedPosition = charsAtPosition(runtimeBook, progress.position);
      if (progress.totalChars > 0 && totalAtSavedPosition >= progress.totalChars) {
        lifetimeFinalized = true;
        updateChrome(progress.position, progress.totalChars);
        renderCompletion();
        return;
      }
      startSession(progress.position);
    } catch (error) {
      console.error("Failed to mount reader", error);
      showMissingBook(true);
    }
  })();

  return {
    unmount: () => {
      if (cancelled) return;
      cancelled = true;
      document.removeEventListener("keydown", onDocumentKeydown);
      chooser?.remove();
      chooser = null;
      unsubscribeSettings?.();
      unsubscribeSettings = undefined;
      if (!lifetimeFinalized) finalizeLifetime(false);
      else {
        session?.destroy();
        session = null;
      }
      if (audioContext) void audioContext.close();
    },
  };
}
