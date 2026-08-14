import { describe, expect, it } from "vitest";
import {
  SUPPORTED_BOOK_ACCEPT,
  isSupportedBookFile,
  parseBookFile,
} from "../../src/import/parse-book";
import {
  groupPdfTextItemsIntoLines,
  mapPdfError,
  pdfMetadataFromValues,
  reconstructPdfPageBlocks,
  suppressPdfPageArtifacts,
  type PdfTextItemLike,
} from "../../src/import/pdf";
import { TYPEABLE_RE } from "../../src/epub/normalize";

function textFile(source: string, name: string, type: string): File {
  return new File([source], name, { type });
}

function minimalPdfBytes(): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td (Hello PDF world.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Title (Tiny PDF) /Author (Fixture Writer) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("unified book parser", () => {
  it("recognizes every supported extension and MIME type", () => {
    for (const name of ["a.epub", "a.pdf", "a.txt", "a.md", "a.markdown", "a.html", "a.htm"]) {
      expect(isSupportedBookFile({ name, type: "" })).toBe(true);
    }
    expect(isSupportedBookFile({ name: "download", type: "application/pdf" })).toBe(true);
    expect(isSupportedBookFile({ name: "notes.bin", type: "text/markdown; charset=utf-8" })).toBe(true);
    expect(isSupportedBookFile({ name: "a.docx", type: "application/octet-stream" })).toBe(false);
    expect(SUPPORTED_BOOK_ACCEPT).toContain(".markdown");
    expect(SUPPORTED_BOOK_ACCEPT).toContain("application/pdf");
  });

  it("dispatches text files, derives filename titles, and hashes raw content only", async () => {
    const source = "First complete line.\nSecond complete line.";
    const first = await parseBookFile(textFile(source, "My_Book.txt", "text/plain"), {
      foldAccents: true,
    });
    const renamed = await parseBookFile(textFile(source, "Renamed.txt", "text/plain"), {
      foldAccents: true,
    });

    expect(first.book.meta.title).toBe("My Book");
    expect(first.book.meta.author).toBe("Unknown author");
    expect(first.book.meta.language).toBe("und");
    expect(first.book.meta.id).toBe(renamed.book.meta.id);
    expect(first.book.meta.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("preserves nonempty TXT lines and deterministic chapter boundaries", async () => {
    const result = await parseBookFile(textFile(
      "Opening words stay here.\r\n\r\nCHAPTER I\r\nFirst chapter line.\r\nSecond chapter line.\r\nCHAPTER II\r\nLast line.",
      "novel.txt",
      "text/plain",
    ));

    expect(result.book.sections.map((section) => section.title)).toEqual([
      "novel",
      "CHAPTER I",
      "CHAPTER II",
    ]);
    expect(result.book.sections.flatMap((section) => section.blocks.map((block) => block.text)))
      .toEqual([
        "Opening words stay here.",
        "CHAPTER I",
        "First chapter line.",
        "Second chapter line.",
        "CHAPTER II",
        "Last line.",
      ]);
  });

  it("rejoins fixed-width TXT prose within blank-line groups but preserves likely verse", async () => {
    const proseLine1 = "This is a deliberately long prose line that wraps at a fixed column without ending";
    const proseLine2 = "and continues on another similarly wide line before the paragraph reaches its close";
    const proseLine3 = "with a final shorter sentence.";
    const result = await parseBookFile(textFile(
      `${proseLine1}\n${proseLine2}\n${proseLine3}\n\n` +
      "Sing, goddess,\nOf the road,\nBring the wanderer home.",
      "mixed.txt",
      "text/plain",
    ));
    expect(result.book.sections[0]!.blocks).toEqual([
      { kind: "paragraph", text: `${proseLine1} ${proseLine2} ${proseLine3}` },
      { kind: "verse", text: "Sing, goddess," },
      { kind: "verse", text: "Of the road," },
      { kind: "verse", text: "Bring the wanderer home." },
    ]);
  });

  it("parses Markdown syntax inertly into heading sections and br blocks", async () => {
    const result = await parseBookFile(textFile(
      "# Chapter One\n\nThe **bold** opening.\n\nFirst verse  \nSecond *verse*.\n\n## Next Part\n\nA [linked phrase](https://example.com).",
      "poems.md",
      "text/markdown",
    ));

    expect(result.book.sections.map((section) => section.title)).toEqual(["Chapter One", "Next Part"]);
    const texts = result.book.sections.flatMap((section) => section.blocks.map((block) => block.text));
    expect(texts).toEqual([
      "Chapter One",
      "The bold opening.",
      "First verse",
      "Second verse.",
      "Next Part",
      "A linked phrase.",
    ]);
    expect(texts.join(" ")).not.toMatch(/\*\*|\[|\]\(/);
  });

  it("uses HTML metadata and preserves inline text around visible br boundaries", async () => {
    const result = await parseBookFile(textFile(
      `<!doctype html><html lang="es"><head><title>Web Book</title>
        <meta name="author" content="Ada Writer"></head><body>
        <h1>Opening</h1><p>Before <em>bold</em><br>after <strong>strong</strong>.</p>
        </body></html>`,
      "fallback.html",
      "text/html",
    ), { foldAccents: true });

    expect(result.book.meta).toMatchObject({ title: "Web Book", author: "Ada Writer", language: "es" });
    expect(result.book.sections).toHaveLength(1);
    expect(result.book.sections[0]!.title).toBe("Opening");
    expect(result.book.sections[0]!.blocks.map((block) => block.text)).toEqual([
      "Opening",
      "Before bold",
      "after strong.",
    ]);
    for (const block of result.book.sections[0]!.blocks) {
      expect(block.text).toMatch(TYPEABLE_RE);
      expect(block.text).not.toContain("\n");
    }
  });

  it("rejects unsupported input with a user-readable error", async () => {
    await expect(parseBookFile(textFile("data", "book.docx", "application/octet-stream")))
      .rejects.toThrow("Unsupported book format");
  });
});

describe("PDF import helpers", () => {
  const item = (str: string, x: number, y: number, width: number): PdfTextItemLike => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
  });

  it("groups positioned text into top-to-bottom lines and left-to-right words", () => {
    const lines = groupPdfTextItemsIntoLines([
      item("world", 48, 700, 30),
      item("Second", 10, 680, 38),
      item("Hello", 10, 700, 28),
      item("line", 58, 680, 20),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["Hello world", "Second line"]);
  });

  it("splits a column-sized baseline gap and uses column-major reading order", () => {
    const lines = groupPdfTextItemsIntoLines([
      item("Left first", 40, 700, 60),
      item("Right first", 340, 700, 65),
      item("Left second", 40, 680, 70),
      item("Right second", 340, 680, 75),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "Left first",
      "Left second",
      "Right first",
      "Right second",
    ]);
  });

  it("reconstructs wrapped prose but preserves ragged poetry lines", () => {
    const line = (text: string, x: number, y: number, width: number) => ({
      text, x, y, width, fontSize: 12,
    });
    const prose = reconstructPdfPageBlocks([
      line("The paragraph begins here and carries", 50, 700, 300),
      line("through another arbitrary layout wrap", 50, 686, 310),
      line("before ending normally.", 50, 672, 145),
    ]);
    expect(prose).toEqual([{
      kind: "paragraph",
      text: "The paragraph begins here and carries through another arbitrary layout wrap before ending normally.",
    }]);

    const poetry = reconstructPdfPageBlocks([
      line("Sing, goddess,", 70, 700, 145),
      line("Of the road", 92, 686, 90),
      line("Bring the wanderer home", 62, 672, 205),
    ]);
    expect(poetry).toEqual([
      { kind: "verse", text: "Sing, goddess," },
      { kind: "verse", text: "Of the road" },
      { kind: "verse", text: "Bring the wanderer home" },
    ]);
  });

  it("suppresses repeated edge headers, footers, and page numbers only", () => {
    const pages = suppressPdfPageArtifacts([1, 2, 3].map((pageNumber) => ({
      pageNumber,
      lines: [
        "A Book Title",
        `Opening body line ${pageNumber}.`,
        "Shared body phrase.",
        `Closing body line ${pageNumber}.`,
        String(pageNumber),
      ],
    })));
    expect(pages.map((page) => page.lines)).toEqual([
      ["Opening body line 1.", "Shared body phrase.", "Closing body line 1."],
      ["Opening body line 2.", "Shared body phrase.", "Closing body line 2."],
      ["Opening body line 3.", "Shared body phrase.", "Closing body line 3."],
    ]);
  });

  it("prefers document metadata and maps PDF errors without leaking internals", () => {
    const metadata = pdfMetadataFromValues(
      { Title: "Metadata Title", Author: "Author Name", Language: "de" },
      { get: () => "ignored" },
      "Fallback",
    );
    expect(metadata).toEqual({ title: "Metadata Title", author: "Author Name", language: "de" });
    expect(pdfMetadataFromValues({}, { get: (name) => name === "dc:title" ? "XMP Title" : undefined }, "Fallback").title)
      .toBe("XMP Title");
    expect(mapPdfError({ name: "PasswordException" }).message).toMatch(/password-protected/i);
    expect(mapPdfError({ name: "InvalidPDFException" }).message).toMatch(/not a valid PDF/i);
    expect(mapPdfError(new Error("surprise")).message).toBe("This PDF could not be read.");
  });

  it("parses a real minimal PDF end-to-end through the lazy unified dispatch", async () => {
    const bytes = minimalPdfBytes();
    const result = await parseBookFile(new File([bytes.slice().buffer], "fallback.pdf", {
      type: "application/pdf",
    }));
    const renamed = await parseBookFile(new File([bytes.slice().buffer], "renamed.pdf", {
      type: "application/pdf",
    }));
    expect(result.book.meta).toMatchObject({
      title: "Tiny PDF",
      author: "Fixture Writer",
    });
    expect(result.book.meta.id).toBe(renamed.book.meta.id);
    expect(result.book.sections.flatMap((section) => section.blocks.map((block) => block.text)))
      .toContain("Hello PDF world.");
  });
});
