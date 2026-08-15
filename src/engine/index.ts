/**
 * Scriptorium typing engine.
 *
 * Core invariant (see src/types.ts): everything here indexes `Block.text`
 * directly. There is no secondary comparison string - the character shown
 * in span N is exactly the character compared against the user's Nth
 * keystroke for that block.
 */

import type {
  Block,
  ParsedBook,
  Position,
  Settings,
  SessionStats,
} from "../types";
import {
  calculateWpm,
  calculateAccuracy,
  calculateConsistency,
} from "./stats";
import {
  getWordStart,
  firstIncludedSectionIndex,
  hasTypeableContent,
  normalizePosition,
  findNextBlock,
  findPreviousBlock,
  buildCanonicalNonSpaceIndex,
  canonicalNonSpaceCharsAt,
  type CanonicalNonSpaceIndex,
} from "./text-model";
import {
  createBlockState,
  wordHadError,
  wordIsCurrentlyCorrect,
  type BlockState,
} from "./block-state";
import { SessionClock } from "./clock";
import {
  buildDom,
  applyFont,
  applyVisibleLineCount,
  applyCaretStyle,
  applySmoothCaret,
  renderWindow,
  setCharClass,
  setBoundaryClass,
  renderExtras,
  positionCaret,
  keepLineInView,
  blockKey,
  charKey,
  type DomRefs,
  type RenderedBlock,
  type BoundaryState,
} from "./dom";
import "./typing.css";

export type TypingSessionOptions = {
  book: ParsedBook;
  container: HTMLElement;
  settings: Settings;
  /** Resume point. Defaults to the start of the first included section. */
  startAt?: Position;
  /** Debounced (~1s) — persist this so closing the tab resumes exactly. */
  onProgress?: (position: Position, charsCompleted: number) => void;
  /** Fires ~4x/sec while typing, for the live WPM/accuracy readout. */
  onStats?: (stats: SessionStats) => void;
  /** Fires at each rolling lesson checkpoint. The immutable stats contain
   * the boundary key; position is already the mounted next-lesson start. */
  onLessonComplete?: (stats: SessionStats, position: Position) => void;
  /** @deprecated Use onLessonComplete. Retained as a fallback callback so
   * existing integrations do not silently lose completed-run stats. */
  onBlockComplete?: (stats: SessionStats, position: Position) => void;
  onSectionComplete?: (sectionIndex: number) => void;
  onBookComplete?: () => void;
};

const PROGRESS_DEBOUNCE_MS = 1000;
const SAMPLE_INTERVAL_MS = 1000;
const STATS_INTERVAL_MS = 250;
export const LESSON_TARGET_NON_SPACE_CHARS = 100;

export class TypingSession {
  private readonly opts: TypingSessionOptions;
  private readonly book: ParsedBook;
  private readonly container: HTMLElement;
  private readonly canonicalNonSpaceIndex: CanonicalNonSpaceIndex;
  private settings: Settings;

  private position: Position;
  /** Exact canonical floor for the active discrete lesson. */
  private lessonStartPosition: Position;
  private lessonStartNonSpaceChars: number;

  private readonly blockStates = new Map<string, BlockState>();
  private dom: DomRefs | null = null;
  private spanIndex = new Map<string, HTMLSpanElement>();
  private extrasIndex = new Map<string, HTMLSpanElement>();
  private boundaryIndex = new Map<string, HTMLSpanElement>();
  /** Reversible, non-canonical printable input entered at a pilcrow. */
  private readonly boundaryErrors = new Map<string, number>();
  private renderedBlocks = new Set<string>();

  private readonly clock: SessionClock;
  private totalKeystrokes = 0;
  private correctKeystrokes = 0;
  private keystrokesThisSecond = 0;
  private rawWpmSamples: number[] = [];

  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private progressDirty = false;
  private blurRefocusTimer: ReturnType<typeof setTimeout> | null = null;

  private started = false;
  private destroyed = false;
  private finished = false;
  private pausedExplicitly = false;
  private composing = false;
  private suppressBeforeInput = false;
  private suppressInput = false;
  private inputSuppressionGeneration = 0;

  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onBeforeInput: ((e: InputEvent) => void) | null = null;
  private onInput: ((e: Event) => void) | null = null;
  private onCompositionStart: (() => void) | null = null;
  private onCompositionEnd: ((e: CompositionEvent) => void) | null = null;
  private onPaste: ((e: ClipboardEvent) => void) | null = null;
  private onBlur: ((e: FocusEvent) => void) | null = null;
  private onContainerClick: ((e: MouseEvent) => void) | null = null;

  constructor(opts: TypingSessionOptions) {
    this.opts = opts;
    this.book = opts.book;
    this.container = opts.container;
    this.settings = opts.settings;
    this.clock = new SessionClock();
    this.canonicalNonSpaceIndex = buildCanonicalNonSpaceIndex(this.book);

    const start = opts.startAt ?? {
      sectionIndex: firstIncludedSectionIndex(this.book),
      blockIndex: 0,
      charIndex: 0,
    };
    this.position = normalizePosition(this.book, start);
    this.lessonStartPosition = this.position;
    this.lessonStartNonSpaceChars = this.nonSpaceCharsAt(this.position);
    this.finished = !hasTypeableContent(this.book);
    this.initializeResumeState(this.position);
  }

  // ───────────────────────────── public API ─────────────────────────────

  start(): void {
    if (this.destroyed || this.started) return;
    this.started = true;
    this.dom = buildDom(this.container, this.settings);
    this.attachListeners();
    this.rebuildRenderWindow();
    this.updateCaret();
    this.focusInput();
  }

  pause(): void {
    if (this.destroyed) return;
    this.pausedExplicitly = true;
    this.clock.pause();
    this.stopActivityTimers();
  }

  resume(): void {
    if (this.destroyed) return;
    this.pausedExplicitly = false;
    this.clock.resume();
    this.focusInput();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // A pending debounce represents real typing progress. Flush it before
    // tearing listeners/timers down so a route change inside the debounce
    // window cannot lose the exact resume position.
    this.flushProgressSave();
    this.stopActivityTimers();
    if (this.blurRefocusTimer !== null) {
      clearTimeout(this.blurRefocusTimer);
      this.blurRefocusTimer = null;
    }
    this.clock.destroy();

    const dom = this.dom;
    if (dom) {
      const input = dom.hiddenInputEl;
      if (this.onKeyDown) input.removeEventListener("keydown", this.onKeyDown);
      if (this.onBeforeInput) {
        input.removeEventListener("beforeinput", this.onBeforeInput);
      }
      if (this.onInput) input.removeEventListener("input", this.onInput);
      if (this.onCompositionStart) {
        input.removeEventListener("compositionstart", this.onCompositionStart);
      }
      if (this.onCompositionEnd) {
        input.removeEventListener("compositionend", this.onCompositionEnd);
      }
      if (this.onPaste) input.removeEventListener("paste", this.onPaste);
      if (this.onBlur) input.removeEventListener("blur", this.onBlur);
      if (dom.rootEl.parentNode) dom.rootEl.parentNode.removeChild(dom.rootEl);
    }
    if (this.onContainerClick) {
      this.container.removeEventListener("click", this.onContainerClick);
    }

    this.onKeyDown = null;
    this.onBeforeInput = null;
    this.onInput = null;
    this.onCompositionStart = null;
    this.onCompositionEnd = null;
    this.onPaste = null;
    this.onBlur = null;
    this.onContainerClick = null;
    this.boundaryErrors.clear();
    this.boundaryIndex.clear();
    this.dom = null;
  }

  getPosition(): Position {
    return { ...this.position };
  }

  getStats(): SessionStats {
    const elapsedMs = this.clock.elapsedMs();
    return {
      wpm: calculateWpm(this.correctKeystrokes, elapsedMs),
      rawWpm: calculateWpm(this.totalKeystrokes, elapsedMs),
      accuracy: calculateAccuracy(this.correctKeystrokes, this.totalKeystrokes),
      consistency: calculateConsistency(this.rawWpmSamples),
      charsTyped: this.totalKeystrokes,
      errors: this.totalKeystrokes - this.correctKeystrokes,
      elapsedMs,
    };
  }

  jumpTo(position: Position): void {
    if (this.destroyed) return;
    const normalized = normalizePosition(this.book, position);
    // A deliberate navigation starts from persisted canonical progress;
    // transient boundary extras are not part of Position and must not leak.
    this.boundaryErrors.clear();
    this.position = normalized;
    this.resetLessonScore();
    this.lessonStartPosition = normalized;
    this.lessonStartNonSpaceChars = this.nonSpaceCharsAt(normalized);
    this.finished = !hasTypeableContent(this.book);
    this.initializeResumeState(normalized);
    if (!this.finished && !this.pausedExplicitly) this.clock.resume();
    if (this.started) {
      this.rebuildRenderWindow();
      this.updateCaret();
    }
    this.scheduleProgressSave();
  }

  applySettings(settings: Settings): void {
    if (this.destroyed) return;
    this.settings = settings;
    if (!this.dom) return;
    applyFont(this.dom.rootEl, settings);
    applyVisibleLineCount(this.dom.rootEl, settings.contextLines);
    applyCaretStyle(this.dom.caretEl, settings.caretStyle);
    applySmoothCaret(this.dom.caretEl, settings.smoothCaret);
    this.updateCaret();
  }

  // ─────────────────────────── input handling ────────────────────────────

  private attachListeners(): void {
    const dom = this.dom;
    if (!dom) return;
    const input = dom.hiddenInputEl;

    this.onKeyDown = (e: KeyboardEvent) => {
      if (this.composing) return;
      if (e.key === "Backspace") {
        e.preventDefault();
        this.armInputSuppression(true, true);
        this.clearHiddenInput();
        this.handleBackspace();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        this.armInputSuppression(true, true);
        this.clearHiddenInput();
        this.handleEnter();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.armInputSuppression(true, true);
        this.clearHiddenInput();
        this.handleChar(e.key);
      }
    };
    this.onBeforeInput = (e: InputEvent) => {
      if (this.composing || e.isComposing) return;

      if (this.suppressBeforeInput) {
        this.suppressBeforeInput = false;
        if (e.cancelable) e.preventDefault();
        this.clearHiddenInput();
        return;
      }

      if (e.inputType === "insertFromPaste") {
        if (e.cancelable) e.preventDefault();
        this.armInputSuppression(false, true);
        this.clearHiddenInput();
        return;
      }

      if (e.inputType === "deleteContentBackward") {
        if (e.cancelable) e.preventDefault();
        this.handleBackspace();
        this.armInputSuppression(false, true);
        this.clearHiddenInput();
        return;
      }

      if (
        e.inputType === "insertParagraph" ||
        e.inputType === "insertLineBreak"
      ) {
        if (e.cancelable) e.preventDefault();
        this.handleEnter();
        this.armInputSuppression(false, true);
        this.clearHiddenInput();
        return;
      }

      if (e.inputType === "insertText" && e.data) {
        if (e.cancelable) e.preventDefault();
        this.handleTextInput(e.data);
        // Non-cancelable beforeinput is followed by input after the browser
        // mutates the value; cancelable events can still be followed by a
        // synthetic/quirky input. In both cases, consume it exactly once.
        this.armInputSuppression(false, true);
        this.clearHiddenInput();
      }
    };
    this.onInput = (event: Event) => {
      const e = event as InputEvent;
      if (this.composing || e.isComposing) return;

      if (this.suppressInput) {
        this.suppressInput = false;
        this.clearHiddenInput();
        return;
      }

      // Paste stays blocked even on browsers that omit beforeinput or report
      // an unusable event there.
      if (e.inputType === "insertFromPaste") {
        this.clearHiddenInput();
        return;
      }

      if (e.inputType === "deleteContentBackward") {
        this.clearHiddenInput();
        this.handleBackspace();
        return;
      }

      if (
        e.inputType === "insertParagraph" ||
        e.inputType === "insertLineBreak"
      ) {
        this.clearHiddenInput();
        this.handleEnter();
        return;
      }

      // Some software keyboards expose useful text only through the input's
      // value (with null `data`). The input is cleared after every event, so
      // the value is just this edit rather than an accumulating second text
      // model. `data` remains a defensive fallback for synthetic browsers.
      const data = input.value || e.data || "";
      this.clearHiddenInput();
      this.handleTextInput(data);
    };
    this.onCompositionStart = () => {
      this.composing = true;
    };
    this.onCompositionEnd = (e: CompositionEvent) => {
      this.composing = false;
      this.clearHiddenInput();
      const data = e.data ?? "";
      this.handleTextInput(data);
      // Several engines emit a final non-composing beforeinput/input pair
      // for the text compositionend already supplied. Keep compositionend
      // the single source without suppressing a later, separate edit.
      this.armInputSuppression(true, true);
    };
    this.onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      this.clearHiddenInput();
    };
    this.onBlur = (event: FocusEvent) => {
      if (this.destroyed || this.pausedExplicitly || this.finished) return;
      const next = event.relatedTarget;
      if (next instanceof Element && this.isInteractiveElement(next)) return;
      this.blurRefocusTimer = setTimeout(() => {
        this.blurRefocusTimer = null;
        if (!this.destroyed && !this.pausedExplicitly && !this.finished) {
          this.focusInput();
        }
      }, 0);
    };
    this.onContainerClick = (event: MouseEvent) => {
      if (event.target instanceof Element && this.isInteractiveElement(event.target)) return;
      this.focusInput();
    };

    input.addEventListener("keydown", this.onKeyDown);
    input.addEventListener("beforeinput", this.onBeforeInput);
    input.addEventListener("input", this.onInput);
    input.addEventListener("compositionstart", this.onCompositionStart);
    input.addEventListener("compositionend", this.onCompositionEnd);
    input.addEventListener("paste", this.onPaste);
    input.addEventListener("blur", this.onBlur);
    this.container.addEventListener("click", this.onContainerClick);
  }

  private focusInput(): void {
    if (!this.dom || this.pausedExplicitly || this.finished) return;
    try {
      // Browser focus must never move the page or fight the renderer's
      // deliberate three-line viewport position.
      this.dom.hiddenInputEl.focus({ preventScroll: true });
    } catch {
      // ignore - focus can throw in odd/headless environments
    }
  }

  private clearHiddenInput(): void {
    if (this.dom) this.dom.hiddenInputEl.value = "";
  }

  /** Suppression flags live for only the current browser edit event turn.
   * A generation prevents an older queued microtask from clearing flags
   * armed by a newer keydown/composition event in that same turn. */
  private armInputSuppression(beforeInput: boolean, input: boolean): void {
    this.suppressBeforeInput ||= beforeInput;
    this.suppressInput ||= input;
    const generation = ++this.inputSuppressionGeneration;
    queueMicrotask(() => {
      if (generation !== this.inputSuppressionGeneration) return;
      this.suppressBeforeInput = false;
      this.suppressInput = false;
    });
  }

  private isInteractiveElement(element: Element): boolean {
    return Boolean(
      element.closest(
        'button, input, select, textarea, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  private handleTextInput(data: string): void {
    for (const ch of data.replace(/\r\n/g, "\n")) {
      if (ch === "\n" || ch === "\r") this.handleEnter();
      else this.handleChar(ch);
    }
  }

  private handleChar(ch: string): void {
    if (this.destroyed || this.finished || this.pausedExplicitly) return;
    if (ch.length !== 1) return;

    this.clock.recordActivity();
    this.ensureTimersRunning();

    const { sectionIndex, blockIndex } = this.position;
    const block = this.getBlock(sectionIndex, blockIndex);
    if (!block) return;
    const text = block.text;
    let charIndex = this.position.charIndex;
    let committedNaturalWordBoundary = false;
    if (charIndex >= text.length) {
      // The visible pilcrow is a dedicated Enter target, not a canonical
      // character. Printable input at the boundary is still an error but
      // must never advance or become an extra in Block.text.
      this.recordKeystroke(false);
      if (findNextBlock(this.book, sectionIndex, blockIndex) !== null) {
        const key = blockKey(sectionIndex, blockIndex);
        this.boundaryErrors.set(key, (this.boundaryErrors.get(key) ?? 0) + 1);
      }
      this.setBoundaryState(sectionIndex, blockIndex, "incorrect");
      return;
    }

    const state = this.blockStateFor(sectionIndex, blockIndex);
    const expected = text[charIndex]!;
    const wordStart = getWordStart(text, charIndex);

    if (expected === " ") {
      if (ch === " ") {
        if (
          this.settings.stopOnError === "word" &&
          !wordIsCurrentlyCorrect(state, wordStart, charIndex)
        ) {
          // The attempted delimiter is still a keystroke and an error even
          // though policy refuses to advance the canonical position.
          this.recordKeystroke(false);
          return; // policy gate: word must be fixed before committing
        }
        this.setChar(sectionIndex, blockIndex, charIndex, "correct");
        this.recordKeystroke(true);
        charIndex += 1;
        committedNaturalWordBoundary = true;
      } else {
        if (this.settings.stopOnError === "letter") {
          this.recordKeystroke(false);
          return;
        }
        this.addExtra(sectionIndex, blockIndex, wordStart, ch);
        this.recordKeystroke(false);
        this.scheduleProgressSave();
        return;
      }
    } else {
      if (ch === expected) {
        const corrected = state.hadError[charIndex] === true;
        this.setChar(
          sectionIndex,
          blockIndex,
          charIndex,
          corrected ? "corrected" : "correct",
        );
        this.recordKeystroke(true);
        charIndex += 1;
      } else {
        if (this.settings.stopOnError === "letter") {
          this.recordKeystroke(false);
          return;
        }
        this.setChar(sectionIndex, blockIndex, charIndex, "incorrect");
        state.hadError[charIndex] = true;
        this.recordKeystroke(false);
        charIndex += 1;
      }
    }

    this.position = { sectionIndex, blockIndex, charIndex };
    this.scheduleProgressSave();

    if (charIndex >= text.length) {
      this.onBlockTextComplete();
    } else {
      const checkpointed =
        committedNaturalWordBoundary && this.maybeEmitLessonCheckpoint();
      if (!checkpointed) this.updateCaret();
    }
  }

  private handleEnter(): void {
    if (this.destroyed || this.finished || this.pausedExplicitly) return;

    this.clock.recordActivity();
    this.ensureTimersRunning();

    const { sectionIndex, blockIndex, charIndex } = this.position;
    const block = this.getBlock(sectionIndex, blockIndex);
    if (!block) return;
    const next = findNextBlock(this.book, sectionIndex, blockIndex);

    // Enter is only correct at a visible, non-final block boundary.
    if (charIndex !== block.text.length || next === null) {
      this.recordKeystroke(false);
      return;
    }

    if (this.boundaryErrorCount(sectionIndex, blockIndex) > 0) {
      // Enter is a failed commit while reversible boundary extras remain.
      // It counts for accuracy, but does not itself add another extra that
      // the user would unexpectedly need to backspace away.
      this.recordKeystroke(false);
      this.setBoundaryState(sectionIndex, blockIndex, "incorrect");
      this.updateCaret();
      return;
    }

    if (!this.finalWordCanCommit(sectionIndex, blockIndex, block)) {
      this.recordKeystroke(false);
      this.setBoundaryState(sectionIndex, blockIndex, "incorrect");
      this.updateCaret();
      return;
    }

    this.recordKeystroke(true);
    this.setBoundaryState(sectionIndex, blockIndex, "correct");
    this.boundaryErrors.delete(blockKey(sectionIndex, blockIndex));
    this.advancePastBoundary(next);
    this.maybeEmitLessonCheckpoint();
    this.scheduleProgressSave();
  }

  private handleBackspace(): void {
    if (this.destroyed || this.finished || this.pausedExplicitly) return;
    this.clock.recordActivity();
    this.ensureTimersRunning();

    const { sectionIndex, blockIndex, charIndex } = this.position;
    const currentBlock = this.getBlock(sectionIndex, blockIndex);
    const boundaryErrorCount = this.boundaryErrorCount(sectionIndex, blockIndex);
    if (
      currentBlock &&
      charIndex === currentBlock.text.length &&
      boundaryErrorCount > 0
    ) {
      const key = blockKey(sectionIndex, blockIndex);
      const remaining = boundaryErrorCount - 1;
      if (remaining === 0) this.boundaryErrors.delete(key);
      else this.boundaryErrors.set(key, remaining);
      this.setBoundaryState(
        sectionIndex,
        blockIndex,
        remaining === 0 ? "pending" : "incorrect",
      );
      this.updateCaret();
      return;
    }

    if (currentBlock && charIndex >= currentBlock.text.length) {
      this.setBoundaryState(sectionIndex, blockIndex, "pending");
    }

    const beforeKey = blockKey(this.position.sectionIndex, this.position.blockIndex);
    this.performBackspaceStep();
    const afterKey = blockKey(this.position.sectionIndex, this.position.blockIndex);
    if (beforeKey !== afterKey) this.rebuildRenderWindow();
    this.updateCaret();
    this.scheduleProgressSave();
  }

  private performBackspaceStep(): void {
    const { sectionIndex, blockIndex, charIndex } = this.position;
    if (this.isAtOrBeforeLessonStart(sectionIndex, blockIndex, charIndex)) {
      return;
    }
    const block = this.getBlock(sectionIndex, blockIndex);
    if (!block) return;
    const text = block.text;
    const wordStart = getWordStart(text, charIndex);
    const state = this.blockStateFor(sectionIndex, blockIndex);

    const extras = state.extras.get(wordStart);
    if (extras && extras.length > 0) {
      extras.pop();
      const extrasEl = this.extrasIndex.get(`${sectionIndex}:${blockIndex}:${wordStart}`);
      if (extrasEl) renderExtras(extrasEl, extras);
      return;
    }

    if (charIndex > wordStart) {
      const newIndex = charIndex - 1;
      state.states[newIndex] = "pending";
      const span = this.spanIndex.get(charKey(sectionIndex, blockIndex, newIndex));
      if (span) setCharClass(span, "pending");
      this.position = { sectionIndex, blockIndex, charIndex: newIndex };
      return;
    }

    if (charIndex > 0) {
      // wordStart === charIndex: crossing into the previous word, which
      // ends with the delimiter space at charIndex - 1, in this block.
      const delimiterIndex = charIndex - 1;
      const prevWordStart = getWordStart(text, delimiterIndex);
      if (!wordHadError(state, prevWordStart, delimiterIndex)) return; // gated
      this.position = { sectionIndex, blockIndex, charIndex: delimiterIndex };
      this.performBackspaceStep();
      return;
    }

    // charIndex === 0 and wordStart === 0: only the previous block's last
    // word can be crossed into.
    const prevLoc = findPreviousBlock(this.book, sectionIndex, blockIndex);
    if (!prevLoc || this.isBlockBeforeLessonStart(prevLoc)) return;
    const prevBlock = this.getBlock(prevLoc.sectionIndex, prevLoc.blockIndex);
    if (!prevBlock) return;
    const prevText = prevBlock.text;
    const prevWordStart = getWordStart(prevText, prevText.length);
    const prevState = this.blockStateFor(prevLoc.sectionIndex, prevLoc.blockIndex);
    if (!wordHadError(prevState, prevWordStart, prevText.length)) return; // gated

    this.position = {
      sectionIndex: prevLoc.sectionIndex,
      blockIndex: prevLoc.blockIndex,
      charIndex: prevText.length,
    };
    this.performBackspaceStep();
  }

  // ─────────────────────────── state mutation ────────────────────────────

  private setChar(
    sectionIndex: number,
    blockIndex: number,
    charIndex: number,
    newState: BlockState["states"][number],
  ): void {
    const state = this.blockStateFor(sectionIndex, blockIndex);
    state.states[charIndex] = newState;
    const span = this.spanIndex.get(charKey(sectionIndex, blockIndex, charIndex));
    if (span) setCharClass(span, newState);
  }

  private addExtra(
    sectionIndex: number,
    blockIndex: number,
    wordStart: number,
    ch: string,
  ): void {
    const state = this.blockStateFor(sectionIndex, blockIndex);
    const list = state.extras.get(wordStart) ?? [];
    list.push(ch);
    state.extras.set(wordStart, list);
    state.wordsWithExtraError.add(wordStart);
    const extrasEl = this.extrasIndex.get(`${sectionIndex}:${blockIndex}:${wordStart}`);
    if (extrasEl) renderExtras(extrasEl, list);
    this.updateCaret();
  }

  private recordKeystroke(correct: boolean): void {
    this.totalKeystrokes += 1;
    if (correct) this.correctKeystrokes += 1;
    this.keystrokesThisSecond += 1;
  }

  private finalWordCanCommit(
    sectionIndex: number,
    blockIndex: number,
    block: Block,
  ): boolean {
    // A block boundary is also a word boundary. In word-stop mode the final
    // word must be correct before crossing it, even though there is no
    // literal delimiter space in canonical Block.text.
    const finalWordStart = getWordStart(block.text, block.text.length);
    return !(
      this.settings.stopOnError === "word" &&
      !wordIsCurrentlyCorrect(
        this.blockStateFor(sectionIndex, blockIndex),
        finalWordStart,
        block.text.length,
      )
    );
  }

  private onBlockTextComplete(): void {
    const { sectionIndex, blockIndex } = this.position;
    const block = this.getBlock(sectionIndex, blockIndex);
    if (!block) return;

    if (!this.finalWordCanCommit(sectionIndex, blockIndex, block)) {
      this.updateCaret();
      return;
    }

    const next = findNextBlock(this.book, sectionIndex, blockIndex);
    if (next !== null) {
      // Stay at the exact canonical block-end position. The separately
      // indexed pilcrow now becomes the caret target until Enter commits it.
      this.updateCaret();
      return;
    }

    // Mark the session terminal before exposing the final lesson callback so
    // a re-entrant consumer cannot type into an already-completed book.
    this.finished = true;
    this.emitLessonCheckpoint(true);
    this.opts.onSectionComplete?.(sectionIndex);
    this.clock.pause();
    this.stopActivityTimers();
    this.flushProgressSave();
    this.opts.onBookComplete?.();
  }

  private maybeEmitLessonCheckpoint(): boolean {
    return this.emitLessonCheckpoint(false);
  }

  private emitLessonCheckpoint(force: boolean): boolean {
    const nonSpaceChars =
      this.nonSpaceCharsAt(this.position) - this.lessonStartNonSpaceChars;
    if (!force && nonSpaceChars < LESSON_TARGET_NON_SPACE_CHARS) return false;
    // Do not generate empty results after a threshold checkpoint happens to
    // coincide with the final canonical boundary.
    if (this.totalKeystrokes === 0) return false;

    // Freeze the completed run, then install the next lesson before notifying
    // consumers. This mirrors Keybr's discrete LessonState handoff: callbacks
    // observe fresh zero stats, an idle clock, and already-mounted next text,
    // while the argument remains the immutable completed snapshot.
    this.clock.pause();
    this.stopActivityTimers();
    const stats = Object.freeze(this.getStats());
    const position = this.getPosition();
    this.resetLessonScore();
    this.lessonStartPosition = position;
    this.lessonStartNonSpaceChars = this.nonSpaceCharsAt(position);
    if (this.started && this.dom) {
      this.rebuildRenderWindow();
      this.dom.viewportEl.scrollTop = 0;
      this.updateCaret();
    }
    const callback = this.opts.onLessonComplete ?? this.opts.onBlockComplete;
    callback?.(stats, position);
    return true;
  }

  private resetLessonScore(): void {
    this.stopActivityTimers();
    this.totalKeystrokes = 0;
    this.correctKeystrokes = 0;
    this.keystrokesThisSecond = 0;
    this.rawWpmSamples = [];
    this.clock.reset();
  }

  private advancePastBoundary(next: {
    sectionIndex: number;
    blockIndex: number;
  }): void {
    const completedSectionIndex = this.position.sectionIndex;
    if (next.sectionIndex !== completedSectionIndex) {
      this.opts.onSectionComplete?.(completedSectionIndex);
    }
    this.position = { ...next, charIndex: 0 };
    this.onBlockChanged();
  }

  private setBoundaryState(
    sectionIndex: number,
    blockIndex: number,
    state: BoundaryState,
  ): void {
    const marker = this.boundaryIndex.get(blockKey(sectionIndex, blockIndex));
    if (marker) setBoundaryClass(marker, state);
  }

  private boundaryErrorCount(sectionIndex: number, blockIndex: number): number {
    return this.boundaryErrors.get(blockKey(sectionIndex, blockIndex)) ?? 0;
  }

  private onBlockChanged(): void {
    // A Monkeytype-style line flow stays mounted while the caret moves
    // through it. Rebuilding at every EPUB block boundary changes wrapping
    // and makes completed text vanish even when it shares the active row.
    if (!this.renderedBlocks.has(blockKey(this.position.sectionIndex, this.position.blockIndex))) {
      this.rebuildRenderWindow();
    }
    this.updateCaret();
  }

  // ────────────────────────────── rendering ──────────────────────────────

  private blockStateFor(sectionIndex: number, blockIndex: number): BlockState {
    const key = blockKey(sectionIndex, blockIndex);
    let state = this.blockStates.get(key);
    if (!state) {
      const block = this.getBlock(sectionIndex, blockIndex);
      state = createBlockState(block ? block.text.length : 0);
      this.blockStates.set(key, state);
    }
    return state;
  }

  private initializeResumeState(position: Position): void {
    const block = this.getBlock(position.sectionIndex, position.blockIndex);
    if (!block) return;
    const state = this.blockStateFor(position.sectionIndex, position.blockIndex);
    const completedPrefix = Math.min(position.charIndex, block.text.length);
    for (let i = 0; i < completedPrefix; i++) {
      if (state.states[i] === "pending") state.states[i] = "correct";
    }
  }

  private getBlock(sectionIndex: number, blockIndex: number): Block | undefined {
    return this.book.sections[sectionIndex]?.blocks[blockIndex];
  }

  private renderedCharState(
    sectionIndex: number,
    blockIndex: number,
    charIndex: number,
  ): BlockState["states"][number] {
    const state = this.blockStateFor(sectionIndex, blockIndex).states[charIndex] ?? "pending";
    if (state !== "pending") return state;

    // Progress persistence stores an exact position, not a character-class
    // history. On resume, everything before that position is necessarily
    // completed and should read as completed in the retained line above.
    const current = this.position;
    const isBefore =
      sectionIndex < current.sectionIndex ||
      (sectionIndex === current.sectionIndex && blockIndex < current.blockIndex) ||
      (sectionIndex === current.sectionIndex &&
        blockIndex === current.blockIndex &&
        charIndex < current.charIndex);
    return isBefore ? "correct" : "pending";
  }

  private renderedBoundaryState(
    sectionIndex: number,
    blockIndex: number,
  ): BoundaryState {
    if (this.boundaryErrorCount(sectionIndex, blockIndex) > 0) {
      return "incorrect";
    }
    const current = this.position;
    const isBefore =
      sectionIndex < current.sectionIndex ||
      (sectionIndex === current.sectionIndex && blockIndex < current.blockIndex);
    return isBefore ? "correct" : "pending";
  }

  private isBlockBeforeLessonStart(loc: {
    sectionIndex: number;
    blockIndex: number;
  }): boolean {
    const s = this.lessonStartPosition;
    if (loc.sectionIndex !== s.sectionIndex) return loc.sectionIndex < s.sectionIndex;
    return loc.blockIndex < s.blockIndex;
  }

  private isAtOrBeforeLessonStart(
    sectionIndex: number,
    blockIndex: number,
    charIndex: number,
  ): boolean {
    const start = this.lessonStartPosition;
    if (sectionIndex !== start.sectionIndex) return sectionIndex < start.sectionIndex;
    if (blockIndex !== start.blockIndex) return blockIndex < start.blockIndex;
    return charIndex <= start.charIndex;
  }

  private collectWindowBlocks(): RenderedBlock[] {
    const result: RenderedBlock[] = [];
    if (!hasTypeableContent(this.book)) return result;

    // Render the active lesson suffix of the current EPUB section. A rolling
    // checkpoint may begin inside a long prose block; startCharIndex hides
    // the completed lesson without changing any canonical span keys.
    const section = this.book.sections[this.position.sectionIndex];
    if (!section?.included) return result;
    const startsInThisSection =
      this.lessonStartPosition.sectionIndex === this.position.sectionIndex;
    const firstBlockIndex = startsInThisSection
      ? this.lessonStartPosition.blockIndex
      : 0;
    for (const [blockIndex, block] of section.blocks.entries()) {
      if (block.text.length === 0) continue;
      if (blockIndex < firstBlockIndex) continue;
      result.push({
        sectionIndex: this.position.sectionIndex,
        blockIndex,
        block,
        startCharIndex:
          startsInThisSection && blockIndex === firstBlockIndex
            ? getWordStart(block.text, this.lessonStartPosition.charIndex)
            : 0,
        hasBoundary:
          findNextBlock(this.book, this.position.sectionIndex, blockIndex) !== null,
      });
    }

    return result;
  }

  /** Absolute non-space canonical character count before `position`.
   * Deriving lesson length from Position keeps wrong keys and Backspace from
   * incrementally corrupting checkpoint accounting. */
  private nonSpaceCharsAt(position: Position): number {
    return canonicalNonSpaceCharsAt(this.canonicalNonSpaceIndex, position);
  }

  private rebuildRenderWindow(): void {
    const dom = this.dom;
    if (!dom) return;
    const blocks = this.collectWindowBlocks();
    const refs = renderWindow(
      dom.textEl,
      blocks,
      (si, bi, ci) => this.renderedCharState(si, bi, ci),
      (si, bi, ws) => this.blockStateFor(si, bi).extras.get(ws) ?? [],
      (si, bi) => this.renderedBoundaryState(si, bi),
    );
    this.spanIndex = refs.spanIndex;
    this.extrasIndex = refs.extrasIndex;
    this.boundaryIndex = refs.boundaryIndex;
    this.renderedBlocks = new Set(refs.blockElIndex.keys());
  }

  private computeCaretAnchor(): { span: HTMLElement | null; after: boolean } {
    const { sectionIndex, blockIndex, charIndex } = this.position;
    const block = this.getBlock(sectionIndex, blockIndex);
    if (!block) return { span: null, after: false };

    if (charIndex < block.text.length) {
      const wordStart = getWordStart(block.text, charIndex);
      const extras = this.blockStateFor(sectionIndex, blockIndex).extras.get(wordStart);
      if (extras && extras.length > 0) {
        const extrasEl = this.extrasIndex.get(`${sectionIndex}:${blockIndex}:${wordStart}`);
        const last = extrasEl?.lastElementChild as HTMLElement | null | undefined;
        if (last) return { span: last, after: true };
      }
      const span = this.spanIndex.get(charKey(sectionIndex, blockIndex, charIndex)) ?? null;
      return { span, after: false };
    }

    const boundary = this.boundaryIndex.get(blockKey(sectionIndex, blockIndex));
    if (boundary) return { span: boundary, after: false };

    const lastIndex = block.text.length - 1;
    const span =
      lastIndex >= 0
        ? this.spanIndex.get(charKey(sectionIndex, blockIndex, lastIndex)) ?? null
        : null;
    return { span, after: true };
  }

  private updateCaret(): void {
    const dom = this.dom;
    if (!dom) return;
    const anchor = this.computeCaretAnchor();
    positionCaret(dom.caretEl, dom.viewportEl, anchor.span, this.settings.caretStyle, anchor.after);
    this.adjustScroll(anchor.span);
  }

  private adjustScroll(anchorSpan: HTMLElement | null): void {
    const dom = this.dom;
    if (!dom || !anchorSpan) return;
    const targetRect = anchorSpan.getBoundingClientRect();
    const viewportRect = dom.viewportEl.getBoundingClientRect();
    const fontSizePx = parseFloat(getComputedStyle(dom.rootEl).fontSize || "0");
    const lineHeight = fontSizePx ? fontSizePx * 1.6 : 0;
    const activeTop = targetRect.top - viewportRect.top + dom.viewportEl.scrollTop;
    keepLineInView(
      dom.viewportEl,
      activeTop,
      lineHeight,
      this.settings.contextLines,
    );
  }

  // ─────────────────────────────── timers ────────────────────────────────

  private ensureTimersRunning(): void {
    if (this.sampleTimer === null) {
      this.sampleTimer = setInterval(() => {
        if (this.clock.isRunning()) {
          this.rawWpmSamples.push(calculateWpm(this.keystrokesThisSecond, SAMPLE_INTERVAL_MS));
        }
        this.keystrokesThisSecond = 0;
      }, SAMPLE_INTERVAL_MS);
    }
    if (this.statsTimer === null) {
      this.statsTimer = setInterval(() => {
        this.opts.onStats?.(this.getStats());
      }, STATS_INTERVAL_MS);
    }
  }

  private stopActivityTimers(): void {
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private scheduleProgressSave(): void {
    this.progressDirty = true;
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => this.flushProgressSave(), PROGRESS_DEBOUNCE_MS);
  }

  private flushProgressSave(): void {
    if (this.progressTimer !== null) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    if (!this.progressDirty) return;
    this.progressDirty = false;
    this.opts.onProgress?.(this.getPosition(), this.charsCompletedEstimate());
  }

  private charsCompletedEstimate(): number {
    let total = 0;
    for (let si = 0; si < this.book.sections.length; si++) {
      const section = this.book.sections[si]!;
      if (!section.included) continue;
      if (si < this.position.sectionIndex) {
        total += section.charCount;
        continue;
      }
      if (si > this.position.sectionIndex) break;
      for (let bi = 0; bi < section.blocks.length; bi++) {
        if (bi < this.position.blockIndex) {
          total += section.blocks[bi]!.text.length;
        } else if (bi === this.position.blockIndex) {
          total += this.position.charIndex;
        } else {
          break;
        }
      }
    }
    return total;
  }
}

export { calculateWpm, calculateAccuracy, calculateConsistency } from "./stats";
