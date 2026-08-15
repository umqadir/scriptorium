import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Settings } from "../../src/types";

const mocks = vi.hoisted(() => ({
  stored: undefined as unknown,
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("../../src/store/db", () => ({
  getDb: async () => ({ get: mocks.get, put: mocks.put }),
  SETTINGS_KEY: "singleton",
}));

import { getSettings, getSettingsSync, saveSettings } from "../../src/store/settings";
import { DEFAULT_SETTINGS } from "../../src/types";

const LOCAL_STORAGE_KEY = "scriptorium:settings";
const MIGRATION_VERSION_KEY = "scriptorium:settings:migration-version";

beforeEach(() => {
  localStorage.clear();
  mocks.stored = undefined;
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.get.mockImplementation(async () => mocks.stored);
  mocks.put.mockImplementation(async (_store: string, value: unknown) => {
    mocks.stored = value;
  });
});

describe("legacy default font-size migration", () => {
  test("uses the Monkeytype-parity 2rem default for new settings", () => {
    expect(DEFAULT_SETTINGS.fontSize).toBe(2);
    expect(getSettingsSync().fontSize).toBe(2);
  });

  test("migrates the localStorage mirror for first paint without prematurely marking completion", () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, fontSize: 1.5 })
    );

    expect(getSettingsSync().fontSize).toBe(2);
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!).fontSize).toBe(2);
    expect(localStorage.getItem(MIGRATION_VERSION_KEY)).toBeNull();
  });

  test("migrates and persists the IndexedDB source, then marks the migration complete", async () => {
    mocks.stored = { ...DEFAULT_SETTINGS, fontSize: 1.5 };

    await expect(getSettings()).resolves.toMatchObject({ fontSize: 2 });
    expect(mocks.put).toHaveBeenCalledWith(
      "settings",
      expect.objectContaining({ fontSize: 2, __settingsMigrationVersion: 1 }),
      "singleton"
    );
    expect((mocks.stored as Settings).fontSize).toBe(2);
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!).fontSize).toBe(2);
    expect(localStorage.getItem(MIGRATION_VERSION_KEY)).toBe("1");
  });

  test("preserves a deliberate 1.5rem choice after the one-time migration", async () => {
    mocks.stored = {
      ...DEFAULT_SETTINGS,
      fontSize: 1.5,
      __settingsMigrationVersion: 1,
    };
    localStorage.setItem(MIGRATION_VERSION_KEY, "1");

    await expect(getSettings()).resolves.toMatchObject({ fontSize: 1.5 });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(getSettingsSync().fontSize).toBe(1.5);
  });

  test("saving 1.5rem marks it as a current explicit value", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, fontSize: 1.5 });

    expect(localStorage.getItem(MIGRATION_VERSION_KEY)).toBe("1");
    await expect(getSettings()).resolves.toMatchObject({ fontSize: 1.5 });
  });

  test("preserves a later 1.5rem choice when localStorage is cleared", async () => {
    await getSettings();
    await saveSettings({ ...DEFAULT_SETTINGS, fontSize: 1.5 });
    localStorage.clear();

    // First paint has no mirror and therefore uses the new default. Async
    // hydration must restore — and must not overwrite — the explicit value.
    expect(getSettingsSync().fontSize).toBe(2);
    await expect(getSettings()).resolves.toMatchObject({ fontSize: 1.5 });
    expect((mocks.stored as Settings).fontSize).toBe(1.5);
  });

  test("keeps first paint aligned if only the localStorage version key is cleared", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, fontSize: 1.5 });
    localStorage.removeItem(MIGRATION_VERSION_KEY);

    expect(getSettingsSync().fontSize).toBe(1.5);
    await expect(getSettings()).resolves.toMatchObject({ fontSize: 1.5 });
  });

  test("preserves a later 1.5rem choice when localStorage writes are unavailable", async () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    await saveSettings({ ...DEFAULT_SETTINGS, fontSize: 1.5 });
    await expect(getSettings()).resolves.toMatchObject({ fontSize: 1.5 });
    expect((mocks.stored as Settings).fontSize).toBe(1.5);
    setItem.mockRestore();
  });

  test("does not record migration completion when the IndexedDB write fails", async () => {
    mocks.stored = { ...DEFAULT_SETTINGS, fontSize: 1.5 };
    mocks.put.mockRejectedValueOnce(new Error("IndexedDB unavailable"));

    await expect(getSettings()).rejects.toThrow("IndexedDB unavailable");
    expect(localStorage.getItem(MIGRATION_VERSION_KEY)).toBeNull();
    expect((mocks.stored as Settings).fontSize).toBe(1.5);
  });

  test("does not trust a malformed or local-only migration marker over IndexedDB", async () => {
    mocks.stored = { ...DEFAULT_SETTINGS, fontSize: 1.5 };
    localStorage.setItem(MIGRATION_VERSION_KEY, "1garbage");

    expect(getSettingsSync().fontSize).toBe(2);
    await expect(getSettings()).resolves.toMatchObject({ fontSize: 2 });
    expect((mocks.stored as Settings).fontSize).toBe(2);
  });
});
