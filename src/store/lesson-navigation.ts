/**
 * Local-only persistence for deterministic finite-lesson navigation.
 *
 * Navigation state intentionally does not participate in sync. Persisted
 * values are reconstructed field-by-field so corrupt/legacy IndexedDB data
 * cannot escape into the reader and unknown fields are never retained.
 */
import {
  MAX_LESSON_LENGTH,
  MIN_LESSON_LENGTH,
  LESSON_LENGTH_STEP,
  LESSON_PLANNER_VERSION,
  type LessonAnchor,
  type LessonHistoryOutcome,
  type LessonHistoryRecord,
  type LessonNavigationState,
  type Position,
  type SessionStats,
} from "../types";
import { getDb } from "./db";

export const LESSON_HISTORY_LIMIT = 64;

const CORPUS_SIGNATURE_PATTERN = /^[0-9a-f]{16}$/;

const HISTORY_OUTCOMES = new Set<LessonHistoryOutcome>([
  "completed",
  "skipped",
  "recovered",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clonePosition(value: unknown): Position | undefined {
  if (!isRecord(value)) return undefined;
  const { sectionIndex, blockIndex, charIndex } = value;
  if (
    !isNonnegativeInteger(sectionIndex) ||
    !isNonnegativeInteger(blockIndex) ||
    !isNonnegativeInteger(charIndex)
  ) {
    return undefined;
  }
  return { sectionIndex, blockIndex, charIndex };
}

function comparePositions(a: Position, b: Position): number {
  return (
    a.sectionIndex - b.sectionIndex ||
    a.blockIndex - b.blockIndex ||
    a.charIndex - b.charIndex
  );
}

function isSupportedTarget(value: unknown): value is number {
  return (
    isNonnegativeInteger(value) &&
    value >= MIN_LESSON_LENGTH &&
    value <= MAX_LESSON_LENGTH &&
    (value - MIN_LESSON_LENGTH) % LESSON_LENGTH_STEP === 0
  );
}

function cloneAnchor(value: unknown): LessonAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const start = clonePosition(value.start);
  const end = clonePosition(value.end);
  if (
    !start ||
    !end ||
    comparePositions(start, end) >= 0 ||
    !isSupportedTarget(value.targetNonSpaceChars) ||
    !isNonnegativeInteger(value.plannerVersion) ||
    value.plannerVersion === 0 ||
    value.plannerVersion > LESSON_PLANNER_VERSION
  ) {
    return undefined;
  }
  return {
    start,
    end,
    targetNonSpaceChars: value.targetNonSpaceChars,
    plannerVersion: value.plannerVersion,
  };
}

function cloneSessionStats(value: unknown): SessionStats | undefined {
  if (!isRecord(value)) return undefined;
  const { wpm, rawWpm, accuracy, consistency, charsTyped, errors, elapsedMs } =
    value;
  if (
    !isFiniteNonnegative(wpm) ||
    !isFiniteNonnegative(rawWpm) ||
    !isFiniteNonnegative(accuracy) ||
    accuracy > 100 ||
    !isFiniteNonnegative(consistency) ||
    consistency > 100 ||
    !isNonnegativeInteger(charsTyped) ||
    !isNonnegativeInteger(errors) ||
    errors > charsTyped ||
    !isFiniteNonnegative(elapsedMs)
  ) {
    return undefined;
  }
  return {
    wpm,
    rawWpm,
    accuracy,
    consistency,
    charsTyped,
    errors,
    elapsedMs,
  };
}

function cloneHistoryRecord(value: unknown): LessonHistoryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const anchor = cloneAnchor(value.anchor);
  const outcome = value.outcome;
  if (!anchor || !HISTORY_OUTCOMES.has(outcome as LessonHistoryOutcome)) {
    return undefined;
  }

  if (value.result === undefined) {
    return { anchor, outcome: outcome as LessonHistoryOutcome };
  }
  if (outcome !== "completed") return undefined;
  const result = cloneSessionStats(value.result);
  if (!result) return undefined;
  return { anchor, outcome: outcome as LessonHistoryOutcome, result };
}

/**
 * Validate and deeply clone persisted navigation state. Histories longer than
 * the storage budget retain their newest records.
 */
export function sanitizeLessonNavigationState(
  value: unknown,
): LessonNavigationState | undefined {
  if (!isRecord(value) || typeof value.bookId !== "string" || value.bookId.length === 0) {
    return undefined;
  }
  if (
    typeof value.corpusSignature !== "string" ||
    !CORPUS_SIGNATURE_PATTERN.test(value.corpusSignature)
  ) {
    return undefined;
  }
  if (!Array.isArray(value.history)) return undefined;

  const frontier = cloneAnchor(value.frontier);
  if (!frontier) return undefined;

  const history: LessonHistoryRecord[] = [];
  let previousEnd: Position | undefined;
  for (const item of value.history.slice(-LESSON_HISTORY_LIMIT)) {
    const record = cloneHistoryRecord(item);
    if (
      !record ||
      (previousEnd && comparePositions(previousEnd, record.anchor.start) > 0) ||
      comparePositions(record.anchor.end, frontier.start) > 0
    ) {
      return undefined;
    }
    history.push(record);
    previousEnd = record.anchor.end;
  }

  return {
    bookId: value.bookId,
    corpusSignature: value.corpusSignature,
    history,
    frontier,
  };
}

export async function getLessonNavigation(
  bookId: string,
): Promise<LessonNavigationState | undefined> {
  if (bookId.length === 0) return undefined;
  const db = await getDb();
  const state = sanitizeLessonNavigationState(
    await db.get("lessonNavigation", bookId),
  );
  return state?.bookId === bookId ? state : undefined;
}

export async function saveLessonNavigation(
  state: LessonNavigationState,
): Promise<void> {
  const sanitized = sanitizeLessonNavigationState(state);
  if (!sanitized) {
    throw new RangeError("Invalid lesson navigation state");
  }
  const db = await getDb();
  await db.put("lessonNavigation", sanitized, sanitized.bookId);
}

export async function clearLessonNavigation(bookId: string): Promise<void> {
  if (bookId.length === 0) {
    throw new RangeError("Invalid book id");
  }
  const db = await getDb();
  await db.delete("lessonNavigation", bookId);
}
