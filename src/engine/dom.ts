/**
 * DOM construction and low-level mutation helpers for the typing renderer.
 *
 * Performance contract: `renderWindow` is the only function that rebuilds
 * markup wholesale, and it is only called for lesson mount/handoff or
 * explicit navigation, never per keystroke.
 * Per-keystroke updates go through `setCharClass` / `renderExtras`, which
 * mutate exactly the span(s) that changed.
 */

import {
  type Block,
  type CaretStyle,
  type Settings,
  type CharState,
} from "../types";

export type DomRefs = {
  rootEl: HTMLDivElement;
  viewportEl: HTMLDivElement;
  textEl: HTMLDivElement;
  caretEl: HTMLDivElement;
  hiddenInputEl: HTMLInputElement;
};

export function blockKey(sectionIndex: number, blockIndex: number): string {
  return `${sectionIndex}:${blockIndex}`;
}

export function charKey(
  sectionIndex: number,
  blockIndex: number,
  charIndex: number,
): string {
  return `${sectionIndex}:${blockIndex}:${charIndex}`;
}

export function buildDom(
  container: HTMLElement,
  settings: Settings,
): DomRefs {
  const rootEl = document.createElement("div");
  rootEl.className = "scr-root";

  const viewportEl = document.createElement("div");
  viewportEl.className = "scr-viewport";

  const textEl = document.createElement("div");
  textEl.className = "scr-text";

  const caretEl = document.createElement("div");
  caretEl.className = "scr-caret";

  const hiddenInputEl = document.createElement("input");
  hiddenInputEl.type = "text";
  hiddenInputEl.className = "scr-hidden-input";
  hiddenInputEl.autocomplete = "off";
  hiddenInputEl.setAttribute("autocorrect", "off");
  hiddenInputEl.setAttribute("autocapitalize", "off");
  hiddenInputEl.spellcheck = false;
  hiddenInputEl.setAttribute("aria-label", "Typing input");
  hiddenInputEl.tabIndex = 0;

  viewportEl.appendChild(textEl);
  viewportEl.appendChild(caretEl);
  rootEl.appendChild(viewportEl);
  rootEl.appendChild(hiddenInputEl);
  container.appendChild(rootEl);

  applyFont(rootEl, settings);
  applyVisibleLineCount(rootEl, settings.contextLines);
  applyCaretStyle(caretEl, settings.caretStyle);
  applySmoothCaret(caretEl, settings.smoothCaret);

  return { rootEl, viewportEl, textEl, caretEl, hiddenInputEl };
}

export function applyFont(rootEl: HTMLElement, settings: Settings): void {
  rootEl.style.setProperty("--scr-font-family", settings.fontFamily);
  rootEl.style.setProperty("--scr-font-size", `${settings.fontSize}rem`);
}

export function applyVisibleLineCount(
  rootEl: HTMLElement,
  _value: unknown,
): void {
  // Compatibility no-op for callers compiled against the former scrolling
  // viewport. A finite lesson expands to its full wrapped height.
  rootEl.style.removeProperty("--scr-viewport-height");
}

export function applyCaretStyle(
  caretEl: HTMLElement,
  style: CaretStyle,
): void {
  caretEl.className = `scr-caret scr-caret--${style}`;
}

export function applySmoothCaret(caretEl: HTMLElement, smooth: boolean): void {
  caretEl.classList.toggle("scr-caret--smooth", smooth);
}

export type RenderedBlock = {
  sectionIndex: number;
  blockIndex: number;
  block: Block;
  /** First canonical Block.text index to render for a lesson handoff. */
  startCharIndex?: number;
  /** Exclusive canonical Block.text bound for this finite lesson. */
  endCharIndex?: number;
  /** Whether another typeable block follows this one in reading order. */
  hasBoundary?: boolean;
};

export type BoundaryState = "pending" | "correct" | "incorrect";

export type WindowRefs = {
  spanIndex: Map<string, HTMLSpanElement>;
  extrasIndex: Map<string, HTMLSpanElement>;
  boundaryIndex: Map<string, HTMLSpanElement>;
  blockElIndex: Map<string, HTMLDivElement>;
};

/** Whether a non-collapsed browser selection touches the rendered passage. */
export function selectionIntersectsText(
  textEl: HTMLElement,
  selection: Selection | null,
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(textEl)) return true;
    } catch {
      // A selection can briefly retain a detached range during lesson swaps.
    }
  }
  return false;
}

/**
 * Serialize only selected canonical book characters. Visual error extras,
 * caret elements, and the synthetic pilcrow never leak into copied text.
 * Source blocks are separated with a real newline.
 */
export function selectedCanonicalText(
  textEl: HTMLElement,
  selection: Selection | null,
): string | null {
  if (!selectionIntersectsText(textEl, selection) || !selection) return null;

  const selected: Array<{ block: Element; text: string }> = [];
  for (const span of textEl.querySelectorAll<HTMLElement>(
    ".scr-char:not(.scr-char--extra)",
  )) {
    let intersects = false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      try {
        if (selection.getRangeAt(index).intersectsNode(span)) {
          intersects = true;
          break;
        }
      } catch {
        // Ignore detached ranges while the finite lesson is being replaced.
      }
    }
    if (!intersects) continue;
    const block = span.closest(".scr-block");
    if (block) selected.push({ block, text: span.textContent ?? "" });
  }
  if (selected.length === 0) return null;

  let result = "";
  let previousBlock: Element | null = null;
  for (const item of selected) {
    if (previousBlock && item.block !== previousBlock) result += "\n";
    result += item.text;
    previousBlock = item.block;
  }
  return result;
}

/** Serialize the complete mounted passage as source text. */
export function canonicalTextContent(textEl: HTMLElement): string {
  let result = "";
  let previousBlock: Element | null = null;
  for (const span of textEl.querySelectorAll<HTMLElement>(
    ".scr-char:not(.scr-char--extra)",
  )) {
    const block = span.closest(".scr-block");
    if (!block) continue;
    if (previousBlock && block !== previousBlock) result += "\n";
    result += span.textContent ?? "";
    previousBlock = block;
  }
  return result;
}

/** Rebuild the finite lesson fragment, never as a per-keystroke update. */
export function renderWindow(
  textEl: HTMLElement,
  blocks: RenderedBlock[],
  charStateOf: (
    sectionIndex: number,
    blockIndex: number,
    charIndex: number,
  ) => CharState,
  extrasOf: (
    sectionIndex: number,
    blockIndex: number,
    wordStart: number,
  ) => string[],
  boundaryStateOf: (
    sectionIndex: number,
    blockIndex: number,
  ) => BoundaryState = () => "pending",
): WindowRefs {
  textEl.innerHTML = "";
  const spanIndex = new Map<string, HTMLSpanElement>();
  const extrasIndex = new Map<string, HTMLSpanElement>();
  const boundaryIndex = new Map<string, HTMLSpanElement>();
  const blockElIndex = new Map<string, HTMLDivElement>();

  for (const {
    sectionIndex,
    blockIndex,
    block,
    startCharIndex = 0,
    endCharIndex = block.text.length,
    hasBoundary = false,
  } of blocks) {
    const blockEl = document.createElement("div");
    blockEl.className = `scr-block scr-block--${block.kind}`;
    blockElIndex.set(blockKey(sectionIndex, blockIndex), blockEl);

    const text = block.text;
    const renderStart = Math.min(
      text.length,
      Math.max(0, Number.isFinite(startCharIndex) ? Math.floor(startCharIndex) : 0),
    );
    const renderEnd = Math.min(
      text.length,
      Math.max(
        renderStart,
        Number.isFinite(endCharIndex) ? Math.floor(endCharIndex) : text.length,
      ),
    );
    // A resume can begin mid-word, while lesson checkpoints always begin
    // just after a canonical delimiter. Either way, extras retain their
    // canonical word-start key rather than being renumbered to the slice.
    let wordStart = getCanonicalWordStart(text, renderStart);
    let wordEl = document.createElement("span");
    wordEl.className = "scr-word";

    const finishWord = (
      delimiter?: HTMLSpanElement,
      appendBoundary = false,
    ): void => {
      const extrasEl = document.createElement("span");
      extrasEl.className = "scr-extras";
      for (const extraCh of extrasOf(sectionIndex, blockIndex, wordStart)) {
        extrasEl.appendChild(makeExtraSpan(extraCh));
      }
      wordEl.appendChild(extrasEl);
      // Keep the canonical delimiter inside the word's flex item. This is
      // the same visual model Monkeytype uses: the browser may wrap between
      // words, never between a word and its following space.
      if (delimiter) wordEl.appendChild(delimiter);
      if (appendBoundary) {
        const boundaryEl = document.createElement("span");
        setBoundaryClass(boundaryEl, boundaryStateOf(sectionIndex, blockIndex));
        boundaryEl.textContent = "¶";
        boundaryEl.setAttribute("aria-label", "Press Enter for new line");
        wordEl.appendChild(boundaryEl);
        boundaryIndex.set(blockKey(sectionIndex, blockIndex), boundaryEl);
      }
      extrasIndex.set(`${sectionIndex}:${blockIndex}:${wordStart}`, extrasEl);
      blockEl.appendChild(wordEl);
    };

    for (let i = renderStart; i < renderEnd; i++) {
      const ch = text[i]!;
      const span = document.createElement("span");
      span.className = `scr-char scr-char--${charStateOf(sectionIndex, blockIndex, i)}`;
      span.textContent = ch;
      if (ch === " ") span.classList.add("scr-char--space");
      spanIndex.set(charKey(sectionIndex, blockIndex, i), span);

      const isDelimiter = ch === " ";
      const isLastRenderedChar = i === renderEnd - 1;
      const isBlockLastChar = i === text.length - 1;
      if (isDelimiter) {
        if (isBlockLastChar) wordEl.classList.add("scr-word--block-end");
        finishWord(span, isBlockLastChar && hasBoundary);
        wordStart = i + 1;
        wordEl = document.createElement("span");
        wordEl.className = "scr-word";
      } else {
        wordEl.appendChild(span);
        if (isLastRenderedChar) {
          if (isBlockLastChar) wordEl.classList.add("scr-word--block-end");
          finishWord(undefined, isBlockLastChar && hasBoundary);
        }
      }
    }

    // A persisted position may be waiting exactly at a non-final block's
    // pilcrow. Render that target even though no canonical chars remain.
    if (renderStart === renderEnd && renderEnd === text.length && hasBoundary) {
      wordEl.classList.add("scr-word--block-end");
      finishWord(undefined, true);
    }

    // Deterministic, source-line-local widow prevention. Keeping the final
    // two word wrappers in one outer flex item prevents a genuinely wrapped
    // final word from becoming a singleton row. The tail never spans blocks,
    // so explicit prose/verse boundaries and canonical keys remain intact.
    // CSS permits an internal wrap only when the pair itself is wider than
    // the entire available viewport.
    const renderedWords = Array.from(blockEl.children).filter(
      (child): child is HTMLSpanElement => child.classList.contains("scr-word"),
    );
    if (renderedWords.length >= 2) {
      const penultimateWord = renderedWords.at(-2)!;
      const finalWord = renderedWords.at(-1)!;
      const lineTailEl = document.createElement("span");
      lineTailEl.className = "scr-line-tail";
      blockEl.insertBefore(lineTailEl, penultimateWord);
      lineTailEl.appendChild(penultimateWord);
      lineTailEl.appendChild(finalWord);
    }

    if (hasBoundary) {
      const lineBreakEl = document.createElement("span");
      lineBreakEl.className = "scr-line-break";
      lineBreakEl.setAttribute("aria-hidden", "true");
      blockEl.appendChild(lineBreakEl);
    }

    textEl.appendChild(blockEl);
  }

  return { spanIndex, extrasIndex, boundaryIndex, blockElIndex };
}

function getCanonicalWordStart(text: string, index: number): number {
  if (index <= 0) return 0;
  return text.lastIndexOf(" ", index - 1) + 1;
}

function makeExtraSpan(ch: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "scr-char scr-char--incorrect scr-char--extra";
  span.textContent = ch;
  return span;
}

export function setCharClass(span: HTMLSpanElement, state: CharState): void {
  const isSpace = span.classList.contains("scr-char--space");
  span.className = `scr-char scr-char--${state}${isSpace ? " scr-char--space" : ""}`;
}

export function setBoundaryClass(
  span: HTMLSpanElement,
  state: BoundaryState,
): void {
  span.className = `scr-boundary scr-boundary--${state}`;
}

export function renderExtras(extrasEl: HTMLSpanElement, chars: string[]): void {
  extrasEl.innerHTML = "";
  for (const ch of chars) extrasEl.appendChild(makeExtraSpan(ch));
}

/**
 * Position the caret element relative to the viewport. `anchor` is the span
 * the caret should sit before (line/underline styles) or over (block
 * style); pass `after: true` to instead sit just after it (used when
 * trailing extra characters are present).
 */
export function positionCaret(
  caretEl: HTMLElement,
  viewportEl: HTMLElement,
  anchor: HTMLElement | null,
  style: CaretStyle,
  after: boolean,
): void {
  if (style === "off" || !anchor) {
    caretEl.style.opacity = "0";
    return;
  }
  caretEl.style.opacity = "";

  const viewportRect = viewportEl.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const scrollTop = viewportEl.scrollTop;
  const scrollLeft = viewportEl.scrollLeft;

  const top = anchorRect.top - viewportRect.top + scrollTop;
  const height = anchorRect.height || 0;
  let left = anchorRect.left - viewportRect.left + scrollLeft;
  let width = anchorRect.width || 0;

  if (style === "underline") {
    if (after) left += width;
    const thickness = Math.max(1, height * 0.08);
    caretEl.style.width = `${width}px`;
    caretEl.style.height = `${thickness}px`;
    caretEl.style.transform = `translate(${left}px, ${top + height - thickness}px)`;
    return;
  }

  if (style === "block") {
    // Sit over the character itself.
    if (after) left = left + width;
    caretEl.style.width = `${width}px`;
  } else {
    // line: a thin bar before (or after) the character.
    if (after) left = left + width;
    width = 0;
    caretEl.style.width = "";
  }

  caretEl.style.transform = `translate(${left}px, ${top}px)`;
  caretEl.style.height = `${height}px`;
}
