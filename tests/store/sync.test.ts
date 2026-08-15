import { describe, expect, test, vi } from "vitest";
import {
  buildSyncPayload,
  isBookProgress,
  isSyncPayload,
  mergeProgressRecord,
  mergeSyncPayload,
  sanitizeSyncPayload,
  serializeSyncPayload,
} from "../../src/store/sync";
import {
  DEFAULT_SETTINGS,
  type BookProgress,
  type Settings,
  type SyncPayload,
} from "../../src/types";

function progress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-a",
    position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 },
    charsCompleted: 100,
    totalChars: 1000,
    updatedAt: 1000,
    lifetime: { charsTyped: 100, errors: 5, timeMs: 60_000, sessions: 1 },
    bestWpm: 40,
    sectionOverrides: {},
    ...overrides,
  };
}

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    version: 1,
    updatedAt: 1000,
    progress: {},
    knownBooks: {},
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe("mergeProgressRecord", () => {
  test("newest updatedAt wins for the record as a whole", () => {
    const older = progress({ updatedAt: 1000, position: { sectionIndex: 0, blockIndex: 0, charIndex: 0 } });
    const newer = progress({ updatedAt: 2000, position: { sectionIndex: 3, blockIndex: 1, charIndex: 5 } });
    const merged = mergeProgressRecord(older, newer);
    expect(merged.position).toEqual({ sectionIndex: 3, blockIndex: 1, charIndex: 5 });
    expect(merged.updatedAt).toBe(2000);
  });

  test("order of arguments doesn't matter", () => {
    const older = progress({ updatedAt: 1000, charsCompleted: 10 });
    const newer = progress({ updatedAt: 2000, charsCompleted: 999 });
    expect(mergeProgressRecord(older, newer).charsCompleted).toBe(999);
    expect(mergeProgressRecord(newer, older).charsCompleted).toBe(999);
  });

  test("lifetime counters take the field-wise max, regardless of which side is newer", () => {
    // The OLDER record has typed more chars overall (e.g. a long session that
    // hasn't synced in a while) — naive "newest wins" would erase that.
    const older = progress({
      updatedAt: 1000,
      lifetime: { charsTyped: 50_000, errors: 200, timeMs: 500_000, sessions: 40 },
    });
    const newer = progress({
      updatedAt: 2000,
      lifetime: { charsTyped: 100, errors: 900, timeMs: 10, sessions: 1 },
    });
    const merged = mergeProgressRecord(older, newer);
    expect(merged.lifetime).toEqual({
      charsTyped: 50_000, // max
      errors: 900, // max
      timeMs: 500_000, // max
      sessions: 40, // max
    });
  });

  test("bestWpm never regresses even if the newer record has a lower best", () => {
    const older = progress({ updatedAt: 1000, bestWpm: 120 });
    const newer = progress({ updatedAt: 2000, bestWpm: 80 });
    expect(mergeProgressRecord(older, newer).bestWpm).toBe(120);
  });

  test("sectionOverrides union: newer wins per-key conflicts, older keys not present in newer survive", () => {
    const older = progress({
      updatedAt: 1000,
      sectionOverrides: { "sec-1": true, "sec-2": false },
    });
    const newer = progress({
      updatedAt: 2000,
      sectionOverrides: { "sec-2": true, "sec-3": true },
    });
    const merged = mergeProgressRecord(older, newer);
    expect(merged.sectionOverrides).toEqual({
      "sec-1": true, // only on older, survives
      "sec-2": true, // conflict, newer wins
      "sec-3": true, // only on newer
    });
  });

  test("tie on updatedAt is deterministic and still applies max/union rules", () => {
    const a = progress({ updatedAt: 1500, bestWpm: 50, lifetime: { charsTyped: 10, errors: 0, timeMs: 0, sessions: 1 } });
    const b = progress({ updatedAt: 1500, bestWpm: 90, lifetime: { charsTyped: 20, errors: 0, timeMs: 0, sessions: 1 } });
    const merged = mergeProgressRecord(a, b);
    expect(merged.bestWpm).toBe(90);
    expect(merged.lifetime.charsTyped).toBe(20);
  });
});

describe("mergeSyncPayload", () => {
  test("book present on only local side is kept as-is", () => {
    const local = payload({ progress: { "book-a": progress({ bookId: "book-a" }) } });
    const remote = payload({ progress: {} });
    const merged = mergeSyncPayload(local, remote);
    expect(merged.progress["book-a"]).toEqual(local.progress["book-a"]);
  });

  test("book present on only remote side is kept as-is (re-links later on local re-import)", () => {
    const local = payload({ progress: {} });
    const remote = payload({
      progress: { "book-b": progress({ bookId: "book-b", updatedAt: 5000, bestWpm: 77 }) },
    });
    const merged = mergeSyncPayload(local, remote);
    expect(merged.progress["book-b"]).toEqual(remote.progress["book-b"]);
  });

  test("book present on both sides is merged per mergeProgressRecord rules", () => {
    const local = payload({
      progress: { "book-a": progress({ bookId: "book-a", updatedAt: 1000, bestWpm: 30 }) },
    });
    const remote = payload({
      progress: { "book-a": progress({ bookId: "book-a", updatedAt: 2000, bestWpm: 10 }) },
    });
    const merged = mergeSyncPayload(local, remote);
    // newest (remote) wins the record shape, but bestWpm still takes the max
    expect(merged.progress["book-a"]?.updatedAt).toBe(2000);
    expect(merged.progress["book-a"]?.bestWpm).toBe(30);
  });

  test("knownBooks is a union across both sides", () => {
    const local = payload({ knownBooks: { "book-a": { title: "The Iliad", author: "Homer" } } });
    const remote = payload({ knownBooks: { "book-b": { title: "The Odyssey", author: "Homer" } } });
    const merged = mergeSyncPayload(local, remote);
    expect(merged.knownBooks).toEqual({
      "book-a": { title: "The Iliad", author: "Homer" },
      "book-b": { title: "The Odyssey", author: "Homer" },
    });
  });

  test("settings come from whichever payload is newer at the top level", () => {
    const local = payload({ updatedAt: 1000, settings: { ...DEFAULT_SETTINGS, theme: "8008" } });
    const remote = payload({ updatedAt: 5000, settings: { ...DEFAULT_SETTINGS, theme: "wavez" } });
    expect(mergeSyncPayload(local, remote).settings.theme).toBe("wavez");
    expect(mergeSyncPayload(remote, local).settings.theme).toBe("wavez");
  });

  test("merged updatedAt is the max of both", () => {
    const local = payload({ updatedAt: 1000 });
    const remote = payload({ updatedAt: 9000 });
    expect(mergeSyncPayload(local, remote).updatedAt).toBe(9000);
  });

  test("merging is symmetric with respect to the final progress set for a many-book scenario", () => {
    const local = payload({
      progress: {
        "book-a": progress({ bookId: "book-a", updatedAt: 3000, bestWpm: 60 }),
        "book-only-local": progress({ bookId: "book-only-local" }),
      },
    });
    const remote = payload({
      progress: {
        "book-a": progress({ bookId: "book-a", updatedAt: 1000, bestWpm: 100 }),
        "book-only-remote": progress({ bookId: "book-only-remote" }),
      },
    });
    const merged = mergeSyncPayload(local, remote);
    expect(Object.keys(merged.progress).sort()).toEqual([
      "book-a",
      "book-only-local",
      "book-only-remote",
    ]);
    expect(merged.progress["book-a"]?.bestWpm).toBe(100); // max survives despite local being newer
  });
});

describe("isBookProgress / sanitizeSyncPayload", () => {
  test("accepts a well-formed record", () => {
    expect(isBookProgress(progress())).toBe(true);
  });

  test("rejects missing lifetime fields", () => {
    const bad = { ...progress(), lifetime: { charsTyped: 1, errors: 2, timeMs: 3 } }; // missing sessions
    expect(isBookProgress(bad)).toBe(false);
  });

  test("rejects non-numeric position fields", () => {
    const bad = { ...progress(), position: { sectionIndex: "0", blockIndex: 0, charIndex: 0 } };
    expect(isBookProgress(bad)).toBe(false);
  });

  test("rejects non-boolean sectionOverrides values", () => {
    const bad = { ...progress(), sectionOverrides: { "sec-1": "yes" } };
    expect(isBookProgress(bad)).toBe(false);
  });

  test.each([
    ["negative position", { position: { sectionIndex: -1, blockIndex: 0, charIndex: 0 } }],
    ["fractional position", { position: { sectionIndex: 0, blockIndex: 0.5, charIndex: 0 } }],
    ["negative counter", { charsCompleted: -1 }],
    ["fractional counter", { totalChars: 1000.5 }],
    ["completed count above total", { charsCompleted: 1001 }],
    ["negative timestamp", { updatedAt: -1 }],
    ["fractional timestamp", { updatedAt: 1.5 }],
    ["negative lifetime value", { lifetime: { charsTyped: 1, errors: -1, timeMs: 1, sessions: 1 } }],
    ["fractional session count", { lifetime: { charsTyped: 1, errors: 1, timeMs: 1, sessions: 1.5 } }],
    ["negative best WPM", { bestWpm: -0.1 }],
    ["non-finite best WPM", { bestWpm: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, overrides) => {
    expect(isBookProgress(progress(overrides as Partial<BookProgress>))).toBe(false);
  });

  test("accepts a nonnegative fractional best WPM", () => {
    expect(isBookProgress(progress({ bestWpm: 72.5 }))).toBe(true);
  });

  test("rejects arrays where plain record maps are required", () => {
    expect(isBookProgress(progress({ sectionOverrides: [] as never }))).toBe(false);
    expect(isSyncPayload({ ...payload(), progress: [] })).toBe(false);
    expect(isSyncPayload({ ...payload(), knownBooks: [] })).toBe(false);
    expect(isSyncPayload({ ...payload(), settings: [] })).toBe(false);
  });

  test("sanitizeSyncPayload drops a malformed progress entry and keeps the rest, warning once per drop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = payload({
      progress: {
        good: progress({ bookId: "good" }),
        // @ts-expect-error deliberately malformed for the test
        bad: { bookId: "bad", position: null },
      },
    });
    const cleaned = sanitizeSyncPayload(raw);
    expect(Object.keys(cleaned.progress)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("sanitizeSyncPayload throws on garbage that isn't a sync payload at all", () => {
    expect(() => sanitizeSyncPayload({ hello: "world" })).toThrow();
    expect(() => sanitizeSyncPayload(null)).toThrow();
    expect(() => sanitizeSyncPayload("not even an object")).toThrow();
  });

  test("sanitizeSyncPayload drops malformed knownBooks entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = payload({
      knownBooks: {
        good: { title: "Good Book", author: "Someone" },
        // @ts-expect-error deliberately malformed for the test
        bad: { title: 123 },
      },
    });
    const cleaned = sanitizeSyncPayload(raw);
    expect(Object.keys(cleaned.knownBooks)).toEqual(["good"]);
    warn.mockRestore();
  });

  test("drops a progress record whose map key does not match its bookId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleaned = sanitizeSyncPayload(payload({
      progress: { "book-a": progress({ bookId: "book-b" }) },
    }));
    expect(cleaned.progress).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  test("rejects invalid top-level timestamps", () => {
    expect(() => sanitizeSyncPayload({ ...payload(), updatedAt: -1 })).toThrow();
    expect(() => sanitizeSyncPayload({ ...payload(), updatedAt: 1.5 })).toThrow();
    expect(() => sanitizeSyncPayload({ ...payload(), updatedAt: Number.NaN })).toThrow();
  });
});

describe("sync privacy allowlist", () => {
  test("sanitizes missing or invalid lesson targets through the settings allowlist", () => {
    const { lessonLength: _omitted, ...legacySettings } = DEFAULT_SETTINGS;
    const legacy = sanitizeSyncPayload({
      ...payload(),
      settings: legacySettings,
    });
    const invalid = sanitizeSyncPayload({
      ...payload(),
      settings: { ...DEFAULT_SETTINGS, lessonLength: 137 },
    });

    expect(legacy.settings.lessonLength).toBe(100);
    expect(invalid.settings.lessonLength).toBe(100);
  });

  test("sanitize and serialize strip unknown fields at every level", () => {
    const sentinel = "PRIVATE_BOOK_TEXT_SENTINEL_41f725ca";
    const raw = {
      ...payload(),
      bookText: sentinel,
      progress: {
        "book-a": {
          ...progress(),
          extractedText: sentinel,
          position: { ...progress().position, nearbyText: sentinel },
          lifetime: { ...progress().lifetime, lastTypedText: sentinel },
        },
      },
      knownBooks: {
        "book-a": { title: "Safe title", author: "Safe author", fullText: sentinel },
      },
      settings: { ...DEFAULT_SETTINGS, importedBookText: sentinel },
    } as unknown as SyncPayload;

    const cleaned = sanitizeSyncPayload(raw);
    const serialized = serializeSyncPayload(raw);
    expect(serialized).not.toContain(sentinel);
    expect(Object.keys(cleaned).sort()).toEqual(
      ["version", "updatedAt", "progress", "knownBooks", "settings"].sort()
    );
    expect(Object.keys(cleaned.progress["book-a"]!).sort()).toEqual([
      "bookId",
      "position",
      "charsCompleted",
      "totalChars",
      "updatedAt",
      "lifetime",
      "bestWpm",
      "sectionOverrides",
    ].sort());
    expect(Object.keys(cleaned.progress["book-a"]!.position).sort()).toEqual(
      ["sectionIndex", "blockIndex", "charIndex"].sort()
    );
    expect(Object.keys(cleaned.progress["book-a"]!.lifetime).sort()).toEqual(
      ["charsTyped", "errors", "timeMs", "sessions"].sort()
    );
    expect(Object.keys(cleaned.knownBooks["book-a"]!).sort()).toEqual(["title", "author"].sort());
    expect(Object.keys(cleaned.settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  test("buildSyncPayload reconstructs safe output rather than retaining input references", () => {
    const sentinel = "PRIVATE_BUILD_SENTINEL_41f725ca";
    const built = buildSyncPayload({
      progress: {
        "book-a": { ...progress(), hiddenText: sentinel } as BookProgress,
      },
      knownBooks: {
        "book-a": { title: "Title", author: "Author", hiddenText: sentinel },
      } as never,
      settings: { ...DEFAULT_SETTINGS, hiddenText: sentinel } as Settings,
    });

    expect(JSON.stringify(built)).not.toContain(sentinel);
    expect(built.progress["book-a"]).not.toBeUndefined();
  });
});
