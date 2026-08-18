import {
  TypingSession,
  calculateAccuracy,
  calculateWpm,
  isValidLessonAnchor,
  lessonCorpusSignature,
  makeLessonAnchor,
  reconstructRecentLessonAnchors,
} from "../engine";
import { getBook, type StoredBook } from "../store/books";
import {
  LESSON_HISTORY_LIMIT,
  getLessonNavigation,
  saveReaderCheckpoint,
} from "../store/lesson-navigation";
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
import {
  LESSON_LENGTH_STEP,
  MAX_LESSON_LENGTH,
  MIN_LESSON_LENGTH,
  normalizeLessonLength,
  type BookProgress,
  type LessonAnchor,
  type LessonHistoryRecord,
  type LessonNavigationState,
  type ParsedBook,
  type Position,
  type Section,
  type SessionStats,
} from "../types";
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
const READER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableReaderElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(READER_FOCUSABLE_SELECTOR)).filter(
    (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true"
  );
}

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

function positionsEqual(a: Position, b: Position): boolean {
  return (
    a.sectionIndex === b.sectionIndex &&
    a.blockIndex === b.blockIndex &&
    a.charIndex === b.charIndex
  );
}

function comparePositions(a: Position, b: Position): number {
  return a.sectionIndex - b.sectionIndex ||
    a.blockIndex - b.blockIndex ||
    a.charIndex - b.charIndex;
}

/** Active lesson ranges are half-open. A durable cursor at `end` has already
 * completed this frontier and must seed/mount the next passage on reload. */
function positionInActiveAnchor(position: Position, anchor: LessonAnchor): boolean {
  return comparePositions(position, anchor.start) >= 0 && comparePositions(position, anchor.end) < 0;
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
  let routeTotals: SessionTotals = { ...EMPTY_TOTALS };
  let peakWpm = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let lessonNavigation: LessonNavigationState | undefined;
  /** Null means the durable frontier; a number indexes prior replay history. */
  let replayHistoryIndex: number | null = null;
  let frontierCursor: Position | undefined;
  let navigationBusy = false;
  let suppressProgressPersistence = false;
  let suppressBookCompletionOnce = false;
  let chooserResumePosition: Position | undefined;
  let pausedPosition: Position | undefined;
  let pausedAnchor: LessonAnchor | undefined;
  let audioContext: AudioContext | undefined;
  let overlayReturnFocus: HTMLElement | null = null;
  let overlayInterruptedSession = false;
  let chooserBackground: Array<{
    node: HTMLElement;
    hadInert: boolean;
    ariaHidden: string | null;
  }> = [];

  const shell = el("section", { className: "reader-shell", attrs: { "aria-live": "off" } });
  const loading = el(
    "div",
    { className: "reader-loading", attrs: { role: "status" } },
    el("div", { className: "spinner", attrs: { role: "presentation" } }),
    el("p", {}, "Opening your book…")
  );
  shell.appendChild(loading);
  container.appendChild(shell);

  const snapshotProgress = (value: BookProgress): BookProgress => ({
    ...value,
    position: { ...value.position },
    lifetime: { ...value.lifetime },
    sectionOverrides: { ...value.sectionOverrides },
  });

  const snapshotNavigation = (
    value: LessonNavigationState
  ): LessonNavigationState => ({
    bookId: value.bookId,
    corpusSignature: value.corpusSignature,
    history: value.history.map((record) => ({
      ...record,
      anchor: {
        ...record.anchor,
        start: { ...record.anchor.start },
        end: { ...record.anchor.end },
      },
      ...(record.result ? { result: { ...record.result } } : {}),
    })),
    frontier: {
      ...value.frontier,
      start: { ...value.frontier.start },
      end: { ...value.frontier.end },
    },
  });

  const queueSave = (value: BookProgress): void => {
    const snapshot = snapshotProgress(value);
    saveChain = saveChain
      .then(() => saveProgress(snapshot))
      .catch((error: unknown) => {
        console.error("Failed to save reader progress", error);
        if (!cancelled) showToast("Couldn't save your reading progress.", "error");
      });
  };

  const queueCheckpoint = (
    navigation: LessonNavigationState | undefined
  ): void => {
    if (!progress) return;
    const progressSnapshot = snapshotProgress(progress);
    const navigationSnapshot = navigation
      ? snapshotNavigation(navigation)
      : undefined;
    saveChain = saveChain
      .then(() => saveReaderCheckpoint(progressSnapshot, navigationSnapshot))
      .catch((error: unknown) => {
        console.error("Failed to save reader checkpoint", error);
        if (!cancelled) showToast("Couldn't save your reading checkpoint.", "error");
      });
  };

  const atFrontier = (): boolean => replayHistoryIndex === null;

  const appendHistoryRecord = (record: LessonHistoryRecord): void => {
    if (!lessonNavigation) return;
    lessonNavigation = {
      ...lessonNavigation,
      history: [...lessonNavigation.history, record].slice(-LESSON_HISTORY_LIMIT),
    };
  };

  const resetLessonNavigationEpoch = (position: Position): LessonAnchor | undefined => {
    if (!runtimeBook) return undefined;
    const frontier = makeLessonAnchor(
      runtimeBook,
      position,
      getAppState().settings.lessonLength
    );
    lessonNavigation = {
      bookId,
      corpusSignature: lessonCorpusSignature(runtimeBook),
      history: [],
      frontier,
    };
    replayHistoryIndex = null;
    frontierCursor = { ...position };
    frontierCompletedStats = undefined;
    return frontier;
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
  let wpmValueEl: HTMLElement;
  let accuracyValueEl: HTMLElement;
  let statsEl: HTMLElement;
  let typingHost: HTMLElement;
  let hintEl: HTMLElement;
  let lessonLengthSelectEl: HTMLSelectElement;
  let checkpointAnnouncementEl: HTMLElement;
  let previousPassageButtonEl: HTMLButtonElement | undefined;
  let restartPassageButtonEl: HTMLButtonElement | undefined;
  let forwardPassageButtonEl: HTMLButtonElement | undefined;
  let lessonNavEl: HTMLElement | undefined;
  let checkpointPulseTimer: ReturnType<typeof setTimeout> | undefined;
  let latestStats: SessionStats | undefined;
  let latestCompletedStats: SessionStats | undefined;
  let frontierCompletedStats: SessionStats | undefined;

  const updateChrome = (
    position: Position,
    _charsCompleted: number,
    stats?: SessionStats,
    completedResult = false
  ): void => {
    if (!runtimeBook || !progress || !bookTitleEl) return;
    bookTitleEl.textContent = runtimeBook.meta.title || "Untitled book";
    currentSectionEl.textContent = sectionTitle(
      runtimeBook.sections[position.sectionIndex],
      position.sectionIndex
    );
    if (stats) {
      if (completedResult) latestCompletedStats = stats;
      const showLive = getAppState().settings.showLiveWpm;
      const shown = !showLive && !completedResult && latestCompletedStats
        ? latestCompletedStats
        : stats;
      latestStats = shown;
      wpmValueEl.textContent = String(Math.round(shown.wpm));
      accuracyValueEl.textContent = formatPercent(shown.accuracy);
      // The setting suppresses only volatile in-progress stats. A completed
      // Keybr-style lesson result remains an indicator until replaced.
      statsEl.hidden = shown.charsTyped === 0 || (!showLive && !latestCompletedStats);
    }
  };

  const updateLessonNavigationControls = (): void => {
    if (!previousPassageButtonEl || !restartPassageButtonEl || !forwardPassageButtonEl) return;
    const history = lessonNavigation?.history ?? [];
    const previousAvailable = replayHistoryIndex === null
      ? history.length > 0
      : replayHistoryIndex > 0;
    previousPassageButtonEl.disabled = navigationBusy || !session || !previousAvailable;
    restartPassageButtonEl.disabled = navigationBusy || !session;

    let forwardLabel = "Skip passage";
    let forwardTitle = "Skip passage (Ctrl + Right Arrow)";
    let forwardDisabled = navigationBusy || !session;
    if (replayHistoryIndex !== null) {
      const returnsToFrontier = replayHistoryIndex >= history.length - 1;
      forwardLabel = returnsToFrontier ? "Return to current passage" : "Next passage";
      forwardTitle = `${forwardLabel} (Ctrl + Right Arrow)`;
    } else if (session) {
      // Keep the terminal passage skippable so the visible control and
      // Ctrl+Right share one behavior and no synthetic score is required.
      forwardDisabled = navigationBusy;
    }
    forwardPassageButtonEl.disabled = forwardDisabled;
    forwardPassageButtonEl.setAttribute("aria-label", forwardLabel);
    forwardPassageButtonEl.title = forwardTitle;
  };

  const revealLessonNavigation = (): void => {
    lessonNavEl?.classList.add("reader-lesson-nav-handoff");
  };

  const addRunToRouteTotals = (stats: SessionStats): void => {
    routeTotals = {
      charsTyped: routeTotals.charsTyped + stats.charsTyped,
      errors: routeTotals.errors + stats.errors,
      timeMs: routeTotals.timeMs + stats.elapsedMs,
      consistencyTimeTotal:
        routeTotals.consistencyTimeTotal + stats.consistency * stats.elapsedMs,
    };
    peakWpm = Math.max(peakWpm, stats.wpm);
  };

  const commitRun = (
    stats: SessionStats,
    position: Position,
    charsCompleted: number
  ): void => {
    if (!progress || stats.charsTyped === 0) return;
    addRunToRouteTotals(stats);
    progress = applyProgressUpdate(progress, {
      position,
      charsCompleted,
      wpm: stats.wpm,
    });
    progress = accumulateLifetime(progress, {
      charsTyped: stats.charsTyped,
      errors: stats.errors,
      timeMs: stats.elapsedMs,
    });
    // A natural lesson result and its boundary bookmark become durable
    // together. Later route finalization must never re-add the result.
  };

  /** Persist a real scored partial without moving the durable lesson bookmark. */
  const commitPartialRun = (stats: SessionStats, shouldQueue = true): void => {
    if (!progress || stats.charsTyped === 0) return;
    addRunToRouteTotals(stats);
    progress = applyProgressUpdate(progress, {
      position: progress.position,
      charsCompleted: progress.charsCompleted,
      wpm: stats.wpm,
    });
    progress = accumulateLifetime(progress, {
      charsTyped: stats.charsTyped,
      errors: stats.errors,
      timeMs: stats.elapsedMs,
    });
    if (shouldQueue) queueSave(progress);
  };

  const commitReplayRun = (stats: SessionStats): void => {
    commitPartialRun(stats, false);
  };

  const discardCurrentSession = (): {
    position: Position;
    stats: SessionStats;
    anchor: LessonAnchor;
  } | undefined => {
    const current = session;
    if (!current) return undefined;
    sessionGeneration += 1;
    current.pause();
    const position = current.getPosition();
    const stats = current.getStats();
    const anchor = current.getLessonAnchor();
    suppressProgressPersistence = true;
    current.destroy();
    suppressProgressPersistence = false;
    session = null;
    return { position, stats, anchor };
  };

  const stopCurrentRun = (): {
    position: Position;
    stats: SessionStats;
    anchor: LessonAnchor;
  } | undefined => {
    const current = session;
    if (!current) return undefined;
    sessionGeneration += 1;
    current.pause();
    const position = current.getPosition();
    const stats = current.getStats();
    const anchor = current.getLessonAnchor();
    if (runtimeBook && progress && atFrontier()) {
      frontierCursor = { ...position };
      if (stats.charsTyped > 0) {
        commitPartialRun(stats);
        latestStats = stats;
      }
    }
    suppressProgressPersistence = !atFrontier();
    current.destroy();
    suppressProgressPersistence = false;
    session = null;
    return { position, stats, anchor };
  };

  const finalizeLifetime = (completed: boolean): SessionStats => {
    if (lifetimeFinalized && finalStats) return finalStats;

    const wasReplay = !atFrontier();
    const stopped = wasReplay ? discardCurrentSession() : stopCurrentRun();
    const combined = statsFromTotals(routeTotals);
    peakWpm = Math.max(peakWpm, combined.wpm);
    finalStats = combined;
    lifetimeFinalized = true;

    if (progress && runtimeBook) {
      const displayPosition = wasReplay
        ? frontierCursor ?? progress.position
        : stopped?.position ?? frontierCursor ?? progress.position;
      if (!completed) {
        progress = applyProgressUpdate(progress, {
          position: progress.position,
          charsCompleted: progress.charsCompleted,
          wpm: peakWpm,
        });
        queueSave(progress);
      }
      if (!cancelled) {
        updateChrome(
          displayPosition,
          charsAtPosition(runtimeBook, displayPosition),
          combined
        );
      }
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
                  lessonNavigation = undefined;
                  persistProgress(start, 0, undefined, false);
                  queueCheckpoint(undefined);
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
    updateLessonNavigationControls();
  };

  const pauseForChooser = (): Position | undefined => {
    if (!session || !runtimeBook || !progress) return undefined;
    session.pause();
    const position = session.getPosition();
    if (atFrontier()) {
      frontierCursor = { ...position };
    }
    return position;
  };

  const installChooser = (
    root: HTMLElement,
    panel: HTMLElement,
    initialFocus?: HTMLElement | null
  ): void => {
    chooser = root;
    root.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableReaderElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    });
    document.body.appendChild(root);
    chooserBackground = Array.from(document.body.children)
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== root)
      .map((node) => ({
        node,
        hadInert: node.hasAttribute("inert"),
        ariaHidden: node.getAttribute("aria-hidden"),
      }));
    for (const entry of chooserBackground) {
      entry.node.setAttribute("inert", "");
      entry.node.setAttribute("aria-hidden", "true");
    }
    (initialFocus ?? focusableReaderElements(panel)[0] ?? panel).focus();
  };

  const closeChooser = (resumeTemporarySession = true): void => {
    const returnFocus = overlayReturnFocus;
    const interrupted = overlayInterruptedSession;
    chooser?.remove();
    chooser = null;
    for (const entry of chooserBackground) {
      if (!entry.hadInert) entry.node.removeAttribute("inert");
      if (entry.ariaHidden === null) entry.node.removeAttribute("aria-hidden");
      else entry.node.setAttribute("aria-hidden", entry.ariaHidden);
    }
    chooserBackground = [];
    overlayReturnFocus = null;
    overlayInterruptedSession = false;
    if (resumeTemporarySession && interrupted && session && !lifetimeFinalized) {
      session.resume();
      chooserResumePosition = undefined;
      hintEl.textContent = ACTIVE_READER_HINT;
    }
    returnFocus?.focus();
  };

  const showMountedPassage = (
    position: Position,
    indicator: SessionStats | undefined
  ): void => {
    if (!runtimeBook) return;
    latestStats = indicator;
    latestCompletedStats = indicator;
    if (indicator) {
      updateChrome(position, charsAtPosition(runtimeBook, position), indicator, true);
    } else {
      updateChrome(position, charsAtPosition(runtimeBook, position));
      statsEl.hidden = true;
    }
    revealLessonNavigation();
    updateLessonNavigationControls();
  };

  const mountPassage = (historyIndex: number | null): void => {
    if (!session || !lessonNavigation || !runtimeBook) return;
    if (historyIndex !== null && atFrontier()) {
      // mountLesson cancels the outgoing lesson's debounced progress callback.
      // Snapshot its live cursor synchronously before replacing the DOM. It
      // remains route-local; the durable bookmark stays at frontier.start.
      const livePosition = session.getPosition();
      frontierCursor = { ...livePosition };
    }
    navigationBusy = true;
    updateLessonNavigationControls();
    try {
      if (historyIndex === null) {
        replayHistoryIndex = null;
        latestCompletedStats = frontierCompletedStats;
        const cursor = frontierCursor && positionInActiveAnchor(frontierCursor, lessonNavigation.frontier)
          ? frontierCursor
          : lessonNavigation.frontier.start;
        session.mountLesson(lessonNavigation.frontier, cursor);
        showMountedPassage(cursor, frontierCompletedStats);
      } else {
        const record = lessonNavigation.history[historyIndex];
        if (!record) return;
        replayHistoryIndex = historyIndex;
        session.mountLesson(record.anchor);
        showMountedPassage(record.anchor.start, record.result);
      }
      session.resume();
    } finally {
      navigationBusy = false;
      updateLessonNavigationControls();
    }
  };

  const previousPassage = (): void => {
    if (!session || !lessonNavigation || navigationBusy) return;
    const targetIndex = replayHistoryIndex === null
      ? lessonNavigation.history.length - 1
      : replayHistoryIndex - 1;
    if (targetIndex < 0) return;
    mountPassage(targetIndex);
  };

  const restartPassage = (): void => {
    if (!session || navigationBusy) return;
    navigationBusy = true;
    updateLessonNavigationControls();
    try {
      session.restartLesson();
      const anchor = session.getLessonAnchor();
      if (atFrontier()) frontierCursor = { ...anchor.start };
      const indicator = replayHistoryIndex === null
        ? frontierCompletedStats
        : lessonNavigation?.history[replayHistoryIndex]?.result;
      showMountedPassage(anchor.start, indicator);
      session.resume();
    } finally {
      navigationBusy = false;
      updateLessonNavigationControls();
    }
  };

  const moveReplayForward = (): void => {
    if (replayHistoryIndex === null || !lessonNavigation) return;
    if (replayHistoryIndex < lessonNavigation.history.length - 1) {
      mountPassage(replayHistoryIndex + 1);
    } else {
      mountPassage(null);
    }
  };

  const forwardPassage = (): void => {
    if (!session || !lessonNavigation || !runtimeBook || !progress || navigationBusy) return;
    if (replayHistoryIndex !== null) {
      moveReplayForward();
      return;
    }

    navigationBusy = true;
    updateLessonNavigationControls();
    try {
      const skipped = session.skipLesson();
      frontierCursor = { ...skipped.skipped.end };
      persistProgress(
        frontierCursor,
        charsAtPosition(runtimeBook, frontierCursor),
        undefined,
        false
      );
      if (skipped.next) {
        appendHistoryRecord({ anchor: skipped.skipped, outcome: "skipped" });
        lessonNavigation = { ...lessonNavigation, frontier: skipped.next };
        queueCheckpoint(lessonNavigation);
        showMountedPassage(skipped.next.start, frontierCompletedStats);
        session.resume();
      } else if (skipped.bookComplete) {
        lessonNavigation = { ...lessonNavigation, frontier: skipped.skipped };
        queueCheckpoint(lessonNavigation);
        session.destroy();
        session = null;
        lifetimeFinalized = true;
        finalStats = statsFromTotals(routeTotals);
        renderCompletion();
      }
    } finally {
      navigationBusy = false;
      updateLessonNavigationControls();
    }
  };

  const startSession = (startAt: Position, anchor?: LessonAnchor): void => {
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
        if (cancelled || generation !== sessionGeneration || suppressProgressPersistence) return;
        const stats = created.getStats();
        const displayStats =
          stats.charsTyped > 0 && stats.elapsedMs > 0 ? stats : latestStats;
        if (atFrontier()) {
          // Live typing remains resumable within this route, but only a
          // completed/skipped lesson advances the durable BookProgress.
          frontierCursor = { ...position };
        }
        updateChrome(position, charsCompleted, displayStats);
      },
      onStats: (stats) => {
        if (cancelled || generation !== sessionGeneration) return;
        // A fresh lesson is intentionally idle. Retain the previous result
        // until this run has both real input and measurable active time.
        const displayStats =
          stats.charsTyped > 0 && stats.elapsedMs > 0 ? stats : latestStats;
        if (!displayStats) return;
        const position = created.getPosition();
        updateChrome(position, charsAtPosition(runtimeBook!, position), displayStats);
      },
      onLessonComplete: (stats, position, completedAnchor) => {
        if (cancelled || generation !== sessionGeneration) return;
        // The engine has already mounted the next finite lesson and reset its
        // clock/counters. Persist this immutable result once, and keep it in
        // the chrome while the new lesson remains idle.
        let completedBook = false;
        if (replayHistoryIndex !== null && lessonNavigation) {
          const record = lessonNavigation.history[replayHistoryIndex];
          if (record) {
            lessonNavigation = {
              ...lessonNavigation,
              history: lessonNavigation.history.map((item, index) =>
                index === replayHistoryIndex
                  ? { anchor: item.anchor, outcome: "completed", result: stats }
                  : item
              ),
            };
          }
          commitReplayRun(stats);
          queueCheckpoint(lessonNavigation);
          suppressBookCompletionOnce =
            Boolean(completedAnchor) &&
            charsAtPosition(runtimeBook!, completedAnchor!.end) >= progress!.totalChars;
          completedBook = suppressBookCompletionOnce;
        } else {
          frontierCursor = { ...position };
          commitRun(stats, position, charsAtPosition(runtimeBook!, position));
          frontierCompletedStats = stats;
          const nextAnchor = created.getLessonAnchor();
          if (lessonNavigation && completedAnchor) {
            const hasNext =
              isValidLessonAnchor(runtimeBook!, nextAnchor) &&
              positionsEqual(nextAnchor.start, completedAnchor.end);
            if (hasNext) {
              appendHistoryRecord({
                anchor: completedAnchor,
                outcome: "completed",
                result: stats,
              });
              lessonNavigation = { ...lessonNavigation, frontier: nextAnchor };
            } else {
              // A terminal completion has no next range. Keep the completed
              // anchor as frontier; duplicating it in history is invalid.
              lessonNavigation = { ...lessonNavigation, frontier: completedAnchor };
              completedBook = true;
            }
          }
          queueCheckpoint(lessonNavigation);
        }
        latestStats = stats;
        updateChrome(position, charsAtPosition(runtimeBook!, position), stats, true);
        // This dedicated polite region receives one mutation per checkpoint;
        // volatile timer updates intentionally never touch it.
        checkpointAnnouncementEl.textContent = completedBook
          ? `Lesson complete: ${Math.round(stats.wpm)} WPM, ${formatPercent(stats.accuracy)} accuracy. Book complete.`
          : `Lesson complete: ${Math.round(stats.wpm)} WPM, ${formatPercent(stats.accuracy)} accuracy. Next passage.`;
        statsEl.classList.remove("reader-live-stats-complete");
        // Restart the restrained pulse even when two consecutive results are equal.
        void statsEl.offsetWidth;
        statsEl.classList.add("reader-live-stats-complete");
        if (checkpointPulseTimer) clearTimeout(checkpointPulseTimer);
        checkpointPulseTimer = setTimeout(() => {
          statsEl.classList.remove("reader-live-stats-complete");
          checkpointPulseTimer = undefined;
        }, 200);
        revealLessonNavigation();
        if (replayHistoryIndex !== null) moveReplayForward();
        updateLessonNavigationControls();
      },
      onSectionComplete: () => {
        if (cancelled || generation !== sessionGeneration) return;
        queueMicrotask(() => {
          if (cancelled || generation !== sessionGeneration) return;
          const position = created.getPosition();
          const stats = created.getStats();
          updateChrome(
            position,
            charsAtPosition(runtimeBook!, position),
            stats.charsTyped > 0 && stats.elapsedMs > 0 ? stats : latestStats
          );
        });
      },
      onBookComplete: () => {
        if (cancelled || generation !== sessionGeneration) return;
        if (suppressBookCompletionOnce) {
          suppressBookCompletionOnce = false;
          return;
        }
        const stats = finalizeLifetime(true);
        renderCompletion(stats);
      },
    });
    if (anchor) created.mountLesson(anchor, startAt);
    session = created;
    const normalized = created.getPosition();
    const absoluteChars = charsAtPosition(runtimeBook, normalized);
    progress = { ...progress, totalChars: computeTotalChars(runtimeBook.sections, {}) };
    if (atFrontier()) {
      frontierCursor = { ...normalized };
    }
    const startingStats = created.getStats();
    updateChrome(
      normalized,
      absoluteChars,
      startingStats.charsTyped > 0 && startingStats.elapsedMs > 0
        ? startingStats
        : latestStats
    );
    created.start();
    updateLessonNavigationControls();
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
    const wasReplay = !atFrontier();
    const stopped = stopCurrentRun();
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
      lessonNavigation = undefined;
      replayHistoryIndex = null;
      queueCheckpoint(undefined);
      renderNoSections();
      return;
    }
    const currentAbsolute = charsAtPosition(runtimeBook, progress.position);
    if (wasFinalized && currentAbsolute >= progress.totalChars) {
      lessonNavigation = undefined;
      replayHistoryIndex = null;
      queueCheckpoint(undefined);
      updateChrome(progress.position, progress.totalChars);
      renderCompletion();
      return;
    }
    if (wasFinalized) {
      lifetimeFinalized = false;
      finalStats = undefined;
      routeTotals = { ...EMPTY_TOTALS };
      latestStats = undefined;
      latestCompletedStats = undefined;
      peakWpm = 0;
    }
    const requested = wasReplay
      ? frontierCursor ?? progress.position
      : stopped?.position ?? chooserResumePosition ?? progress.position;
    chooserResumePosition = undefined;
    pausedPosition = undefined;
    const anchor = resetLessonNavigationEpoch(requested);
    const boundary = anchor?.start ?? requested;
    persistProgress(boundary, charsAtPosition(runtimeBook, boundary), undefined, false);
    queueCheckpoint(lessonNavigation);
    startSession(boundary, anchor);
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
    // Selecting a destination is the destructive navigation boundary. The
    // temporarily paused run is committed exactly once here, not on open.
    stopCurrentRun();
    closeChooser(false);
    if (wasFinalized) {
      lifetimeFinalized = false;
      finalStats = undefined;
      routeTotals = { ...EMPTY_TOTALS };
      latestStats = undefined;
      latestCompletedStats = undefined;
      peakWpm = 0;
    }
    chooserResumePosition = undefined;
    pausedPosition = undefined;
    const anchor = resetLessonNavigationEpoch(target);
    const boundary = anchor?.start ?? target;
    persistProgress(boundary, charsAtPosition(runtimeBook, boundary), undefined, false);
    queueCheckpoint(lessonNavigation);
    // Do not start the destination engine until its atomic checkpoint and the
    // preceding outgoing partial-stat snapshot are durable.
    await saveChain;
    if (cancelled) return;
    startSession(boundary, anchor);
  };

  function openContents(returnFocus = document.activeElement as HTMLElement | null): void {
    if (!runtimeBook || !progress || chooser) return;
    const paused = pauseForChooser();
    const currentPosition = paused ?? pausedPosition ?? progress.position;
    chooserResumePosition = currentPosition;
    overlayInterruptedSession = paused !== undefined;
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
        el(
          "span",
          { className: "reader-contents-progress" },
          sectionProgressLabel(index, progress.position)
        )
      );
      if (isCurrent) currentButton = button;
      list.appendChild(button);
    }

    const titleId = `reader-contents-${bookId}`;
    const panel = el(
      "div",
      {
        className: "reader-chooser-panel reader-contents-panel",
        attrs: {
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": titleId,
          tabindex: "-1",
        },
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
    const root = el(
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
    installChooser(
      root,
      panel,
      currentButton ?? (panel.querySelector("button") as HTMLButtonElement | null)
    );
  }

  function openInclusionEditor(
    returnFocus = document.activeElement as HTMLElement | null,
    inheritedInterruption = false
  ): void {
    if (!storedBook || !progress || chooser) return;
    const paused = inheritedInterruption ? chooserResumePosition : pauseForChooser();
    chooserResumePosition = paused ?? pausedPosition ?? progress.position;
    overlayInterruptedSession = paused !== undefined || inheritedInterruption;
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
        attrs: {
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": titleId,
          tabindex: "-1",
        },
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
    const root = el("div", {
      className: "reader-chooser-backdrop",
      on: {
        mousedown: (event: Event) => {
          if (event.target === chooser) closeChooser();
        },
      },
    }, panel);
    installChooser(root, panel, panel.querySelector("button") as HTMLButtonElement | null);
  }

  const renderSessionResults = (): void => {
    if (!runtimeBook || !progress || cancelled) return;
    const stats = statsFromTotals(routeTotals);
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
                  const resumeAnchor = pausedAnchor;
                  pausedPosition = undefined;
                  pausedAnchor = undefined;
                  startSession(resumeAt, resumeAnchor);
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
    const stopped = stopCurrentRun();
    pausedPosition = stopped?.position;
    pausedAnchor = stopped?.anchor;
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
    wpmValueEl = el("span", { className: "stat-value" }, "0");
    accuracyValueEl = el("span", { className: "stat-value" }, "100%");
    statsEl = el(
      "div",
      { className: "reader-live-stats" },
      el(
        "span",
        { className: "reader-live-stat" },
        wpmValueEl,
        el("span", { className: "stat-label" }, " wpm")
      ),
      el(
        "span",
        { className: "reader-live-stat" },
        accuracyValueEl,
        el("span", { className: "stat-label" }, " accuracy")
      )
    );
    checkpointAnnouncementEl = el("div", {
      className: "visually-hidden reader-checkpoint-announcement",
      attrs: { "aria-live": "polite", "aria-atomic": "true" },
    });
    typingHost = el("div", {
      className: "typing-container",
      on: {
        click: () => {
          if (!session && pausedPosition && !lifetimeFinalized) {
            const resumeAt = pausedPosition;
            const resumeAnchor = pausedAnchor;
            pausedPosition = undefined;
            pausedAnchor = undefined;
            startSession(resumeAt, resumeAnchor);
          } else {
            session?.resume();
          }
          hintEl.textContent = ACTIVE_READER_HINT;
        },
        keydown: (event: Event) => {
          const key = event as KeyboardEvent;
          if (key.key.length === 1 || key.key === "Backspace" || key.key === "Enter") {
            lessonNavEl?.classList.remove("reader-lesson-nav-handoff");
            shell.classList.add("reader-focused");
            playTypingClick();
            const stats = session?.getStats();
            const position = session?.getPosition();
            if (
              stats &&
              stats.charsTyped > 0 &&
              stats.elapsedMs > 0 &&
              position &&
              runtimeBook
            ) {
              updateChrome(position, charsAtPosition(runtimeBook, position), stats);
            }
          }
        },
      },
    });
    hintEl = el("p", { className: "reader-hint" }, ACTIVE_READER_HINT);
    lessonLengthSelectEl = el(
      "select",
      {
        className: "reader-lesson-length-select",
        attrs: {
          "aria-label": "Lesson length",
          title: "Target length; lessons may finish at a nearby sentence or source line",
        },
        on: {
          change: (event: Event) => {
            const select = event.currentTarget as HTMLSelectElement;
            const lessonLength = normalizeLessonLength(Number(select.value));
            if (lessonLength === getAppState().settings.lessonLength) {
              select.value = String(lessonLength);
              return;
            }
            const current = session;
            const currentStats = current?.getStats();
            const currentReplayIndex = replayHistoryIndex;
            const hasActivity = (currentStats?.charsTyped ?? 0) > 0;
            const hasRouteLocalCursor = Boolean(
              current &&
              currentReplayIndex === null &&
              !positionsEqual(current.getPosition(), current.getLessonAnchor().start)
            );
            select.disabled = true;

            const settingsUpdate = getAppState().updateSettings({ lessonLength });
            if (currentReplayIndex !== null && current) {
              // Historical ranges are immutable. The new size belongs to the
              // future frontier/next passage, even when replay is untouched.
              select.disabled = false;
              showToast(`${lessonLength} chars from next lesson`);
              current.resume();
              void settingsUpdate.catch((error: unknown) => {
                console.error("Failed to save lesson length", error);
                if (!cancelled) showToast("Couldn't save the lesson length.", "error");
              });
              return;
            }
            if ((hasActivity || hasRouteLocalCursor) && current) {
              // The engine freezes the active lesson target. Preserve this
              // scored run (or route-local cursor) and apply the new size at
              // its natural handoff.
              select.disabled = false;
              showToast(`${lessonLength} chars from next lesson`);
              current.resume();
              void settingsUpdate.catch((error: unknown) => {
                console.error("Failed to save lesson length", error);
                if (!cancelled) showToast("Couldn't save the lesson length.", "error");
              });
              return;
            }

            void (async () => {
              try {
                await settingsUpdate;
              } catch (error) {
                console.error("Failed to save lesson length", error);
                if (!cancelled) showToast("Couldn't save the lesson length.", "error");
              }
              // An untouched lesson has no result to preserve, so replace it
              // immediately at the same canonical position.
              const stopped = current && session === current ? stopCurrentRun() : undefined;
              await saveChain;
              if (cancelled) return;
              select.disabled = false;
              select.value = String(getAppState().settings.lessonLength);
              if (stopped && !lifetimeFinalized) {
                pausedPosition = undefined;
                let anchor: LessonAnchor | undefined;
                if (runtimeBook && lessonNavigation) {
                  anchor = makeLessonAnchor(runtimeBook, stopped.position, lessonLength);
                  lessonNavigation = { ...lessonNavigation, frontier: anchor };
                  frontierCursor = { ...stopped.position };
                  queueCheckpoint(lessonNavigation);
                }
                startSession(stopped.position, anchor);
                hintEl.textContent = ACTIVE_READER_HINT;
              }
            })();
          },
        },
      },
      ...Array.from(
        { length: (MAX_LESSON_LENGTH - MIN_LESSON_LENGTH) / LESSON_LENGTH_STEP + 1 },
        (_, offset) => {
          const value = MIN_LESSON_LENGTH + offset * LESSON_LENGTH_STEP;
          return el("option", { attrs: { value } }, `${value} chars`);
        }
      )
    );
    lessonLengthSelectEl.value = String(getAppState().settings.lessonLength);
    previousPassageButtonEl = el("button", {
      className: "icon-button",
      attrs: {
        type: "button",
        "aria-label": "Previous passage",
        title: "Previous passage (Ctrl + Shift + Left Arrow)",
      },
      on: { click: previousPassage },
      html: icons.arrowLeft,
    }) as HTMLButtonElement;
    restartPassageButtonEl = el("button", {
      className: "icon-button",
      attrs: {
        type: "button",
        "aria-label": "Restart passage",
        title: "Restart passage (Ctrl + Left Arrow)",
      },
      on: { click: restartPassage },
      html: icons.refresh,
    }) as HTMLButtonElement;
    forwardPassageButtonEl = el("button", {
      className: "icon-button",
      attrs: {
        type: "button",
        "aria-label": "Skip passage",
        title: "Skip passage (Ctrl + Right Arrow)",
      },
      on: { click: forwardPassage },
      html: icons.arrowRight,
    }) as HTMLButtonElement;
    lessonNavEl = el(
      "div",
      { className: "reader-lesson-nav", attrs: { role: "group", "aria-label": "Passage controls" } },
      previousPassageButtonEl,
      restartPassageButtonEl,
      forwardPassageButtonEl
    );
    updateLessonNavigationControls();
    const chrome = el(
      "div",
      {
        className: "reader-chrome",
        on: { focusin: () => shell.classList.remove("reader-focused") },
      },
      el(
        "div",
        { className: "reader-topbar" },
        el(
          "div",
          { className: "reader-topbar-leading" },
          el("button", {
            className: "icon-button",
            attrs: { type: "button", "aria-label": "Back to library" },
            on: { click: () => navigate({ name: "library" }) },
            html: icons.arrowLeft,
          })
        ),
        el(
          "div",
          { className: "reader-topbar-center" },
          el("div", { className: "reader-titles" }, bookTitleEl, currentSectionEl)
        ),
        el(
          "div",
          { className: "reader-actions reader-topbar-trailing" },
          el(
            "label",
            { className: "reader-lesson-length-control" },
            el("span", { className: "visually-hidden" }, "Lesson length"),
            lessonLengthSelectEl
          ),
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
      )
    );
    const stageBar = el("div", { className: "reader-stage-bar" }, statsEl, lessonNavEl);
    const workspace = el(
      "div",
      { className: "reader-workspace" },
      stageBar,
      typingHost,
      hintEl,
      checkpointAnnouncementEl
    );
    // Live scoring belongs to the same content axis as the text, outside the
    // fading navigation chrome so focused typing never hides enabled stats.
    shell.append(chrome, workspace);
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
    if (event.key === "Escape") {
      if (chooser) {
        event.preventDefault();
        closeChooser();
        return;
      }
      if (session) pauseSession();
      return;
    }
    if (
      chooser ||
      !session ||
      navigationBusy ||
      event.altKey ||
      event.metaKey ||
      !event.ctrlKey ||
      event.repeat
    ) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      !target.classList.contains("scr-hidden-input") &&
      target.matches("button, select, input, textarea, [contenteditable='true']")
    ) return;

    let action: (() => void) | undefined;
    if (event.key === "ArrowLeft" && event.shiftKey) action = previousPassage;
    else if (event.key === "ArrowLeft" && !event.shiftKey) action = restartPassage;
    else if (event.key === "ArrowRight" && !event.shiftKey) action = forwardPassage;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
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
      const [book, saved, storedNavigation] = await Promise.all([
        getBook(bookId),
        getProgress(bookId),
        getLessonNavigation(bookId).catch((error: unknown) => {
          console.error("Failed to load passage history", error);
          return undefined;
        }),
      ]);
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
      const corpusSignature = lessonCorpusSignature(runtimeBook);
      const navigationIsUsable =
        storedNavigation?.bookId === bookId &&
        storedNavigation.corpusSignature === corpusSignature &&
        positionInActiveAnchor(progress.position, storedNavigation.frontier) &&
        isValidLessonAnchor(runtimeBook, storedNavigation.frontier) &&
        storedNavigation.history.every(({ anchor }) =>
          isValidLessonAnchor(runtimeBook!, anchor)
        );
      const atBookEnd =
        progress.totalChars > 0 &&
        charsAtPosition(runtimeBook, progress.position) >= progress.totalChars;
      const canSeedNavigation = hasTypeableSection(runtimeBook) && !atBookEnd;
      if (navigationIsUsable && storedNavigation) {
        lessonNavigation = storedNavigation;
        const boundary = storedNavigation.frontier.start;
        const boundaryChars = charsAtPosition(runtimeBook, boundary);
        if (
          !positionsEqual(progress.position, boundary) ||
          progress.charsCompleted !== boundaryChars
        ) {
          // Migrate legacy mid-lesson bookmarks to the finite lesson start.
          // Stats stay intact; reloads now consistently restart the passage.
          persistProgress(boundary, boundaryChars, undefined, false);
          queueCheckpoint(storedNavigation);
        }
      } else if (canSeedNavigation) {
        const target = getAppState().settings.lessonLength;
        lessonNavigation = {
          bookId,
          corpusSignature,
          history: reconstructRecentLessonAnchors(
            runtimeBook,
            progress.position,
            target,
            LESSON_HISTORY_LIMIT
          ).map((anchor) => ({ anchor, outcome: "recovered" as const })),
          frontier: makeLessonAnchor(runtimeBook, progress.position, target),
        };
        queueCheckpoint(lessonNavigation);
      }
      frontierCursor = { ...progress.position };
      buildReader();
      unsubscribeSettings = getAppState().subscribe((settings) => {
        if (cancelled) return;
        session?.applySettings(settings);
        lessonLengthSelectEl.value = String(settings.lessonLength);
        const shown = settings.showLiveWpm ? latestStats : latestCompletedStats;
        if (shown) {
          wpmValueEl.textContent = String(Math.round(shown.wpm));
          accuracyValueEl.textContent = formatPercent(shown.accuracy);
        }
        statsEl.hidden = !shown || shown.charsTyped === 0;
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
      startSession(progress.position, lessonNavigation?.frontier);
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
      if (chooser) closeChooser(false);
      unsubscribeSettings?.();
      unsubscribeSettings = undefined;
      if (!lifetimeFinalized) finalizeLifetime(false);
      else {
        session?.destroy();
        session = null;
      }
      if (audioContext) void audioContext.close();
      if (checkpointPulseTimer) clearTimeout(checkpointPulseTimer);
    },
  };
}
