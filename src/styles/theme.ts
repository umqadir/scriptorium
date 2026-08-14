/**
 * Theme application: maps a `Theme` palette (src/themes.ts) onto CSS custom
 * properties on a root element. All app CSS is written in terms of these
 * variables (see src/styles/main.css) so every one of the 187 themes works
 * without any per-theme CSS.
 *
 * Kept as a small pure-ish function (DOM side effect is the point, but no
 * IndexedDB/network/global state) so it's cheap to unit test with happy-dom.
 */
import type { Theme } from "../themes";

/** The exact custom-property names required by SPEC.md / the design brief. */
export const THEME_CSS_VARS = {
  bg: "--bg-color",
  main: "--main-color",
  caret: "--caret-color",
  sub: "--sub-color",
  subAlt: "--sub-alt-color",
  text: "--text-color",
  error: "--error-color",
  errorExtra: "--error-extra-color",
  colorfulError: "--colorful-error-color",
  colorfulErrorExtra: "--colorful-error-extra-color",
} as const satisfies Partial<Record<keyof Theme, string>>;

export type ThemeCssVarName = (typeof THEME_CSS_VARS)[keyof typeof THEME_CSS_VARS];

/**
 * Apply a theme's colors as CSS custom properties on `root` (defaults to the
 * document root, i.e. `:root` in CSS). Safe to call repeatedly (e.g. on
 * hover-preview in the theme picker) — it only ever sets properties, never
 * reads or depends on prior state.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  for (const key of Object.keys(THEME_CSS_VARS) as (keyof typeof THEME_CSS_VARS)[]) {
    const cssVar = THEME_CSS_VARS[key];
    const value = theme[key];
    root.style.setProperty(cssVar, value);
  }
}

/** Read the currently-applied theme colors back off `root`, for tests/debugging. */
export function readAppliedThemeVars(
  root: HTMLElement = document.documentElement
): Record<ThemeCssVarName, string> {
  const out = {} as Record<ThemeCssVarName, string>;
  for (const cssVar of Object.values(THEME_CSS_VARS)) {
    out[cssVar] = root.style.getPropertyValue(cssVar).trim();
  }
  return out;
}
