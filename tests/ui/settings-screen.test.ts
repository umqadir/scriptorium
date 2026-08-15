import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type SyncPayload } from "../../src/types";
import { themeNames } from "../../src/themes";

const mocks = vi.hoisted(() => {
  const listeners = new Set<(settings: Settings) => void>();
  const appState = {
    settings: { theme: "serika_dark" } as Settings,
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      appState.settings = { ...appState.settings, ...patch };
      for (const listener of listeners) listener(appState.settings);
    }),
    subscribe: vi.fn((listener: (settings: Settings) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    appState,
    listeners,
    download: vi.fn(),
    parseSyncPayloadFile: vi.fn(),
    listBooks: vi.fn(async () => []),
    listProgress: vi.fn(async () => []),
    saveProgress: vi.fn(async () => undefined),
  };
});

vi.mock("../../src/ui/state", () => ({ getAppState: () => mocks.appState }));
vi.mock("../../src/store/books", () => ({ listBooks: mocks.listBooks }));
vi.mock("../../src/store/progress", () => ({
  listProgress: mocks.listProgress,
  saveProgress: mocks.saveProgress,
}));
vi.mock("../../src/store/storage-usage", () => ({
  getStorageUsage: vi.fn(async () => ({ usageBytes: 1024, quotaBytes: 4096, percent: 25 })),
  formatBytes: (bytes: number) => `${bytes} B`,
}));
vi.mock("../../src/store/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/sync")>();
  return {
    ...actual,
    downloadSyncPayload: mocks.download,
    parseSyncPayloadFile: mocks.parseSyncPayloadFile,
  };
});
vi.mock("../../src/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../src/ui/router", () => ({ navigate: vi.fn() }));

import { mountSettings } from "../../src/ui/settings";

describe("settings screen", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    mocks.listeners.clear();
    mocks.appState.settings = { ...DEFAULT_SETTINGS };
    mocks.appState.updateSettings.mockClear();
    mocks.download.mockClear();
    mocks.parseSyncPayloadFile.mockReset();
    mocks.listBooks.mockReset();
    mocks.listBooks.mockResolvedValue([]);
    mocks.listProgress.mockReset();
    mocks.listProgress.mockResolvedValue([]);
  });

  test("offers every theme without dumping the full catalog into the page", () => {
    const container = document.createElement("main");
    mountSettings(container);

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Theme"]');
    if (!select) throw new Error("theme select missing");
    expect(select.options).toHaveLength(themeNames.length);
    expect(container.querySelectorAll(".theme-option")).toHaveLength(0);
    select.value = "8008";
    select.dispatchEvent(new Event("change"));
    expect(mocks.appState.updateSettings).toHaveBeenCalledWith({ theme: "8008" });
  });

  test("exposes the user-facing typing and appearance controls", () => {
    const container = document.createElement("main");
    mountSettings(container);

    expect(container.querySelector('select[aria-label="Reader font family"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Reader font size"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="Caret style"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Stop on error behavior"]')).not.toBeNull();
    const lessonLength = container.querySelector<HTMLInputElement>('input[aria-label="Lesson length"]');
    expect(lessonLength?.min).toBe("100");
    expect(lessonLength?.max).toBe("200");
    expect(lessonLength?.step).toBe("25");
    expect(lessonLength?.value).toBe("100");
    if (!lessonLength) throw new Error("lesson length control missing");
    lessonLength.value = "175";
    lessonLength.dispatchEvent(new Event("input"));
    expect(mocks.appState.updateSettings).toHaveBeenCalledWith({ lessonLength: 175 });
    expect(lessonLength.value).toBe("175");
    expect(container.querySelector('input[aria-label="Visible lines"]')).toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Theme"]')?.value).toBe("serika_dark");
  });

  test("exports metadata and progress without leaking extra book fields or text", async () => {
    mocks.listBooks.mockResolvedValue([
      {
        id: "book-1",
        title: "A title",
        author: "An author",
        language: "en",
        addedAt: 1,
        sections: [{ text: "BOOK TEXT MUST STAY LOCAL" }],
      } as never,
    ]);
    const container = document.createElement("main");
    mountSettings(container);
    const exportButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("export JSON"));
    if (!exportButton) throw new Error("export button missing");

    exportButton.click();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    const payload = mocks.download.mock.calls[0]?.[0];
    expect(payload.knownBooks).toEqual({ "book-1": { title: "A title", author: "An author" } });
    expect(JSON.stringify(payload)).not.toContain("BOOK TEXT MUST STAY LOCAL");
  });

  test("normalizes an invalid imported lesson length to the default", async () => {
    const remote: SyncPayload = {
      version: 1,
      updatedAt: Date.now(),
      progress: {},
      knownBooks: {},
      settings: { ...DEFAULT_SETTINGS, lessonLength: 137 },
    };
    mocks.parseSyncPayloadFile.mockResolvedValue(remote);
    const container = document.createElement("main");
    mountSettings(container);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("sync file input missing");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["{}"], "sync.json", { type: "application/json" })],
    });

    fileInput.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(mocks.appState.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lessonLength: 100 })
      );
    });
  });

  test("keeps sync local with JSON controls and no Gist workflow", () => {
    const container = document.createElement("main");
    mountSettings(container);

    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
    expect(labels).toContain("export JSON");
    expect(labels).toContain("import JSON");
    expect(container.querySelector('input[type="file"][accept*="json"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain("gist");
    expect(labels).not.toContain("connect");
    expect(labels).not.toContain("push");
    expect(labels).not.toContain("pull & merge");
  });
});
