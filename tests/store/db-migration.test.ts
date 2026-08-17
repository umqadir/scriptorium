import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDB: vi.fn(
    async (_name: string, _version: number, _options: unknown) => ({}),
  ),
}));

vi.mock("idb", () => ({ openDB: mocks.openDB }));

import { DB_NAME, getDb, SCHEMA_VERSION } from "../../src/store/db";

describe("IndexedDB schema migration", () => {
  test("version 2 additively creates only local lesson navigation for a v1 database", async () => {
    await getDb();
    expect(mocks.openDB).toHaveBeenCalledWith(
      DB_NAME,
      2,
      expect.objectContaining({ upgrade: expect.any(Function) }),
    );
    expect(SCHEMA_VERSION).toBe(2);

    const options = mocks.openDB.mock.calls[0]![2] as {
      upgrade: (db: { createObjectStore: (name: string) => void }, oldVersion: number) => void;
    };
    const createObjectStore = vi.fn();
    options.upgrade({ createObjectStore }, 1);

    expect(createObjectStore).toHaveBeenCalledOnce();
    expect(createObjectStore).toHaveBeenCalledWith("lessonNavigation");
  });

  test("a fresh database receives every store, including lesson navigation", async () => {
    await getDb();
    const options = mocks.openDB.mock.calls[0]![2] as {
      upgrade: (db: { createObjectStore: (name: string) => void }, oldVersion: number) => void;
    };
    const createObjectStore = vi.fn();
    options.upgrade({ createObjectStore }, 0);

    expect(createObjectStore.mock.calls.map(([name]) => name)).toEqual([
      "bookMeta",
      "books",
      "progress",
      "settings",
      "syncConfig",
      "lessonNavigation",
    ]);
  });
});
