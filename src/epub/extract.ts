/**
 * Structural extraction: walk a section's parsed XHTML `Document` and
 * produce raw `Block[]` — one Block per block-level element or visible
 * `<br>`-delimited segment, text
 * concatenated per the zero-width-anchor / hidden-content / footnote-marker
 * rules in SPEC.md. Text here is NOT YET character-normalized (no NBSP
 * collapsing, no curly-quote folding) — that's normalize.ts's job, run
 * afterward as its own pipeline stage. The one exception is literal verse
 * line numbers: stripping those is structural (it depends on cross-block,
 * section-scoped sequence analysis) and fixture-specific, so it happens
 * here, before normalization, on the raw text.
 */

import type { Block, BlockKind, ParseWarning } from "../types";
import { trimWhitespaceClass, WHITESPACE_CLASS_CHARS } from "./normalize";

// Elements whose entire subtree contributes nothing to extracted text.
const SKIP_TAGS = new Set(["script", "style", "head", "img", "svg", "figure"]);

// Elements that, on their own, form exactly one Block (div is handled
// separately below since it's conditional on having no block children).
const LEAF_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// A p is classified "verse" instead of "paragraph" when it sits in a
// section where the majority of paragraphs are short — the proxy SPEC.md
// gives for "this section is poetry-ish".
const VERSE_SHORT_CHAR_THRESHOLD = 90;

// Literal verse line numbers look like `5   of dogs...` where the digits
// and the run of whitespace after them are TEXT content, not markup.
const VERSE_NUMBER_RE = new RegExp(`^(\\d{1,4})[${WHITESPACE_CLASS_CHARS}]{2,}`);

function hasDisplayNone(el: Element): boolean {
  const style = el.getAttribute("style");
  if (!style) return false;
  return /display\s*:\s*none/i.test(style);
}

function isDigitsOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && /^\d+$/.test(trimmed);
}

/**
 * Collect the text content of `node`'s subtree, honoring skip rules.
 * Inline elements (a, em, small, strong, span, ...) — whether they're
 * zero-width `<a id="..."/>` anchors or ordinary formatting — contribute
 * their text with NO inserted separator. That's what makes
 * `beyond<a id="x"/> count` come out as `beyond count`: the space already
 * lives in the second text node, and we never add one of our own around an
 * inline element boundary.
 *
 * A visible `<br>` is structural: it starts a new segment, which ultimately
 * becomes a new Block. It must not become a newline inside Block.text because
 * Block.text remains the canonical typeable stream; the engine represents
 * block boundaries separately. Skipped/hidden subtrees contribute neither
 * text nor break boundaries.
 */
function collectRawSegments(node: Node): string[] {
  const segments = [""];

  const append = (text: string): void => {
    const last = segments.length - 1;
    segments[last] = (segments[last] ?? "") + text;
  };

  const visit = (parent: Node): void => {
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      if (child.nodeType === 3 /* TEXT_NODE */) {
        append(child.nodeValue ?? "");
        continue;
      }
      if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (hasDisplayNone(el)) continue;
      if (tag === "br") {
        segments.push("");
        continue;
      }
      if ((tag === "sup" || tag === "sub") && isDigitsOnly(el.textContent ?? "")) {
        continue; // footnote marker
      }
      visit(el);
    }
  };

  visit(node);
  return segments;
}

function isBlockCandidateTag(tag: string): boolean {
  return LEAF_BLOCK_TAGS.has(tag) || tag === "div";
}

/** True if `el` has a block-candidate element anywhere in its subtree. */
function hasBlockDescendant(el: Element): boolean {
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const tag = child.tagName.toLowerCase();
    if (isBlockCandidateTag(tag)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

interface RawBlock {
  tag: string;
  /** Raw, un-normalized, verse-number-stripped text. */
  raw: string;
}

function collectRawBlocks(root: Element, out: RawBlock[]): void {
  const children = root.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (hasDisplayNone(child)) continue;

    if (tag === "div") {
      if (hasBlockDescendant(child)) {
        collectRawBlocks(child, out); // container, not a block itself
      } else {
        pushRawBlock(child, tag, out);
      }
      continue;
    }
    if (LEAF_BLOCK_TAGS.has(tag)) {
      pushRawBlock(child, tag, out);
      continue;
    }
    // Not a block-level tag (body, or some other wrapper) -- descend.
    collectRawBlocks(child, out);
  }
}

function pushRawBlock(el: Element, tag: string, out: RawBlock[]): void {
  for (const raw of collectRawSegments(el)) {
    // Drop structurally-empty segments early. Besides image-only blocks,
    // this suppresses empty output from leading, trailing, and consecutive
    // <br> elements without trimming meaningful raw text at this stage.
    if (trimWhitespaceClass(raw).length === 0) continue;
    out.push({ tag, raw });
  }
}

function blockKindForTag(tag: string): BlockKind {
  if (HEADING_TAGS.has(tag)) return "heading";
  if (tag === "blockquote") return "blockquote";
  return "paragraph"; // p, li, leaf div -- p may be upgraded to "verse" below
}

/** Strip literal verse line numbers, section-scoped. If >= 3 raw blocks
 *  start with `\d{1,4}` + 2-or-more whitespace-class chars AND those
 *  numbers form a strictly ascending sequence (in document order), strip
 *  the matched prefix from exactly those blocks and report it. Otherwise
 *  every block is left untouched -- a paragraph that legitimately starts
 *  with a number must survive. */
function stripVerseNumbers(raw: RawBlock[]): boolean {
  const matches: { index: number; num: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const block = raw[i];
    if (!block) continue;
    const m = block.raw.match(VERSE_NUMBER_RE);
    const numStr = m?.[1];
    if (m && numStr !== undefined) {
      matches.push({ index: i, num: parseInt(numStr, 10) });
    }
  }
  if (matches.length < 3) return false;

  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    const cur = matches[i];
    if (!prev || !cur || cur.num <= prev.num) return false;
  }

  for (const { index } of matches) {
    const block = raw[index];
    if (!block) continue;
    block.raw = block.raw.replace(VERSE_NUMBER_RE, "");
  }
  return true;
}

export interface ExtractReport {
  blocks: Block[];
  warnings: ParseWarning[];
}

/**
 * Full extraction with warnings, for internal use by index.ts (which knows
 * the sectionId to tag warnings with). The plain `extractBlocks` export
 * below is the trimmed public/composable-pipeline signature.
 */
export function extractBlocksWithReport(doc: Document, sectionId?: string): ExtractReport {
  const root = doc.body ?? doc.documentElement;
  const warnings: ParseWarning[] = [];
  if (!root) return { blocks: [], warnings };

  const raw: RawBlock[] = [];
  collectRawBlocks(root, raw);

  const stripped = stripVerseNumbers(raw);
  if (stripped) {
    warnings.push({
      code: "verse-numbers-stripped",
      message: "Stripped literal verse line numbers from the text.",
      ...(sectionId !== undefined ? { sectionId } : {}),
    });
  }

  // "Majority of this section's <p>s are short" is SPEC.md's proxy for
  // "this section is poetry-ish" -- when true, every <p> in the section
  // (not just the short ones) is classified as verse.
  const pIndices: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]?.tag === "p") pIndices.push(i);
  }
  let sectionIsVerse = false;
  if (pIndices.length > 0) {
    let shortCount = 0;
    for (const i of pIndices) {
      const block = raw[i];
      if (block && trimWhitespaceClass(block.raw).length < VERSE_SHORT_CHAR_THRESHOLD) shortCount++;
    }
    sectionIsVerse = shortCount / pIndices.length > 0.5;
  }

  const blocks: Block[] = [];
  for (const block of raw) {
    let kind = blockKindForTag(block.tag);
    if (block.tag === "p" && sectionIsVerse) kind = "verse";
    blocks.push({ kind, text: block.raw });
  }

  return { blocks, warnings };
}

/** Public composable pipeline stage: raw structural extraction only. */
export function extractBlocks(doc: Document): Block[] {
  return extractBlocksWithReport(doc).blocks;
}
