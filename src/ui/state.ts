/**
 * In-memory app state + a tiny pub/sub. This is view-layer state (what's
 * currently loaded/selected), distinct from src/store/** which is the
 * IndexedDB persistence layer. Screens read/write through here so settings
 * changes (e.g. from the command palette or the settings screen) are
 * reflected everywhere without a framework's reactivity system.
 */
import type { Settings } from "../types";
import { applyTheme } from "../styles/theme";
import { saveSettings } from "../store/settings";
import { themes } from "../themes";

type Listener = (settings: Settings) => void;

class AppState {
  private _settings: Settings;
  private listeners = new Set<Listener>();

  constructor(initial: Settings) {
    this._settings = initial;
  }

  get settings(): Settings {
    return this._settings;
  }

  /** Update in-memory settings, apply visible effects (theme), persist, and
   * notify subscribers. Fire-and-forget on the persistence (callers that
   * care about completion can await the returned promise). */
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this._settings = { ...this._settings, ...patch };
    if (patch.theme) {
      applyCurrentTheme(this._settings.theme);
    }
    applyFontVars(this._settings);
    for (const listener of this.listeners) listener(this._settings);
    await saveSettings(this._settings);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function applyCurrentTheme(themeName: string): void {
  const theme = themes[themeName] ?? themes["serika_dark"];
  if (theme) applyTheme(theme);
}

export function applyFontVars(settings: Settings): void {
  document.documentElement.style.setProperty("--font-size-scale", String(settings.fontSize));
  document.documentElement.style.setProperty(
    "--reader-font",
    `"${settings.fontFamily}", ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`
  );
}

// Module-level singleton, created once settings are loaded at boot (see main.ts).
let appState: AppState | undefined;

export function initAppState(settings: Settings): AppState {
  appState = new AppState(settings);
  applyCurrentTheme(settings.theme);
  applyFontVars(settings);
  return appState;
}

export function getAppState(): AppState {
  if (!appState) throw new Error("AppState accessed before initAppState()");
  return appState;
}
