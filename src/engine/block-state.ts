/**
 * Per-block typing state: the character states shown as CSS classes, plus
 * the bookkeeping needed to implement Monkeytype's backspace rules and
 * "extra characters" behaviour without ever touching Block.text itself.
 */

import type { CharState } from "../types";

export type BlockState = {
  /** One entry per character in Block.text. */
  states: CharState[];
  /** Permanent-once-true per index: "this character was ever typed wrong."
   * Drives the correct/corrected distinction even across repeated
   * backspace + retype cycles. */
  hadError: boolean[];
  /** Characters typed past the natural end of a word (before its
   * delimiter space, or before the end of the block for the last word),
   * keyed by that word's start index. Always rendered/counted as errors. */
  extras: Map<number, string[]>;
  /** Permanent history for words that ever received an extra character.
   * This is deliberately separate from `extras`: removing the visible extra
   * fixes the current word, but the completed word must still remain
   * backspace-accessible under Monkeytype's "had an error" rule. */
  wordsWithExtraError: Set<number>;
};

export function createBlockState(length: number): BlockState {
  return {
    states: new Array<CharState>(length).fill("pending"),
    hadError: new Array<boolean>(length).fill(false),
    extras: new Map(),
    wordsWithExtraError: new Set(),
  };
}

/** Whether the word is correct *right now*. Corrected characters are valid;
 * pending/incorrect characters and visible extras are not. This must remain
 * separate from permanent error history so stopOnError="word" can unblock
 * after the user fixes a mistake. */
export function wordIsCurrentlyCorrect(
  state: BlockState,
  wordStart: number,
  wordEnd: number,
): boolean {
  const extras = state.extras.get(wordStart);
  if (extras && extras.length > 0) return false;
  for (let i = wordStart; i < wordEnd; i++) {
    const charState = state.states[i];
    if (charState !== "correct" && charState !== "corrected") return false;
  }
  return true;
}

/** Whether the word occupying [wordStart, wordEnd) has ever contained a
 * mistake - either a wrong real character or any extra characters. */
export function wordHadError(
  state: BlockState,
  wordStart: number,
  wordEnd: number,
): boolean {
  if (state.wordsWithExtraError.has(wordStart)) return true;
  for (let i = wordStart; i < wordEnd; i++) {
    if (state.hadError[i]) return true;
  }
  return false;
}
