import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  BookProgress,
  LessonAnchor,
  LessonHistoryRecord,
  LessonNavigationState,
} from "../../src/types";

const mocks = vi.hoisted(() => {
  const stored = { value: undefined as unknown };
  const get = vi.fn(async () => stored.value);
  const put = vi.fn(async (_store: string, value: unknown) => {
    stored.value = value;
  });
  const deleteRecord = vi.fn(async () => {});
  const storeDelete = vi.fn(async () => {});
  const objectStore = vi.fn(() => ({ delete: storeDelete }));
  const transaction = vi.fn(() => ({
    objectStore,
    done: Promise.resolve(),
  }));
  return {
    stored,
    get,
    put,
    deleteRecord,
    storeDelete,
    objectStore,
    transaction,
  };
});

vi.mock("../../src/store/db", () => ({
  getDb: async () => ({
    get: mocks.get,
    put: mocks.put,
    delete: mocks.deleteRecord,
    transaction: mocks.transaction,
  }),
}));

import { deleteBook } from "../../src/store/books";
import {
  clearLessonNavigation,
  getLessonNavigation,
  LESSON_HISTORY_LIMIT,
  sanitizeLessonNavigationState,
  saveReaderCheckpoint,
  saveLessonNavigation,
} from "../../src/store/lesson-navigation";

function anchor(index = 0, overrides: Partial<LessonAnchor> = {}): LessonAnchor {
  return {
    start: { sectionIndex: 0, blockIndex: index, charIndex: 0 },
    end: { sectionIndex: 0, blockIndex: index, charIndex: 10 },
    targetNonSpaceChars: 100,
    plannerVersion: 1,
    ...overrides,
  };
}

function historyRecord(index = 0): LessonHistoryRecord {
  return {
    anchor: anchor(index),
    outcome: "completed",
    result: {
      wpm: 72.5,
      rawWpm: 75,
      accuracy: 98.2,
      consistency: 91,
      charsTyped: 100,
      errors: 2,
      elapsedMs: 20_000,
    },
  };
}

function state(overrides: Partial<LessonNavigationState> = {}): LessonNavigationState {
  return {
    bookId: "book-a",
    corpusSignature: "0123456789abcdef",
    history: [historyRecord()],
    frontier: anchor(1),
    ...overrides,
  };
}

function progress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-a",
    position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
    charsCompleted: 0,
    totalChars: 1_000,
    updatedAt: 1_000,
    lifetime: { charsTyped: 0, errors: 0, timeMs: 0, sessions: 0 },
    bestWpm: 0,
    sectionOverrides: {},
    ...overrides,
  };
}

beforeEach(() => {
  mocks.stored.value = undefined;
  mocks.get.mockClear();
  mocks.put.mockClear();
  mocks.deleteRecord.mockClear();
  mocks.storeDelete.mockClear();
  mocks.objectStore.mockClear();
  mocks.transaction.mockClear();
});

describe("lesson navigation persistence", () => {
  test("rejects checkpoint book-id mismatches before opening a transaction", async () => {
    await expect(
      saveReaderCheckpoint(progress(), state({ bookId: "book-b" })),
    ).rejects.toThrow("book ids must match");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("loads a valid record as a defensive allowlisted deep clone", async () => {
    const raw = state() as LessonNavigationState & Record<string, unknown>;
    raw["bookText"] = "copyrighted source text must never be retained";
    (raw.frontier as LessonAnchor & Record<string, unknown>)["unknown"] = true;
    (raw.frontier.start as typeof raw.frontier.start & Record<string, unknown>)[
      "unknown"
    ] = true;
    (raw.history[0]!.result! as typeof raw.history[0] extends { result?: infer T }
      ? T & Record<string, unknown>
      : never)["unknown"] = true;
    mocks.stored.value = raw;

    const loaded = await getLessonNavigation("book-a");

    expect(loaded).toEqual(state());
    expect(loaded).not.toBe(raw);
    expect(loaded!.frontier).not.toBe(raw.frontier);
    expect(loaded!.frontier.start).not.toBe(raw.frontier.start);
    expect(loaded!.history[0]!.result).not.toBe(raw.history[0]!.result);
    expect(JSON.stringify(loaded)).not.toContain("copyrighted source text");
    loaded!.frontier.start.charIndex = 7;
    expect(raw.frontier.start.charIndex).toBe(0);
  });

  test("keeps only the newest 64 history records on load and save", async () => {
    const longHistory = Array.from({ length: 70 }, (_, index) => historyRecord(index));
    const longState = state({ history: longHistory, frontier: anchor(70) });
    mocks.stored.value = longState;

    const loaded = await getLessonNavigation("book-a");
    expect(loaded!.history).toHaveLength(LESSON_HISTORY_LIMIT);
    expect(loaded!.history[0]!.anchor.start.blockIndex).toBe(6);
    expect(loaded!.history.at(-1)!.anchor.start.blockIndex).toBe(69);

    await saveLessonNavigation(longState);
    const saved = mocks.put.mock.calls[0]![1] as LessonNavigationState;
    expect(saved.history).toHaveLength(LESSON_HISTORY_LIMIT);
    expect(saved.history[0]!.anchor.start.blockIndex).toBe(6);
    expect(mocks.put).toHaveBeenCalledWith("lessonNavigation", saved, "book-a");
  });

  test("save stores a defensive clone and clear deletes only that book key", async () => {
    const original = state();
    await saveLessonNavigation(original);
    const saved = mocks.put.mock.calls[0]![1] as LessonNavigationState;

    expect(saved).toEqual(original);
    expect(saved).not.toBe(original);
    expect(saved.history[0]).not.toBe(original.history[0]);
    original.frontier.end.charIndex = 99;
    expect(saved.frontier.end.charIndex).toBe(10);

    await clearLessonNavigation("book-a");
    expect(mocks.deleteRecord).toHaveBeenCalledWith("lessonNavigation", "book-a");
  });

  test("rejects malformed anchors, outcomes, stats, and top-level records", async () => {
    const { corpusSignature: _legacyMissing, ...legacyV2State } = state();
    expect(sanitizeLessonNavigationState(legacyV2State)).toBeUndefined();
    for (const corpusSignature of [
      "",
      "0123456789abcde",
      "0123456789abcdef0",
      "0123456789ABCDEf",
      "0123456789abcdeg",
    ]) {
      expect(
        sanitizeLessonNavigationState({ ...state(), corpusSignature }),
      ).toBeUndefined();
    }
    expect(
      sanitizeLessonNavigationState(
        state({ frontier: anchor(1, { targetNonSpaceChars: 137 }) }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({ frontier: anchor(1, { plannerVersion: 2 }) }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({
          frontier: anchor(1, {
            end: { sectionIndex: 0, blockIndex: 1, charIndex: 0 },
          }),
        }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({ history: [{ ...historyRecord(), outcome: "future" as never }] }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({ history: [{ ...historyRecord(), outcome: "skipped" }] }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({
          history: [
            {
              ...historyRecord(),
              result: { ...historyRecord().result!, accuracy: 101 },
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({
          history: [
            {
              ...historyRecord(),
              result: {
                ...historyRecord().result!,
                charsTyped: 2.5,
              },
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      sanitizeLessonNavigationState(
        state({
          history: [
            {
              ...historyRecord(),
              result: { ...historyRecord().result!, charsTyped: 1, errors: 2 },
            },
          ],
        }),
      ),
    ).toBeUndefined();

    mocks.stored.value = { ...state(), bookId: "" };
    await expect(getLessonNavigation("book-a")).resolves.toBeUndefined();
    mocks.stored.value = state({ bookId: "book-b" });
    await expect(getLessonNavigation("book-a")).resolves.toBeUndefined();
    await expect(
      saveLessonNavigation({ ...state(), bookId: "" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe("book deletion", () => {
  test("removes local lesson navigation in the same deletion transaction", async () => {
    await deleteBook("book-a");

    expect(mocks.transaction).toHaveBeenCalledWith(
      ["bookMeta", "books", "progress", "lessonNavigation"],
      "readwrite",
    );
    expect(mocks.objectStore).toHaveBeenCalledWith("lessonNavigation");
    expect(mocks.storeDelete).toHaveBeenCalledTimes(4);
    expect(mocks.storeDelete).toHaveBeenCalledWith("book-a");
  });
});
