import { describe, expect, test } from "vitest";
import { applyTheme, readAppliedThemeVars, THEME_CSS_VARS } from "../../src/styles/theme";
import { themes } from "../../src/themes";

describe("applyTheme", () => {
  test("sets every required CSS custom property from the theme palette", () => {
    const root = document.createElement("div");
    const theme = themes["serika_dark"];
    if (!theme) throw new Error("expected serika_dark to exist");
    applyTheme(theme, root);

    expect(root.style.getPropertyValue("--bg-color").trim()).toBe(theme.bg);
    expect(root.style.getPropertyValue("--main-color").trim()).toBe(theme.main);
    expect(root.style.getPropertyValue("--caret-color").trim()).toBe(theme.caret);
    expect(root.style.getPropertyValue("--sub-color").trim()).toBe(theme.sub);
    expect(root.style.getPropertyValue("--sub-alt-color").trim()).toBe(theme.subAlt);
    expect(root.style.getPropertyValue("--text-color").trim()).toBe(theme.text);
    expect(root.style.getPropertyValue("--error-color").trim()).toBe(theme.error);
    expect(root.style.getPropertyValue("--error-extra-color").trim()).toBe(theme.errorExtra);
    expect(root.style.getPropertyValue("--colorful-error-color").trim()).toBe(theme.colorfulError);
    expect(root.style.getPropertyValue("--colorful-error-extra-color").trim()).toBe(
      theme.colorfulErrorExtra
    );
  });

  test("readAppliedThemeVars round-trips what applyTheme wrote", () => {
    const root = document.createElement("div");
    const theme = themes["8008"];
    if (!theme) throw new Error("expected theme 8008 to exist");
    applyTheme(theme, root);
    const read = readAppliedThemeVars(root);
    expect(read["--bg-color"]).toBe(theme.bg);
    expect(read["--main-color"]).toBe(theme.main);
  });

  test("re-applying a different theme overwrites all variables (hover-preview use case)", () => {
    const root = document.createElement("div");
    const a = themes["8008"];
    const b = themes["wavez"];
    if (!a || !b) throw new Error("expected both themes to exist");
    applyTheme(a, root);
    applyTheme(b, root);
    expect(root.style.getPropertyValue("--bg-color").trim()).toBe(b.bg);
    expect(root.style.getPropertyValue("--bg-color").trim()).not.toBe(a.bg);
  });

  test("defaults to document.documentElement when no root is passed", () => {
    const theme = themes["serika_dark"];
    if (!theme) throw new Error("expected serika_dark to exist");
    applyTheme(theme);
    expect(document.documentElement.style.getPropertyValue("--bg-color").trim()).toBe(theme.bg);
  });

  test("covers every theme in the palette without throwing", () => {
    const root = document.createElement("div");
    for (const theme of Object.values(themes)) {
      expect(() => applyTheme(theme, root)).not.toThrow();
      for (const cssVar of Object.values(THEME_CSS_VARS)) {
        expect(root.style.getPropertyValue(cssVar).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
