import { describe, expect, it } from "vitest";
import { extractBlocks, extractBlocksWithReport } from "../../src/epub/extract";

function documentWithBody(body: string): Document {
  return new DOMParser().parseFromString(
    `<html><head><title>Fixture</title></head><body>${body}</body></html>`,
    "text/html",
  );
}

describe("EPUB structural extraction at br boundaries", () => {
  it("splits visible br elements through inline formatting and preserves block kinds", () => {
    const blocks = extractBlocks(documentWithBody(
      `<h2>First <em>heading</em><br>continued<a id="zero"></a></h2>
       <blockquote>Before <em>bold</em><br>after <strong>strong</strong>.</blockquote>`,
    ));

    expect(blocks).toEqual([
      { kind: "heading", text: "First heading" },
      { kind: "heading", text: "continued" },
      { kind: "blockquote", text: "Before bold" },
      { kind: "blockquote", text: "after strong." },
    ]);
  });

  it("does not emit blocks for leading, trailing, consecutive, or whitespace-only breaks", () => {
    const blocks = extractBlocks(documentWithBody(
      `<p><br>alpha<br><br>   <br>beta<br></p>`,
    ));

    expect(blocks).toEqual([
      { kind: "verse", text: "alpha" },
      { kind: "verse", text: "beta" },
    ]);
  });

  it("lets hidden and skipped subtrees contribute neither text nor break boundaries", () => {
    const blocks = extractBlocks(documentWithBody(
      `<p>visible<span style="display: none">secret<br>phantom</span> line` +
      `<figure>bad<br>worse</figure><br><sup>12</sup>next<img src="x"> end</p>`,
    ));

    expect(blocks).toEqual([
      { kind: "verse", text: "visible line" },
      { kind: "verse", text: "next end" },
    ]);
  });

  it("strips an ascending poetry line-number sequence spanning br-split lines", () => {
    const result = extractBlocksWithReport(documentWithBody(
      `<p>5   Sing, <em>goddess</em><br>10   Tell of the long road<br>` +
      `15   Bring the wanderer home</p>`,
    ), "poem");

    expect(result.blocks).toEqual([
      { kind: "verse", text: "Sing, goddess" },
      { kind: "verse", text: "Tell of the long road" },
      { kind: "verse", text: "Bring the wanderer home" },
    ]);
    expect(result.warnings).toEqual([{
      code: "verse-numbers-stripped",
      message: "Stripped literal verse line numbers from the text.",
      sectionId: "poem",
    }]);
    expect(result.blocks.every((block) => !block.text.includes("\n"))).toBe(true);
  });

  it("leaves non-ascending numeric prefixes intact across br-split lines", () => {
    const result = extractBlocksWithReport(documentWithBody(
      `<p>5   First<br>4   Second<br>10   Third</p>`,
    ), "not-a-sequence");

    expect(result.blocks.map((block) => block.text)).toEqual([
      "5   First",
      "4   Second",
      "10   Third",
    ]);
    expect(result.warnings).toEqual([]);
  });
});
