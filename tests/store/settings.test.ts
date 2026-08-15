import { describe, expect, test } from "vitest";
import { mergeSettings } from "../../src/store/settings";
import { DEFAULT_SETTINGS } from "../../src/types";

describe("mergeSettings", () => {
  test("returns defaults when given undefined/null", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  test("fills in defaults for missing fields (older schema record)", () => {
    const partial = { theme: "8008", fontSize: 2 };
    const merged = mergeSettings(partial);
    expect(merged.theme).toBe("8008");
    expect(merged.fontSize).toBe(2);
    // everything else falls back to defaults
    expect(merged.caretStyle).toBe(DEFAULT_SETTINGS.caretStyle);
    expect(merged.stopOnError).toBe(DEFAULT_SETTINGS.stopOnError);
    expect(merged.foldAccents).toBe(DEFAULT_SETTINGS.foldAccents);
    expect(merged.contextLines).toBe(DEFAULT_SETTINGS.contextLines);
    expect(merged.lessonLength).toBe(DEFAULT_SETTINGS.lessonLength);
  });

  test("does not mutate the input object", () => {
    const partial = { theme: "8008" };
    const frozen = Object.freeze({ ...partial });
    expect(() => mergeSettings(frozen)).not.toThrow();
  });

  test("preserves valid explicit falsy booleans and rejects an out-of-range zero font size", () => {
    const merged = mergeSettings({ smoothCaret: false, soundOnClick: false, fontSize: 0 });
    expect(merged.smoothCaret).toBe(false);
    expect(merged.soundOnClick).toBe(false);
    expect(merged.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  test("ignores unknown extra fields without throwing", () => {
    const merged = mergeSettings({ theme: "8008", somethingFromTheFuture: true } as never);
    expect(merged.theme).toBe("8008");
    expect((merged as Record<string, unknown>)["somethingFromTheFuture"]).toBeUndefined();
  });

  test("defaults invalid types, enum values, and out-of-range numbers field-by-field", () => {
    const merged = mergeSettings({
      theme: "future-theme",
      fontFamily: 123,
      fontSize: Number.POSITIVE_INFINITY,
      caretStyle: "sparkles",
      smoothCaret: "yes",
      stopOnError: "sentence",
      foldAccents: 1,
      soundOnClick: null,
      showLiveWpm: {},
      contextLines: 2.5,
      lessonLength: 137,
    } as never);

    expect(merged).toEqual({ ...DEFAULT_SETTINGS, theme: "future-theme" });
    expect(mergeSettings({ fontSize: -1, contextLines: 9 } as never)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ fontSize: 0.7 } as never).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  test("accepts only integer visible-line counts from 2 through 8", () => {
    expect(mergeSettings({ contextLines: 2 }).contextLines).toBe(2);
    expect(mergeSettings({ contextLines: 8 }).contextLines).toBe(8);
    for (const contextLines of [0, 1, 2.5, 9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mergeSettings({ contextLines }).contextLines).toBe(
        DEFAULT_SETTINGS.contextLines,
      );
    }
  });

  test("accepts only 100–200 lesson targets in 25-character steps", () => {
    for (const lessonLength of [100, 125, 150, 175, 200]) {
      expect(mergeSettings({ lessonLength }).lessonLength).toBe(lessonLength);
    }
    for (const lessonLength of [0, 99, 101, 137, 225, 150.5, Number.NaN, Infinity]) {
      expect(mergeSettings({ lessonLength }).lessonLength).toBe(
        DEFAULT_SETTINGS.lessonLength,
      );
    }
  });

  test("returns only allowlisted fields", () => {
    const sentinel = "PRIVATE_BOOK_TEXT_SENTINEL";
    const merged = mergeSettings({ ...DEFAULT_SETTINGS, bookText: sentinel } as never);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(JSON.stringify(merged)).not.toContain(sentinel);
  });

  test("a fully-specified settings object round-trips unchanged", () => {
    const full = {
      theme: "wavez",
      fontFamily: "Custom Mono",
      fontSize: 2.5,
      caretStyle: "block" as const,
      smoothCaret: false,
      stopOnError: "word" as const,
      foldAccents: false,
      soundOnClick: true,
      showLiveWpm: false,
      contextLines: 5,
      lessonLength: 175,
    };
    expect(mergeSettings(full)).toEqual(full);
  });
});
