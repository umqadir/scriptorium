import { expect, test } from "vitest";
import { themes, themeNames } from "../src/themes";

test("themes lifted intact", () => {
  expect(themeNames.length).toBeGreaterThan(180);
  expect(themes["serika_dark"]?.bg).toMatch(/^#/);
});
