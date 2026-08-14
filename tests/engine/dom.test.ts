import { describe, expect, test, vi } from "vitest";
import { keepLineInView, positionCaret, renderWindow } from "../../src/engine/dom";

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

  test("keeps separate source blocks in one continuous word flow", () => {
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
    expect(
      [...host.querySelectorAll<HTMLElement>(".scr-char")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe("first linesecond line");
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
});
