import { afterEach, describe, expect, test, vi } from "vitest";

const dbGet = vi.fn(async () => ({ token: "gist-token", gistId: "gist-id" }));

vi.mock("../../src/store/db", () => ({
  getDb: async () => ({ get: dbGet }),
  SETTINGS_KEY: "singleton",
  SYNC_CONFIG_KEY: "singleton",
}));

import { pullSyncPayloadFromGist } from "../../src/store/sync";

afterEach(() => {
  vi.unstubAllGlobals();
  dbGet.mockClear();
});

describe("pullSyncPayloadFromGist", () => {
  test("wraps malformed sync JSON in a user-friendly error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          files: { "scriptorium-sync.json": { content: "{not-json" } },
        }),
      }))
    );

    await expect(pullSyncPayloadFromGist()).rejects.toThrow(
      "The GitHub Gist contains invalid sync JSON."
    );
  });

  test("wraps a malformed Gist response envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ files: [] }) }))
    );

    await expect(pullSyncPayloadFromGist()).rejects.toThrow(
      "GitHub Gist returned an invalid response."
    );
  });
});
