/**
 * Settings persistence. Source of truth is IndexedDB; a JSON mirror in
 * localStorage lets the app apply a theme/font on first paint before the
 * IndexedDB connection opens (avoids a flash of default styling).
 */
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { getDb, SETTINGS_KEY } from "./db";

const LOCAL_STORAGE_KEY = "scriptorium:settings";
const MIGRATION_VERSION_KEY = "scriptorium:settings:migration-version";
const CURRENT_MIGRATION_VERSION = 1;
const LEGACY_DEFAULT_FONT_SIZE = 1.5;
const PERSISTED_MIGRATION_VERSION_FIELD = "__settingsMigrationVersion";

type PersistedSettings = Settings & {
  [PERSISTED_MIGRATION_VERSION_FIELD]: number;
};

const CARET_STYLES = new Set<Settings["caretStyle"]>(["line", "block", "underline", "off"]);
const STOP_ON_ERROR_VALUES = new Set<Settings["stopOnError"]>(["off", "letter", "word"]);

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Fill in any missing/invalid fields with defaults. Pure function — this is
 * what makes "settings load with defaults for missing fields" testable
 * without touching IndexedDB: a settings record persisted by an older
 * version of the app (missing newer fields) or corrupted in some way should
 * never crash the app or leave `undefined`s floating around.
 */
export function mergeSettings(partial: Partial<Settings> | null | undefined): Settings {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    return { ...DEFAULT_SETTINGS };
  }

  // Reconstruct the object field-by-field. Besides validating old/corrupt
  // persisted values, this deliberately prevents unknown sync fields from
  // being retained and later exported again.
  return {
    theme: typeof partial.theme === "string" ? partial.theme : DEFAULT_SETTINGS.theme,
    fontFamily:
      typeof partial.fontFamily === "string" ? partial.fontFamily : DEFAULT_SETTINGS.fontFamily,
    // Match the reader control's supported range so corrupt persisted values
    // cannot make the text unreadably small or large.
    fontSize: isFiniteNumberInRange(partial.fontSize, 0.8, 3)
      ? partial.fontSize
      : DEFAULT_SETTINGS.fontSize,
    caretStyle: CARET_STYLES.has(partial.caretStyle as Settings["caretStyle"])
      ? (partial.caretStyle as Settings["caretStyle"])
      : DEFAULT_SETTINGS.caretStyle,
    smoothCaret:
      typeof partial.smoothCaret === "boolean" ? partial.smoothCaret : DEFAULT_SETTINGS.smoothCaret,
    stopOnError: STOP_ON_ERROR_VALUES.has(partial.stopOnError as Settings["stopOnError"])
      ? (partial.stopOnError as Settings["stopOnError"])
      : DEFAULT_SETTINGS.stopOnError,
    foldAccents:
      typeof partial.foldAccents === "boolean" ? partial.foldAccents : DEFAULT_SETTINGS.foldAccents,
    soundOnClick:
      typeof partial.soundOnClick === "boolean"
        ? partial.soundOnClick
        : DEFAULT_SETTINGS.soundOnClick,
    showLiveWpm:
      typeof partial.showLiveWpm === "boolean"
        ? partial.showLiveWpm
        : DEFAULT_SETTINGS.showLiveWpm,
    contextLines:
      Number.isInteger(partial.contextLines) &&
      isFiniteNumberInRange(partial.contextLines, 0, 8)
        ? partial.contextLines
        : DEFAULT_SETTINGS.contextLines,
  };
}

function hasCompletedMigrations(): boolean {
  try {
    const raw = localStorage.getItem(MIGRATION_VERSION_KEY);
    if (raw === null || !/^\d+$/.test(raw)) return false;
    const version = Number(raw);
    return Number.isSafeInteger(version) && version >= CURRENT_MIGRATION_VERSION;
  } catch {
    return false;
  }
}

function hasCompletedPersistedMigrations(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as Record<string, unknown>)[PERSISTED_MIGRATION_VERSION_FIELD];
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= CURRENT_MIGRATION_VERSION
  );
}

function toPersistedSettings(settings: Settings): PersistedSettings {
  return {
    ...settings,
    [PERSISTED_MIGRATION_VERSION_FIELD]: CURRENT_MIGRATION_VERSION,
  };
}

function migrateLegacyDefaults(settings: Settings): Settings {
  if (settings.fontSize !== LEGACY_DEFAULT_FONT_SIZE) return settings;
  return { ...settings, fontSize: DEFAULT_SETTINGS.fontSize };
}

/** Synchronous best-effort read for first paint, before IndexedDB is open.
 * Never throws; falls back to defaults if localStorage is unavailable
 * (private browsing, disabled storage) or holds nothing/garbage yet. */
export function getSettingsSync(): Settings {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as unknown;
    const settings = mergeSettings(parsed as Partial<Settings>);
    if (hasCompletedPersistedMigrations(parsed) || hasCompletedMigrations()) return settings;

    // First paint must agree with the eventual IndexedDB migration, but do
    // not mark it complete yet: IndexedDB is the durable source and still
    // needs to be migrated by getSettings().
    const migrated = migrateLegacyDefaults(settings);
    mirrorToLocalStorage(migrated);
    return migrated;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function mirrorToLocalStorage(settings: Settings): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // best-effort only; IndexedDB remains the source of truth
  }
}

function mirrorAndMarkMigrationsComplete(settings: Settings): void {
  try {
    // Keep the version beside the mirrored value as well as in the small
    // standalone key. If either key is cleared independently, the remaining
    // metadata still prevents a deliberate 1.5rem choice being remigrated.
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(toPersistedSettings(settings)));
    localStorage.setItem(MIGRATION_VERSION_KEY, String(CURRENT_MIGRATION_VERSION));
  } catch {
    // best-effort only; IndexedDB remains the source of truth
  }
}

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  const stored = await db.get("settings", SETTINGS_KEY);
  let settings = mergeSettings(stored);
  if (!hasCompletedPersistedMigrations(stored)) {
    settings = migrateLegacyDefaults(settings);
    // Persist settings and their migration version in one IndexedDB value.
    // This is the durable source of truth; the private metadata field is
    // stripped by mergeSettings before settings can reach UI or sync code.
    await db.put("settings", toPersistedSettings(settings), SETTINGS_KEY);
  }
  mirrorAndMarkMigrationsComplete(settings);
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const full = mergeSettings(settings);
  const db = await getDb();
  await db.put("settings", toPersistedSettings(full), SETTINGS_KEY);
  // A save made by the current app is an explicit user/current-schema value.
  // Marking here ensures a deliberate 1.5rem choice is never mistaken for
  // the legacy auto-persisted default on a later load.
  mirrorAndMarkMigrationsComplete(full);
}
