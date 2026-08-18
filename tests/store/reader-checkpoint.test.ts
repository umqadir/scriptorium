import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  BookProgress,
  LessonAnchor,
  LessonNavigationState,
} from "../../src/types";
import {
  _resetDbConnectionForTests,
  DB_NAME,
  getDb,
} from "../../src/store/db";
import { saveReaderCheckpoint } from "../../src/store/lesson-navigation";

function progress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-a",
    position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
    charsCompleted: 0,
    totalChars: 1_000,
    updatedAt: 1_000,
    lifetime: { charsTyped: 100, errors: 2, timeMs: 10_000, sessions: 1 },
    bestWpm: 72,
    sectionOverrides: {},
    ...overrides,
  };
}

function anchor(blockIndex = 0): LessonAnchor {
  return {
    start: { sectionIndex: 0, blockIndex, charIndex: 0 },
    end: { sectionIndex: 0, blockIndex, charIndex: 10 },
    targetNonSpaceChars: 100,
    plannerVersion: 1,
  };
}

function navigation(
  overrides: Partial<LessonNavigationState> = {},
): LessonNavigationState {
  return {
    bookId: "book-a",
    corpusSignature: "0123456789abcdef",
    history: [],
    frontier: anchor(),
    ...overrides,
  };
}

async function deleteTestDatabase(): Promise<void> {
  _resetDbConnectionForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked"));
    request.onsuccess = () => resolve();
  });
}

beforeEach(deleteTestDatabase);

afterEach(async () => {
  const db = await getDb();
  db.close();
  await deleteTestDatabase();
});

describe("atomic reader checkpoints", () => {
  test("commits progress and a sanitized defensive navigation clone together", async () => {
    const input = navigation() as LessonNavigationState & Record<string, unknown>;
    input["privateBookText"] = "must not persist";
    (input.frontier as LessonAnchor & Record<string, unknown>)["future"] = true;

    const pending = saveReaderCheckpoint(progress(), input);
    input.frontier.start.charIndex = 9;
    await pending;

    const db = await getDb();
    const [savedProgress, savedNavigation] = await Promise.all([
      db.get("progress", "book-a"),
      db.get("lessonNavigation", "book-a"),
    ]);
    expect(savedProgress).toEqual(progress());
    expect(savedNavigation).toEqual(navigation());
    expect(savedNavigation).not.toBe(input);
    expect(JSON.stringify(savedNavigation)).not.toContain("must not persist");
  });

  test("atomically replaces progress and clears navigation when omitted", async () => {
    await saveReaderCheckpoint(progress(), navigation());
    const replacement = progress({
      position: { sectionIndex: 0, blockIndex: 4, charIndex: 0 },
      charsCompleted: 400,
      updatedAt: 2_000,
    });

    await saveReaderCheckpoint(replacement);

    const db = await getDb();
    expect(await db.get("progress", "book-a")).toEqual(replacement);
    expect(await db.get("lessonNavigation", "book-a")).toBeUndefined();
  });

  test("rejects mismatched book ids before opening a transaction", async () => {
    await expect(
      saveReaderCheckpoint(progress(), navigation({ bookId: "book-b" })),
    ).rejects.toThrow("book ids must match");

    const db = await getDb();
    expect(await db.get("progress", "book-a")).toBeUndefined();
    expect(await db.get("lessonNavigation", "book-b")).toBeUndefined();
  });

  test("rolls back a queued navigation replacement when the progress write fails", async () => {
    const originalProgress = progress();
    const originalNavigation = navigation();
    await saveReaderCheckpoint(originalProgress, originalNavigation);

    const badProgress = progress({ updatedAt: 2_000 }) as BookProgress &
      Record<string, unknown>;
    badProgress["uncloneable"] = () => undefined;
    const replacementNavigation = navigation({ frontier: anchor(2) });

    await expect(
      saveReaderCheckpoint(badProgress, replacementNavigation),
    ).rejects.toBeDefined();

    const db = await getDb();
    expect(await db.get("progress", "book-a")).toEqual(originalProgress);
    expect(await db.get("lessonNavigation", "book-a")).toEqual(originalNavigation);
  });

  test("rolls back a queued navigation clear when the progress write fails", async () => {
    const originalProgress = progress();
    const originalNavigation = navigation();
    await saveReaderCheckpoint(originalProgress, originalNavigation);

    const badProgress = progress({ updatedAt: 2_000 }) as BookProgress &
      Record<string, unknown>;
    badProgress["uncloneable"] = () => undefined;

    await expect(saveReaderCheckpoint(badProgress)).rejects.toBeDefined();

    const db = await getDb();
    expect(await db.get("progress", "book-a")).toEqual(originalProgress);
    expect(await db.get("lessonNavigation", "book-a")).toEqual(originalNavigation);
  });
});
