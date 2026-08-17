/**
 * Thin IndexedDB boundary. This module is the ONLY place that talks to
 * `idb`/IndexedDB directly. Everything above it (books.ts, progress.ts,
 * settings.ts, sync.ts) works against plain data and small pure helper
 * functions that don't need a real or fake IndexedDB to test — that's the
 * "logic behind a thin boundary" the spec asks for. There is no
 * fake-indexeddb in this project, so we deliberately keep this file free of
 * unit-testable business logic; the business logic lives in the sibling
 * modules and is tested there directly.
 *
 * Schema (version 2):
 *   - bookMeta: BookMeta, keyed by `id`. Small — this is what `listBooks`
 *     reads, so rendering the library never deserializes section text.
 *   - books: { sections: Section[]; raw: Blob }, keyed by `id`. Large —
 *     only touched when opening a book to read or re-parsing.
 *   - progress: BookProgress, keyed by `bookId`.
 *   - lessonNavigation: LessonNavigationState, keyed by `bookId`. Local-only
 *     reader history; deliberately excluded from sync payloads.
 *   - settings: a single Settings record under a fixed key.
 *   - syncConfig: a single record holding the optional Gist PAT + gist id
 *     (see src/store/sync.ts). Lives in IndexedDB, not localStorage, per
 *     spec — see the comment on GistSyncConfig for why that's still not
 *     "secure storage" and what it does/doesn't protect against.
 *
 * `bookMeta` and `books` together are the storage-level realization of the
 * spec's single logical "books" store (`{ meta, sections, raw }` keyed by
 * `meta.id`); splitting them physically is what makes `listBooks` cheap.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  BookMeta,
  BookProgress,
  LessonNavigationState,
  Section,
  Settings,
} from "../types";

export const DB_NAME = "scriptorium";
export const SCHEMA_VERSION = 2;
export const SETTINGS_KEY = "singleton";
export const SYNC_CONFIG_KEY = "singleton";

/** Optional GitHub Gist remote config. See src/store/sync.ts. */
export type GistSyncConfig = {
  /** Fine-grained PAT, `gist` scope only. Stored unencrypted — see sync.ts. */
  token: string;
  /** The private gist we read/write once one has been created. */
  gistId?: string;
};

export type BookContent = {
  sections: Section[];
  raw: Blob;
};

export interface ScriptoriumSchema extends DBSchema {
  bookMeta: {
    key: string;
    value: BookMeta;
  };
  books: {
    key: string;
    value: BookContent;
  };
  progress: {
    key: string;
    value: BookProgress;
  };
  lessonNavigation: {
    key: string;
    value: LessonNavigationState;
  };
  settings: {
    key: string;
    value: Settings;
  };
  syncConfig: {
    key: string;
    value: GistSyncConfig;
  };
}

export type ScriptoriumDB = IDBPDatabase<ScriptoriumSchema>;

let dbPromise: Promise<ScriptoriumDB> | null = null;

export function getDb(): Promise<ScriptoriumDB> {
  if (!dbPromise) {
    dbPromise = openDB<ScriptoriumSchema>(DB_NAME, SCHEMA_VERSION, {
      upgrade(db, oldVersion) {
        // Migrations are additive: each block only runs for DBs coming from
        // an older version, so a fresh DB (oldVersion === 0) runs all of them.
        if (oldVersion < 1) {
          db.createObjectStore("bookMeta");
          db.createObjectStore("books");
          db.createObjectStore("progress");
          db.createObjectStore("settings");
          db.createObjectStore("syncConfig");
        }
        if (oldVersion < 2) {
          db.createObjectStore("lessonNavigation");
        }
      },
    });
  }
  return dbPromise;
}

/** Test/dev-only escape hatch: drop the cached connection so a fresh
 * `getDb()` call reopens (used after `deleteDatabase` in manual testing). */
export function _resetDbConnectionForTests(): void {
  dbPromise = null;
}
