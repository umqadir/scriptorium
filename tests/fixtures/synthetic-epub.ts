/**
 * A synthetic EPUB containing every pathology found in a corpus audit of nine
 * real books, so the full pipeline can be tested in CI without redistributing
 * anyone's copyrighted text.
 *
 * All prose here is written for this fixture. Real books (the Iliad and
 * friends) are used for local validation only and are gitignored.
 *
 * Each pathology is tagged [Pn] in a comment and asserted in the tests.
 */
import { zipSync, strToU8 } from "fflate";

const NBSP = " ";
const EMSP4 = " "; // four-per-em space — 3,093 of these in one corpus book
const ZWSP = "​";
const SHY = "­"; // soft hyphen

/** [P1] nbsp indents, [P2] literal verse line numbers, [P3] inline anchors
 *  splitting words, [P4] curly punctuation, [P5] accents & ligatures,
 *  [P6] untypeable Greek, [P7] hidden div, [P8] footnote markers. */
const chapterOne = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body>
<div style="display:none;"><a id="hidden.1"/>THIS MUST NOT APPEAR</div>
<h2 class="label"><a id="page_1"/><a id="ch1"/>CHAPTER ONE</h2>
<div class="left">
<p class="indent1t">${NBSP}${NBSP}${NBSP}<a id="c1_1"/>The lantern${ZWSP} guttered as she read the ledger${NBSP}again.</p>
<p class="noindent"><a id="c1_2"/>She had wanted any${SHY}thing but this, and the clerk knew it well<sup>1</sup>.</p>
<p class="noindent"><a id="c1_3"/>He said, &#8220;You will find beyond<a id="GBS.001"/> count of errors here,&#8221;</p>
<p class="noindent"><a id="c1_4"/>5${NBSP}${NBSP}${NBSP}and turned the page&#8212;slowly&#8212;toward the margin&#8230;</p>
<p class="noindent"><a id="c1_5"/>The na&#239;ve archivist, Ren&#233;e, had filed it under &#198;sop.</p>
<p class="noindent"><a id="c1_6"/>A note in the margin read &#957;&#949; and nothing else. &#169;</p>
<p class="noindent"><a id="c1_7"/>10${NBSP}${NBSP}She wrote the word anything twice , and then thrice .</p>
<p class="noindent"><a id="c1_8"/>The ledger was a good- sized volume, three- or four- hundred pages.</p>
<p class="noindent"><a id="c1_9"/>It would take her to${NBSP}ward morning to finish, she thought&#8212;himself- it was hopeless.</p>
<p class="noindent"><a id="c1_10"/>15${NBSP}${NBSP}The ﬁrst and ﬂeeting thought was of the commandant.</p>
<p class="noindent"><a id="c1_11"/>He had written any- thing at all in that com- mandant&#8217;s hand.</p>
<p>*${NBSP}${NBSP}*${NBSP}${NBSP}*</p>
<p>2</p>
<p>&#8226;</p>
<p>A</p>
</div>
</body></html>`;

/** [P9] a run-on chapter whose paragraph breaks survive only as nbsp indents,
 *  the way a bad PDF conversion leaves them. Must be recovered into paragraphs
 *  and then split at sentence boundaries. */
function runOnChapter(): string {
  const para = (n: number): string =>
    `${NBSP}${NBSP}${NBSP}The archivist counted the ${n}th shelf and found it wanting. ` +
    `She had expected order and found only the slow accumulation of other ` +
    `people's intentions. Every ledger told the same story in a different hand, ` +
    `and every hand had grown tired at the same place near the bottom of the page. ` +
    `It was, she decided, a kind of argument about time.`;
  const body = Array.from({ length: 14 }, (_, i) => para(i + 1)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>
<body><h2>CHAPTER TWO</h2><p>${body}</p></body></html>`;
}

/** [P10] Kobo-style per-sentence span injection, [P11] exotic whitespace,
 *  [P12] ALLCAPS speaker labels that must NOT be treated as running heads. */
const chapterThree = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Three</title></head>
<body>
<h2>CHAPTER THREE</h2>
<p><span class="koboSpan" id="k1">The door opened.</span><span class="koboSpan" id="k2"> A man came in.</span><span class="koboSpan" id="k3"> He was carrying anything he could hold.</span></p>
<p>THE CLERK</p>
<p>I have told you${EMSP4}already, the ledger is closed.</p>
<p>THE CLERK</p>
<p>And I shall tell you again, at length, until the matter is settled between us.</p>
<p>THE CLERK</p>
<p>The commandant will hear of it before the week is out, I promise you that much.</p>
</body></html>`;

const frontMatter = (title: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Synthetic Ledger</dc:title>
    <dc:creator>A. Fixture</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:synthetic-0001</dc:identifier>
  </metadata>
  <manifest>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
    <item href="cover.xhtml" id="cover" media-type="application/xhtml+xml"/>
    <item href="toc.xhtml" id="toc" media-type="application/xhtml+xml"/>
    <item href="intro.xhtml" id="int" media-type="application/xhtml+xml"/>
    <item href="ch1.xhtml" id="ch01" media-type="application/xhtml+xml"/>
    <item href="ch2.xhtml" id="ch02" media-type="application/xhtml+xml"/>
    <item href="ch3.xhtml" id="ch03" media-type="application/xhtml+xml"/>
    <item href="notes.xhtml" id="not" media-type="application/xhtml+xml"/>
    <item href="glossary.xhtml" id="glo" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/><itemref idref="toc"/><itemref idref="int"/>
    <itemref idref="ch01"/><itemref idref="ch02"/><itemref idref="ch03"/>
    <itemref idref="not"/><itemref idref="glo"/>
  </spine>
</package>`;

const nav = (id: string, order: number, label: string, src: string): string =>
  `<navPoint id="${id}" playOrder="${order}"><navLabel><text>${label}</text></navLabel><content src="${src}"/></navPoint>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:synthetic-0001"/></head>
  <docTitle><text>The Synthetic Ledger</text></docTitle>
  <navMap>
    ${nav("n1", 1, "Cover", "cover.xhtml")}
    ${nav("n2", 2, "Contents", "toc.xhtml")}
    ${nav("n3", 3, "Introduction", "intro.xhtml")}
    ${nav("n4", 4, "Chapter One", "ch1.xhtml#ch1")}
    ${nav("n5", 5, "Chapter Two", "ch2.xhtml")}
    ${nav("n6", 6, "Chapter Three", "ch3.xhtml")}
    ${nav("n7", 7, "Notes", "notes.xhtml")}
    ${nav("n8", 8, "Glossary", "glossary.xhtml")}
  </navMap>
</ncx>`;

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** Build the fixture EPUB as raw bytes. */
export function makeSyntheticEpub(): Uint8Array {
  return zipSync(
    {
      // must be first and stored, per the EPUB spec
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(CONTAINER),
      "OEBPS/content.opf": strToU8(OPF),
      "OEBPS/toc.ncx": strToU8(NCX),
      "OEBPS/cover.xhtml": strToU8(frontMatter("Cover", "The Synthetic Ledger")),
      "OEBPS/toc.xhtml": strToU8(frontMatter("Contents", "Chapter One. Chapter Two.")),
      "OEBPS/intro.xhtml": strToU8(
        frontMatter("Introduction", "This introduction should be excluded by default."),
      ),
      "OEBPS/ch1.xhtml": strToU8(chapterOne),
      "OEBPS/ch2.xhtml": strToU8(runOnChapter()),
      "OEBPS/ch3.xhtml": strToU8(chapterThree),
      "OEBPS/notes.xhtml": strToU8(frontMatter("Notes", "1. Endnotes are excluded by default.")),
      "OEBPS/glossary.xhtml": strToU8(frontMatter("Glossary", "ledger, n. a book of record.")),
    },
    { level: 0 },
  );
}

/**
 * The same book, but with its text mangled by the classic
 * UTF-8-decoded-as-Latin-1 mistake, for testing mojibake repair.
 */
export function makeMojibakeText(): string {
  return (
    "He said, â€œYou will find beyond count of errors here,â€ " +
    "and turned the pageâ€”slowlyâ€”toward the marginâ€¦ " +
    "The naÃ¯ve archivist, RenÃ©e, had filed it under donâ€™t."
  );
}

/** What makeMojibakeText() should repair to. */
export const MOJIBAKE_EXPECTED =
  "He said, “You will find beyond count of errors here,” " +
  "and turned the page—slowly—toward the margin… " +
  "The naïve archivist, Renée, had filed it under don’t.";
