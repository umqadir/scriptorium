import { describe, expect, test, vi } from "vitest";
// The project intentionally omits Node typings; this test-only import reads
// the stylesheet because Vitest stubs CSS (`?inline`/`?raw`) to an empty string.
// @ts-expect-error Node's runtime module is available to the Vitest process.
import { readFileSync } from "node:fs";
import {
  buildDom,
  keepLineInView,
  positionCaret,
  renderWindow,
} from "../../src/engine/dom";
import { makeSettings } from "./helpers";

const typingCss = readFileSync("src/engine/typing.css", "utf8");

function rect(input: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...input,
  };
}

describe("positionCaret", () => {
  test("underline caret uses a thin line at the glyph bottom", () => {
    const caret = document.createElement("div");
    const viewport = document.createElement("div");
    const anchor = document.createElement("span");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
      rect({ left: 5, top: 10 }),
    );
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect({ left: 30, top: 40, width: 10, height: 20 }),
    );

    positionCaret(caret, viewport, anchor, "underline", false);

    expect(caret.style.width).toBe("10px");
    expect(caret.style.height).toBe("1.6px");
    expect(caret.style.transform).toBe("translate(25px, 48.4px)");
  });
});

describe("buildDom", () => {
  test.each([
    [2, "3.2em"],
    [3, "4.8em"],
    [8, "12.8em"],
  ])("sets a %i-line viewport height", (contextLines, expectedHeight) => {
    const container = document.createElement("div");
    const refs = buildDom(container, makeSettings({ contextLines }));
    expect(refs.rootEl.style.getPropertyValue("--scr-viewport-height")).toBe(
      expectedHeight,
    );
  });

  test("defensively falls back to three lines for an unsupported direct setting", () => {
    const container = document.createElement("div");
    const refs = buildDom(container, makeSettings({ contextLines: 0 }));
    expect(refs.rootEl.style.getPropertyValue("--scr-viewport-height")).toBe(
      "4.8em",
    );
  });
});

describe("renderWindow", () => {
  test("groups characters into unbreakable words without changing character order", () => {
    const host = document.createElement("div");
    renderWindow(
      host,
      [
        {
          sectionIndex: 0,
          blockIndex: 0,
          block: { kind: "paragraph", text: "read this" },
        },
      ],
      () => "pending",
      () => [],
    );

    const words = host.querySelectorAll<HTMLElement>(".scr-word");
    expect([...words].map((word) => word.textContent)).toEqual(["read ", "this"]);
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("read this");
  });

  test("keeps source blocks as aligned rows without changing canonical spans", () => {
    const host = document.createElement("div");
    renderWindow(
      host,
      [
        {
          sectionIndex: 0,
          blockIndex: 0,
          block: { kind: "verse", text: "first line" },
          hasBoundary: true,
        },
        { sectionIndex: 0, blockIndex: 1, block: { kind: "verse", text: "second line" } },
      ],
      () => "pending",
      () => [],
      (_sectionIndex, blockIndex) => blockIndex === 0 ? "correct" : "pending",
    );

    expect(host.querySelectorAll(".scr-block")).toHaveLength(2);
    expect(host.querySelectorAll(".scr-word")).toHaveLength(4);
    expect(host.querySelectorAll(".scr-word--block-end")).toHaveLength(2);
    expect(host.querySelectorAll(".scr-char")).toHaveLength("first linesecond line".length);
    expect(host.querySelectorAll(".scr-boundary")).toHaveLength(1);
    expect(host.querySelector(".scr-boundary")?.textContent).toBe("¶");
    expect(host.querySelector(".scr-boundary")?.classList).toContain(
      "scr-boundary--correct",
    );
    expect(host.querySelector(".scr-word--block-end")?.textContent).toBe("line¶");
    expect(host.querySelectorAll(".scr-line-break")).toHaveLength(1);
    const blocks = host.querySelectorAll<HTMLElement>(".scr-block");
    expect([...blocks[0]!.children].filter((el) => el.classList.contains("scr-word"))).toHaveLength(2);
    expect([...blocks[1]!.children].filter((el) => el.classList.contains("scr-word"))).toHaveLength(2);
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("first linesecond line");
  });

  test("defines a centered capped grid with full-width wrapping block rows", () => {
    // happy-dom does not compute CSS Grid layout, so assert the stylesheet
    // contract directly and leave geometry to browser QA.
    expect(typingCss).toMatch(
      /\.scr-text\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*margin-inline:\s*auto;/s,
    );
    expect(typingCss).toMatch(
      /\.scr-block\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/s,
    );
    const blockRule = typingCss.match(/\.scr-block\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(blockRule).not.toMatch(/^\s*width\s*:/m);
    expect(typingCss).toMatch(/\.scr-word\s*\{[^}]*flex:\s*none;/s);
    expect(typingCss).toMatch(
      /\.scr-viewport\s*\{[^}]*height:\s*var\(--scr-viewport-height,\s*4\.8em\);/s,
    );
  });
});

describe("keepLineInView", () => {
  test("does not accumulate scroll for repeated keys on the same physical line", () => {
    const viewport = document.createElement("div");
    viewport.scrollTop = 40;

    keepLineInView(viewport, 80, 40);
    expect(viewport.scrollTop).toBe(40);
    keepLineInView(viewport, 80, 40);
    expect(viewport.scrollTop).toBe(40);
  });

  test("keeps one completed row above for 3–8 lines, but active row on top for 2", () => {
    const viewport = document.createElement("div");

    keepLineInView(viewport, 80, 40, 2);
    expect(viewport.scrollTop).toBe(80);

    viewport.scrollTop = 0;
    keepLineInView(viewport, 80, 40, 3);
    expect(viewport.scrollTop).toBe(40);

    viewport.scrollTop = 0;
    keepLineInView(viewport, 80, 40, 8);
    expect(viewport.scrollTop).toBe(40);
  });
});
