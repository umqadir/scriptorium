import { describe, expect, test } from "vitest";
import {
  calculateWpm,
  calculateAccuracy,
  calculateConsistency,
  mean,
  stdDev,
} from "../../src/engine/stats";

describe("mean / stdDev", () => {
  test("mean of a simple array", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  test("mean of empty array is 0", () => {
    expect(mean([])).toBe(0);
  });

  test("stdDev of identical values is 0", () => {
    expect(stdDev([50, 50, 50])).toBe(0);
  });

  test("stdDev hand-computed", () => {
    // values 40,60,80 -> mean 60, variance ((20^2+0+20^2)/3) = 266.667, sqrt ~= 16.33
    expect(stdDev([40, 60, 80])).toBeCloseTo(16.3299, 3);
  });
});

describe("calculateWpm", () => {
  test("100 chars in 60000ms -> 20 wpm (100/5/1min)", () => {
    expect(calculateWpm(100, 60000)).toBeCloseTo(20, 6);
  });

  test("hand-computed: 250 chars in 30000ms (0.5 min) -> 100 wpm", () => {
    // 250 / 5 = 50 words; 50 / 0.5 min = 100 wpm
    expect(calculateWpm(250, 30000)).toBeCloseTo(100, 6);
  });

  test("zero duration -> 0 (degenerate case)", () => {
    expect(calculateWpm(100, 0)).toBe(0);
  });

  test("negative duration -> 0", () => {
    expect(calculateWpm(100, -500)).toBe(0);
  });

  test("zero chars -> 0", () => {
    expect(calculateWpm(0, 60000)).toBe(0);
  });
});

describe("calculateAccuracy", () => {
  test("hand-computed: 90 correct of 100 -> 90", () => {
    expect(calculateAccuracy(90, 100)).toBe(90);
  });

  test("all correct -> 100", () => {
    expect(calculateAccuracy(50, 50)).toBe(100);
  });

  test("all wrong -> 0", () => {
    expect(calculateAccuracy(0, 50)).toBe(0);
  });

  test("zero keystrokes (degenerate) -> 100, not NaN", () => {
    expect(calculateAccuracy(0, 0)).toBe(100);
  });

  test("clamped into [0, 100] even with pathological input", () => {
    expect(calculateAccuracy(150, 100)).toBe(100);
    expect(calculateAccuracy(-10, 100)).toBe(0);
  });
});

describe("calculateConsistency", () => {
  test("zero samples (degenerate) -> 0", () => {
    expect(calculateConsistency([])).toBe(0);
  });

  test("a single sample (degenerate) -> 100, no variation observed", () => {
    expect(calculateConsistency([73])).toBe(100);
  });

  test("identical samples -> 100 (perfectly consistent)", () => {
    expect(calculateConsistency([60, 60, 60, 60])).toBe(100);
  });

  test("hand-computed: [40, 60, 80] -> 100 * (1 - stdDev/mean)", () => {
    // mean 60, stdDev ~16.3299, cov ~0.27216, consistency ~72.78
    expect(calculateConsistency([40, 60, 80])).toBeCloseTo(72.7835, 3);
  });

  test("high variance samples produce low but non-negative consistency", () => {
    const c = calculateConsistency([10, 200, 5, 300, 1]);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(50);
  });

  test("clamped to 0 even for pathological high-variance input", () => {
    // stdDev/mean can exceed 1 if the samples are skewed enough; consistency
    // must never go negative.
    const c = calculateConsistency([1, 1, 1, 1, 1000]);
    expect(c).toBeGreaterThanOrEqual(0);
  });

  test("all-zero samples -> 100 (mean is 0, avoid NaN from 0/0)", () => {
    expect(calculateConsistency([0, 0, 0])).toBe(100);
  });
});
