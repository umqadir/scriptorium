/**
 * Cross-device sync. HARD REQUIREMENT (see SPEC.md and the comment on
 * `SyncPayload` in src/types.ts): book text never leaves the device. Only
 * progress + settings + book titles travel, in a `SyncPayload`.
 *
 * Two transports, both optional and user-initiated:
 *   1. File export/import — always works, no account needed. This is the
 *      primary path.
 *   2. GitHub Gist — opt-in. The user supplies their own fine-grained PAT
 *      (scope: `gist` only) and the payload round-trips through a private
 *      gist *they* own. We never see or forward the token anywhere but
 *      api.github.com.
 *
 * Merge rule (per SPEC.md): per book, newest `updatedAt` wins for the
 * record as a whole (position, charsCompleted, sectionOverrides, ...);
 * `lifetime` counters and `bestWpm` are exempted from that and always take
 * the field-wise max, because they're cumulative/monotonic — letting a
 * "newest wins" rule apply to them would silently erase typing history or
 * a personal best recorded on the device that loses the updatedAt race.
 * A book present on only one side is kept as-is (it re-links automatically
 * on the other device once the same source file is imported there, because the
 * key is the book's content hash).
 */
import type { BookProgress, LifetimeStats, Position, Settings, SyncPayload } from "../types";
import { getDb, SYNC_CONFIG_KEY, type GistSyncConfig } from "./db";
import { mergeSettings } from "./settings";

const SYNC_PAYLOAD_VERSION = 1 as const;

// ─────────────────────────────── Building ────────────────────────────────

export function buildSyncPayload(input: {
  progress: Record<string, BookProgress>;
  knownBooks: Record<string, { title: string; author: string }>;
  settings: Settings;
}): SyncPayload {
  return sanitizeSyncPayload({
    version: SYNC_PAYLOAD_VERSION,
    updatedAt: Date.now(),
    progress: input.progress,
    knownBooks: input.knownBooks,
    settings: input.settings,
  });
}

// ───────────────────────────────── Merge ──────────────────────────────────

function maxLifetime(a: LifetimeStats, b: LifetimeStats): LifetimeStats {
  return {
    charsTyped: Math.max(a.charsTyped, b.charsTyped),
    errors: Math.max(a.errors, b.errors),
    timeMs: Math.max(a.timeMs, b.timeMs),
    sessions: Math.max(a.sessions, b.sessions),
  };
}

/** Merge two progress records for the *same* book. Exported for direct testing. */
export function mergeProgressRecord(a: BookProgress, b: BookProgress): BookProgress {
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const older = newer === a ? b : a;
  return {
    bookId: newer.bookId,
    position: copyPosition(newer.position),
    charsCompleted: newer.charsCompleted,
    totalChars: newer.totalChars,
    updatedAt: newer.updatedAt,
    lifetime: maxLifetime(a.lifetime, b.lifetime),
    bestWpm: Math.max(a.bestWpm, b.bestWpm),
    // Section include/exclude choices made on either device should both
    // stick; last-write-per-key via the newer record, filled in with any
    // key only the older record set.
    sectionOverrides: copyBooleanMap({ ...older.sectionOverrides, ...newer.sectionOverrides }),
  };
}

/**
 * Merge two sync payloads (e.g. local state vs. an imported/pulled file).
 * Pure and deterministic — safe to unit test exhaustively, which is where
 * silent data loss in a sync feature would otherwise hide.
 */
export function mergeSyncPayload(local: SyncPayload, remote: SyncPayload): SyncPayload {
  const bookIds = new Set([...Object.keys(local.progress), ...Object.keys(remote.progress)]);
  const progress: Record<string, BookProgress> = {};
  for (const id of bookIds) {
    const l = local.progress[id];
    const r = remote.progress[id];
    if (l && r) {
      progress[id] = mergeProgressRecord(l, r);
    } else {
      // Present on only one side: keep it. It re-links automatically once
      // the matching source file (same content hash) is imported on the other
      // device — dropping it here would silently lose real typing history.
      progress[id] = (l ?? r)!;
    }
  }

  const knownBooks = { ...local.knownBooks, ...remote.knownBooks };

  // Settings aren't per-book/mergeable field-by-field; take the whole
  // settings object from whichever payload is newer overall.
  const settings = remote.updatedAt > local.updatedAt ? remote.settings : local.settings;

  return sanitizeSyncPayload({
    version: SYNC_PAYLOAD_VERSION,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    progress,
    knownBooks,
    settings,
  });
}

// ───────────────────────── Validation (defensive) ─────────────────────────
//
// Sync data can arrive from a hand-edited file, a stale export from an older
// schema, or a gist someone poked at directly — none of it is trusted.
// `isSyncPayload` is a cheap top-level shape check; `sanitizeSyncPayload`
// does the real work of validating every `BookProgress` entry deeply enough
// that a malformed record gets dropped (with a console warning) at the
// import boundary instead of reaching the UI and crashing something that
// assumes e.g. `lifetime.charsTyped` is a number.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonnegativeInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPosition(v: unknown): v is Position {
  if (!isPlainRecord(v)) return false;
  return (
    isNonnegativeInteger(v["sectionIndex"]) &&
    isNonnegativeInteger(v["blockIndex"]) &&
    isNonnegativeInteger(v["charIndex"])
  );
}

function isLifetimeStats(v: unknown): v is LifetimeStats {
  if (!isPlainRecord(v)) return false;
  return (
    isNonnegativeInteger(v["charsTyped"]) &&
    isNonnegativeInteger(v["errors"]) &&
    isNonnegativeInteger(v["timeMs"]) &&
    isNonnegativeInteger(v["sessions"])
  );
}

function isSectionOverrides(v: unknown): v is Record<string, boolean> {
  return isPlainRecord(v) && Object.values(v).every((x) => typeof x === "boolean");
}

/** Deep-validates a single progress record — every field the merge logic
 * and the UI actually reads, not just "is this an object". */
export function isBookProgress(value: unknown): value is BookProgress {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value["bookId"] === "string" &&
    isPosition(value["position"]) &&
    isNonnegativeInteger(value["charsCompleted"]) &&
    isNonnegativeInteger(value["totalChars"]) &&
    value["charsCompleted"] <= value["totalChars"] &&
    isNonnegativeInteger(value["updatedAt"]) &&
    isLifetimeStats(value["lifetime"]) &&
    isFiniteNumber(value["bestWpm"]) &&
    value["bestWpm"] >= 0 &&
    isSectionOverrides(value["sectionOverrides"])
  );
}

function isKnownBookEntry(value: unknown): value is { title: string; author: string } {
  return isPlainRecord(value) && typeof value["title"] === "string" && typeof value["author"] === "string";
}

/** Cheap top-level shape check only — does not guarantee the entries inside
 * `progress`/`knownBooks` are individually well-formed. Use
 * `sanitizeSyncPayload` at trust boundaries (file import, gist pull). */
export function isSyncPayload(value: unknown): value is SyncPayload {
  if (!isPlainRecord(value)) return false;
  return (
    value["version"] === 1 &&
    isNonnegativeInteger(value["updatedAt"]) &&
    isPlainRecord(value["progress"]) &&
    isPlainRecord(value["knownBooks"]) &&
    isPlainRecord(value["settings"])
  );
}

function copyPosition(position: Position): Position {
  return {
    sectionIndex: position.sectionIndex,
    blockIndex: position.blockIndex,
    charIndex: position.charIndex,
  };
}

function copyLifetime(lifetime: LifetimeStats): LifetimeStats {
  return {
    charsTyped: lifetime.charsTyped,
    errors: lifetime.errors,
    timeMs: lifetime.timeMs,
    sessions: lifetime.sessions,
  };
}

function copyBooleanMap(map: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value]));
}

function copyBookProgress(progress: BookProgress): BookProgress {
  return {
    bookId: progress.bookId,
    position: copyPosition(progress.position),
    charsCompleted: progress.charsCompleted,
    totalChars: progress.totalChars,
    updatedAt: progress.updatedAt,
    lifetime: copyLifetime(progress.lifetime),
    bestWpm: progress.bestWpm,
    sectionOverrides: copyBooleanMap(progress.sectionOverrides),
  };
}

/**
 * Validate a payload from an untrusted source (imported file, pulled gist)
 * and strip out any progress/knownBooks entries that don't hold up, logging
 * a warning for each. Throws only when the top-level shape itself is wrong
 * (i.e. this clearly isn't a Scriptorium sync payload at all).
 */
export function sanitizeSyncPayload(value: unknown): SyncPayload {
  if (!isSyncPayload(value)) {
    throw new Error("That file doesn't look like a Scriptorium sync export.");
  }

  const progressEntries: Array<[string, BookProgress]> = [];
  for (const [bookId, record] of Object.entries(value.progress)) {
    if (isBookProgress(record) && record.bookId === bookId) {
      progressEntries.push([bookId, copyBookProgress(record)]);
    } else {
      console.warn(`Scriptorium sync: dropping malformed progress record for "${bookId}".`);
    }
  }

  const knownBookEntries: Array<[string, { title: string; author: string }]> = [];
  for (const [bookId, entry] of Object.entries(value.knownBooks)) {
    if (isKnownBookEntry(entry)) {
      knownBookEntries.push([bookId, { title: entry.title, author: entry.author }]);
    } else {
      console.warn(`Scriptorium sync: dropping malformed knownBooks entry for "${bookId}".`);
    }
  }

  return {
    version: SYNC_PAYLOAD_VERSION,
    updatedAt: value.updatedAt,
    progress: Object.fromEntries(progressEntries),
    knownBooks: Object.fromEntries(knownBookEntries),
    settings: mergeSettings(value.settings as Partial<Settings>),
  };
}

// ────────────────────────── File export / import ──────────────────────────

export function serializeSyncPayload(payload: SyncPayload): string {
  return JSON.stringify(sanitizeSyncPayload(payload), null, 2);
}

/** Trigger a browser download of the payload as a JSON file. DOM-only side
 * effect, always user-initiated (a click on an explicit "Export" button).
 *
 * The anchor must be attached to the document for the programmatic click to
 * work in Firefox, and the object URL must outlive the click — revoking it
 * synchronously races the download start in Firefox/Safari and can cancel
 * it. So: append, click, remove, then revoke on a later macrotask. */
export function downloadSyncPayload(
  payload: SyncPayload,
  filename = `scriptorium-sync-${new Date().toISOString().slice(0, 10)}.json`
): void {
  const blob = new Blob([serializeSyncPayload(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function parseSyncPayloadFile(file: Blob): Promise<SyncPayload> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return sanitizeSyncPayload(data);
}

// ───────────────────────────── GitHub Gist remote ─────────────────────────
//
// SECURITY NOTE: the PAT is stored **unencrypted** in this browser's
// IndexedDB (see src/store/db.ts, `syncConfig` store). That's the same
// trust boundary as every other local-first app: anyone with access to this
// browser profile/device can read it. It is NOT sent anywhere but
// api.github.com, and it should be a *fine-grained* PAT scoped to the
// `gist` permission only, so a leak can't reach the user's repos, account,
// or anything else. The Settings screen surfaces a "disconnect and forget
// token" control that deletes it outright.

const GIST_API = "https://api.github.com/gists";
const GIST_FILENAME = "scriptorium-sync.json";

export async function getGistConfig(): Promise<GistSyncConfig | undefined> {
  const db = await getDb();
  return db.get("syncConfig", SYNC_CONFIG_KEY);
}

export async function saveGistConfig(config: GistSyncConfig): Promise<void> {
  const db = await getDb();
  await db.put("syncConfig", config, SYNC_CONFIG_KEY);
}

/** "Disconnect and forget token" — deletes the PAT and remembered gist id. */
export async function clearGistConfig(): Promise<void> {
  const db = await getDb();
  await db.delete("syncConfig", SYNC_CONFIG_KEY);
}

function gistHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Push the payload to the user's private gist, creating it on first use and
 * remembering its id for subsequent pushes. Returns the gist id.
 */
export async function pushSyncPayloadToGist(payload: SyncPayload): Promise<string> {
  const config = await getGistConfig();
  if (!config?.token) {
    throw new Error("No GitHub token configured. Connect a Gist remote in Settings first.");
  }
  const body = JSON.stringify({
    description: "Scriptorium sync data (progress + settings only, no book text)",
    public: false,
    files: { [GIST_FILENAME]: { content: serializeSyncPayload(payload) } },
  });

  const url = config.gistId ? `${GIST_API}/${config.gistId}` : GIST_API;
  const method = config.gistId ? "PATCH" : "POST";
  const res = await fetch(url, { method, headers: gistHeaders(config.token), body });
  if (!res.ok) {
    throw new Error(`GitHub Gist sync failed (${res.status}): ${await safeErrorText(res)}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  if (!isPlainRecord(json) || typeof json["id"] !== "string") {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  if (json.id !== config.gistId) {
    await saveGistConfig({ ...config, gistId: json.id });
  }
  return json.id;
}

export async function pullSyncPayloadFromGist(): Promise<SyncPayload | undefined> {
  const config = await getGistConfig();
  if (!config?.token) {
    throw new Error("No GitHub token configured. Connect a Gist remote in Settings first.");
  }
  if (!config.gistId) {
    // Nothing pushed from this device yet; not an error, just nothing to pull.
    return undefined;
  }
  const res = await fetch(`${GIST_API}/${config.gistId}`, {
    method: "GET",
    headers: gistHeaders(config.token),
  });
  if (!res.ok) {
    throw new Error(`GitHub Gist fetch failed (${res.status}): ${await safeErrorText(res)}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  if (!isPlainRecord(json) || !isPlainRecord(json["files"])) {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  const file = json["files"][GIST_FILENAME];
  if (file === undefined || file === null) return undefined;
  if (!isPlainRecord(file)) {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  const content = file["content"];
  if (content === undefined || content === "") return undefined;
  if (typeof content !== "string") {
    throw new Error("GitHub Gist returned an invalid response.");
  }
  let data: unknown;
  try {
    data = JSON.parse(content) as unknown;
  } catch {
    throw new Error("The GitHub Gist contains invalid sync JSON.");
  }
  return sanitizeSyncPayload(data);
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}
