/**
 * Pure statistics functions for the typing engine.
 *
 * These are intentionally free of any DOM/session state so they can be unit
 * tested directly against hand-computed values. See SPEC.md "Typing engine":
 *
 *   WPM = chars / 5 / minutes; raw counts every keystroke, net counts
 *   correct ones. Accuracy = correct / total keystrokes. Consistency =
 *   100 * (1 - CoV) over per-second raw WPM samples, clamped to 0-100.
 */

/** Arithmetic mean. Returns 0 for an empty array (degenerate case). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation. Returns 0 for an empty array. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / values.length);
}

/**
 * WPM from a character count and elapsed duration.
 * Standard 5-chars-per-word convention. Zero/negative duration -> 0 (avoids
 * Infinity/NaN when called before the timer has started).
 */
export function calculateWpm(chars: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || chars <= 0) return 0;
  const minutes = elapsedMs / 60000;
  return chars / 5 / minutes;
}

/**
 * Accuracy percentage from correct vs total keystrokes.
 * With zero keystrokes typed there have been no mistakes yet, so we report
 * 100 rather than NaN - this is the sensible "nothing has gone wrong" default
 * for a session that hasn't started.
 */
export function calculateAccuracy(correct: number, total: number): number {
  if (total <= 0) return 100;
  const pct = (correct / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Consistency from a series of per-second raw-WPM samples, using the
 * coefficient of variation: consistency = 100 * (1 - stdDev/mean), clamped
 * to [0, 100].
 *
 * Degenerate cases:
 *  - 0 samples -> 0 (nothing to judge consistency from)
 *  - 1 sample, or a mean of 0 -> 100 (no variation observed)
 */
export function calculateConsistency(samples: number[]): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return 100;
  const m = mean(samples);
  if (m === 0) return 100;
  const cov = stdDev(samples) / m;
  const consistency = 100 * (1 - cov);
  return Math.max(0, Math.min(100, consistency));
}
