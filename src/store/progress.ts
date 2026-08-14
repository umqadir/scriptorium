/**
 * Per-book reading/typing progress. `sectionOverrides` is the user's
 * include/exclude decision from the import flow (or later, from the reader),
 * keyed by `Section.id`; it's persisted here so it survives reloads and
 * travels through sync.
 */
import type { BookProgress, LifetimeStats, Position, Section } from "../types";
import { getDb } from "./db";

/** Whether a section should be typed through, given the user's overrides.
 * An override (keyed by Section.id) always wins; otherwise fall back to the
 * parser's default classification (`section.included`). */
export function isSectionIncluded(section: Section, overrides: Record<string, boolean>): boolean {
  return overrides[section.id] ?? section.included;
}

/** Sections with `included` resolved against overrides — what actually gets
 * typed through. Used both to build a runtime book for the engine and to
 * compute `totalChars`. */
export function resolveSections(sections: Section[], overrides: Record<string, boolean>): Section[] {
  return sections.map((s) => ({ ...s, included: isSectionIncluded(s, overrides) }));
}

/** Sum of charCount over included sections only — the denominator for a
 * book's progress bar. */
export function computeTotalChars(sections: Section[], overrides: Record<string, boolean>): number {
  let total = 0;
  for (const s of sections) {
    if (isSectionIncluded(s, overrides)) total += s.charCount;
  }
  return total;
}

export function createInitialProgress(
  bookId: string,
  totalChars: number,
  sectionOverrides: Record<string, boolean> = {}
): BookProgress {
  return {
    bookId,
    position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
    charsCompleted: 0,
    totalChars,
    updatedAt: Date.now(),
    lifetime: { charsTyped: 0, errors: 0, timeMs: 0, sessions: 0 },
    bestWpm: 0,
    sectionOverrides,
  };
}

/**
 * Pure update: set (or clear, by passing `included` back to its default)
 * one section's include/exclude override on a progress record, bumping
 * `updatedAt`. Returns a new object — callers persist it via `saveProgress`.
 */
export function applySectionOverride(
  progress: BookProgress,
  sectionId: string,
  included: boolean,
  defaultIncluded?: boolean
): BookProgress {
  const sectionOverrides = { ...progress.sectionOverrides };
  if (defaultIncluded !== undefined && included === defaultIncluded) {
    delete sectionOverrides[sectionId];
  } else {
    sectionOverrides[sectionId] = included;
  }
  return {
    ...progress,
    sectionOverrides,
    updatedAt: Date.now(),
  };
}

/** Pure update: advance position/char count after typing progress, bumping
 * `updatedAt` and `bestWpm` (never regresses it). */
export function applyProgressUpdate(
  progress: BookProgress,
  update: { position: Position; charsCompleted: number; wpm?: number }
): BookProgress {
  return {
    ...progress,
    position: update.position,
    charsCompleted: update.charsCompleted,
    bestWpm:
      update.wpm !== undefined ? Math.max(progress.bestWpm, update.wpm) : progress.bestWpm,
    updatedAt: Date.now(),
  };
}

/** Pure update: fold a finished session's stats into lifetime counters. */
export function accumulateLifetime(
  progress: BookProgress,
  session: { charsTyped: number; errors: number; timeMs: number }
): BookProgress {
  const lifetime: LifetimeStats = {
    charsTyped: progress.lifetime.charsTyped + session.charsTyped,
    errors: progress.lifetime.errors + session.errors,
    timeMs: progress.lifetime.timeMs + session.timeMs,
    sessions: progress.lifetime.sessions + 1,
  };
  return { ...progress, lifetime, updatedAt: Date.now() };
}

export async function getProgress(bookId: string): Promise<BookProgress | undefined> {
  const db = await getDb();
  return db.get("progress", bookId);
}

export async function saveProgress(progress: BookProgress): Promise<void> {
  const db = await getDb();
  await db.put("progress", progress, progress.bookId);
}

export async function listProgress(): Promise<BookProgress[]> {
  const db = await getDb();
  return db.getAll("progress");
}

export async function deleteProgress(bookId: string): Promise<void> {
  const db = await getDb();
  await db.delete("progress", bookId);
}
