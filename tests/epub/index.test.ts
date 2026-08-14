import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseEpub } from "../../src/epub";
import { TYPEABLE_RE } from "../../src/epub/normalize";
import { makeSyntheticEpub } from "../fixtures/synthetic-epub";

function asFile(bytes: Uint8Array, name = "book.epub"): File {
  return new File([bytes.slice().buffer], name, { type: "application/epub+zip" });
}

function minimalEpub(opf: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
      <c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container">
        <c:rootfiles><c:rootfile full-path="./OPS/package.opf"
          media-type="application/oebps-package+xml"/></c:rootfiles>
      </c:container>`),
    "OPS/package.opf": strToU8(opf),
    ...extra,
  }, { level: 0 });
}

describe("parseEpub", () => {
  it("runs the complete book-wide pipeline while preserving spine identity", async () => {
    const before = Date.now();
    const result = await parseEpub(asFile(makeSyntheticEpub(), "ledger.epub"), {
      foldAccents: true,
    });

    expect(result.book.meta).toMatchObject({
      title: "The Synthetic Ledger",
      author: "A. Fixture",
      language: "en",
    });
    expect(result.book.meta.id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.book.meta.addedAt).toBeGreaterThanOrEqual(before);
    expect(result.book.sections.map(({ id, order, title, kind, included }) => ({
      id, order, title, kind, included,
    }))).toEqual([
      { id: "cover", order: 0, title: "Cover", kind: "frontmatter", included: false },
      { id: "toc", order: 1, title: "Contents", kind: "frontmatter", included: false },
      { id: "int", order: 2, title: "Introduction", kind: "frontmatter", included: false },
      { id: "ch01", order: 3, title: "Chapter One", kind: "body", included: true },
      { id: "ch02", order: 4, title: "Chapter Two", kind: "body", included: true },
      { id: "ch03", order: 5, title: "Chapter Three", kind: "body", included: true },
      { id: "not", order: 6, title: "Notes", kind: "backmatter", included: false },
      { id: "glo", order: 7, title: "Glossary", kind: "backmatter", included: false },
    ]);

    const chapterOne = result.book.sections[3]!;
    const chapterOneText = chapterOne.blocks.map((block) => block.text).join("\n");
    expect(chapterOneText).not.toContain("THIS MUST NOT APPEAR");
    expect(chapterOneText).toContain("beyond count");
    expect(chapterOneText).toContain("The naive archivist, Renee, had filed it under AEsop.");
    expect(chapterOneText).toContain("and turned the page-slowly-toward the margin...");
    expect(chapterOneText).toContain("anything at all in that commandant's hand.");
    expect(chapterOneText).not.toMatch(/(?:^|\n)(?:5|10|15) /);
    expect(chapterOne.charCount).toBe(
      chapterOne.blocks.reduce((sum, block) => sum + block.text.length, 0),
    );

    const chapterTwo = result.book.sections[4]!;
    expect(chapterTwo.blocks.length).toBeGreaterThan(2);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "verse-numbers-stripped", sectionId: "ch01" }),
      expect.objectContaining({ code: "paragraphs-recovered" }),
      expect.objectContaining({ code: "dropped-chars", sectionId: "ch01" }),
      expect.objectContaining({ code: "no-cover" }),
    ]));
    for (const section of result.book.sections) {
      for (const block of section.blocks) {
        expect(block.text).toMatch(TYPEABLE_RE);
        expect(block.text).toBe(block.text.trim());
        expect(block.text).not.toContain("  ");
      }
    }
  });

  it("parses prefixed OPF, EPUB3 nav, encoded relative paths, and a PNG cover", async () => {
    const png1x1 = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ), (char) => char.charCodeAt(0));
    const opf = `<?xml version="1.0"?>
      <opf:package xmlns:opf="http://www.idpf.org/2007/opf"
        xmlns:d="http://purl.org/dc/elements/1.1/" version="3.0">
        <opf:metadata><d:title>Namespaced Book</d:title><d:creator>Writer</d:creator>
          <d:language>fr</d:language></opf:metadata>
        <opf:manifest>
          <opf:item id="nav" href="Nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <opf:item id="chapter" href="Text/Chapter%20One.xhtml" media-type="application/xhtml+xml"/>
          <opf:item id="art" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
        </opf:manifest>
        <opf:spine><opf:itemref idref="chapter"/></opf:spine>
      </opf:package>`;
    const bytes = minimalEpub(opf, {
      "OPS/Nav/nav.xhtml": strToU8(`<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol><li>
            <a href="../Text/Chapter%20One.xhtml#start">A Better Chapter Title</a>
          </li></ol></nav></body></html>`),
      "OPS/Text/Chapter One.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fallback Title</title></head>
          <body><h1 id="start">Heading</h1><p>Crème brûlée.</p></body></html>`),
      "OPS/Images/cover.png": png1x1,
    });

    const result = await parseEpub(asFile(bytes), { foldAccents: true });
    expect(result.book.sections).toHaveLength(1);
    expect(result.book.sections[0]).toMatchObject({
      id: "chapter",
      href: "Text/Chapter%20One.xhtml",
      title: "A Better Chapter Title",
      order: 0,
      kind: "body",
      included: true,
    });
    expect(result.book.sections[0]!.blocks[1]!.text).toBe("Creme brulee.");
    expect(result.book.meta.coverDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.warnings.some((warning) => warning.code === "no-cover")).toBe(false);
  });

  it("returns a no-spine warning instead of inventing a reading order", async () => {
    const bytes = minimalEpub(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Loose Pages</dc:title></metadata>
        <manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml"/></manifest>
      </package>`, {
      "OPS/page.xhtml": strToU8("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Text</p></body></html>"),
    });

    const result = await parseEpub(asFile(bytes), { foldAccents: false });
    expect(result.book.sections).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no-spine" }),
      expect.objectContaining({ code: "no-cover" }),
    ]));
  });

  it("rejects malformed archives with a useful error", async () => {
    await expect(parseEpub(asFile(strToU8("not a zip")), { foldAccents: true }))
      .rejects.toThrow("valid EPUB archive");
  });
});
