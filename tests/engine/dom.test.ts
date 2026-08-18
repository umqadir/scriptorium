import { describe, expect, test, vi } from "vitest";
// The project intentionally omits Node typings; this test-only import reads
// the stylesheet because Vitest stubs CSS (`?inline`/`?raw`) to an empty string.
// @ts-expect-error Node's runtime module is available to the Vitest process.
import { readFileSync } from "node:fs";
import {
  buildDom,
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
  test.each([2, 3, 8])("does not clip a finite lesson at %i context lines", (contextLines) => {
    const container = document.createElement("div");
    const refs = buildDom(container, makeSettings({ contextLines }));
    expect(refs.rootEl.style.getPropertyValue("--scr-viewport-height")).toBe("");
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

  test("keeps prose extras inside inline word wrappers without changing canonical spans", () => {
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
      (_sectionIndex, _blockIndex, wordStart) =>
        wordStart === 0 ? ["x"] : [],
    );

    expect(host.querySelector(".scr-block--paragraph")).not.toBeNull();
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-word")].map(
        (word) => word.textContent,
      ),
    ).toEqual(["readx ", "this"]);
    expect(host.querySelector(".scr-char--extra")?.textContent).toBe("x");
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char:not(.scr-char--extra)")]
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
    expect(blocks[0]!.querySelector(".scr-line-tail")?.children).toHaveLength(2);
    expect(blocks[1]!.querySelector(".scr-line-tail")?.children).toHaveLength(2);
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("first linesecond line");
  });

  test("pilcrow does not add intrinsic width to the exact reported final prose word", () => {
    const host = document.createElement("div");
    const text =
      "The girl I will not give back; sooner will old age come upon her";
    const refs = renderWindow(
      host,
      [
        {
          sectionIndex: 0,
          blockIndex: 0,
          block: { kind: "paragraph", text },
          hasBoundary: true,
        },
      ],
      () => "pending",
      () => [],
    );

    const finalWord = host.querySelector<HTMLElement>(".scr-word--block-end")!;
    const marker = refs.boundaryIndex.get("0:0")!;
    const lineTail = host.querySelector<HTMLElement>(".scr-line-tail")!;
    expect(finalWord.textContent).toBe("her¶");
    expect(marker.parentElement).toBe(finalWord);
    expect(
      [...lineTail.children].map((word) => word.textContent),
    ).toEqual(["upon ", "her¶"]);
    expect(host.querySelectorAll(".scr-line-break")).toHaveLength(1);
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe(text);

    // happy-dom has no layout engine, so lock the geometry contract directly:
    // the wrapper establishes the positioning box and the pilcrow is removed
    // from inline sizing at the wrapper's trailing edge.
    expect(typingCss).toMatch(
      /\.scr-word--block-end\s*\{[^}]*position:\s*relative;/s,
    );
    expect(typingCss).toMatch(
      /\.scr-boundary\s*\{[^}]*position:\s*absolute;[^}]*inset-inline-start:\s*100%;[^}]*top:\s*0;/s,
    );
    expect(typingCss).toMatch(
      /\.scr-line-tail\s*\{[^}]*display:\s*inline-flex;[^}]*flex:\s*none;[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*100%;/s,
    );
  });

  test("does not manufacture a widow group for a one-word source block", () => {
    const host = document.createElement("div");
    renderWindow(
      host,
      [
        {
          sectionIndex: 0,
          blockIndex: 0,
          block: { kind: "verse", text: "Sing" },
          hasBoundary: true,
        },
      ],
      () => "pending",
      () => [],
    );

    expect(host.querySelector(".scr-line-tail")).toBeNull();
    expect(host.querySelector(".scr-word")?.textContent).toBe("Sing¶");
  });

  test("renders a partial lesson block with canonical indices, extras keys, and pilcrow", () => {
    const host = document.createElement("div");
    const requestedWordStarts: number[] = [];
    const refs = renderWindow(
      host,
      [
        {
          sectionIndex: 2,
          blockIndex: 4,
          block: { kind: "paragraph", text: "zero one two" },
          startCharIndex: 5,
          hasBoundary: true,
        },
      ],
      () => "pending",
      (_sectionIndex, _blockIndex, wordStart) => {
        requestedWordStarts.push(wordStart);
        return [];
      },
    );

    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("one two");
    expect(refs.spanIndex.has("2:4:4")).toBe(false);
    expect(refs.spanIndex.get("2:4:5")?.textContent).toBe("o");
    expect(refs.spanIndex.get("2:4:11")?.textContent).toBe("o");
    expect(requestedWordStarts).toEqual([5, 9]);
    expect(refs.boundaryIndex.get("2:4")?.textContent).toBe("¶");
  });

  test("keeps a boundary target when a partial block starts at canonical end", () => {
    const host = document.createElement("div");
    const refs = renderWindow(
      host,
      [
        {
          sectionIndex: 0,
          blockIndex: 0,
          block: { kind: "verse", text: "line" },
          startCharIndex: 4,
          hasBoundary: true,
        },
      ],
      () => "pending",
      () => [],
    );

    expect(host.querySelectorAll(".scr-char")).toHaveLength(0);
    expect(refs.boundaryIndex.get("0:0")?.textContent).toBe("¶");
  });

  test("honors an exclusive finite-lesson end without renumbering canonical spans", () => {
    const host = document.createElement("div");
    const refs = renderWindow(
      host,
      [
        {
          sectionIndex: 1,
          blockIndex: 2,
          block: { kind: "paragraph", text: "one two future" },
          endCharIndex: 8,
        },
      ],
      () => "pending",
      () => [],
    );

    expect(host.textContent).toBe("one two ");
    expect(refs.spanIndex.get("1:2:7")?.textContent).toBe(" ");
    expect(refs.spanIndex.has("1:2:8")).toBe(false);
  });

  test("defines a full-width finite fragment with greedy prose wrapping", () => {
    // happy-dom does not compute the imported stylesheet, so assert its
    // contract directly and leave geometry to browser QA.
    expect(typingCss).toMatch(
      /\.scr-text\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*margin:\s*0;/s,
    );
    expect(typingCss).toMatch(
      /\.scr-block\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/s,
    );
    const blockRule = typingCss.match(/\.scr-block\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(blockRule).not.toMatch(/^\s*width\s*:/m);
    expect(typingCss).toMatch(/\.scr-word\s*\{[^}]*flex:\s*none;/s);
    expect(typingCss).toMatch(
      /\.scr-block--paragraph,\s*\.scr-block--blockquote\s*\{[^}]*display:\s*block;[^}]*text-wrap:\s*wrap;/s,
    );
    expect(typingCss).not.toMatch(
      /text-wrap:\s*(?:balance|pretty)/,
    );
    expect(typingCss).not.toMatch(
      /\.scr-block--(?:verse|heading)[^{]*\{[^}]*text-wrap\s*:/s,
    );
    expect(typingCss).toMatch(
      /\.scr-viewport\s*\{[^}]*overflow:\s*visible;[^}]*height:\s*auto;/s,
    );
  });
});
