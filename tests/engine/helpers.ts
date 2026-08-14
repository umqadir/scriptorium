/**
 * Shared test helpers: build synthetic ParsedBooks and drive a TypingSession
 * the same way a real browser would - dispatching keydown events at the
 * engine's hidden <input>, never by calling private methods directly.
 */

import type {
  Block,
  BlockKind,
  BookMeta,
  ParsedBook,
  Section,
  SectionKind,
  Settings,
} from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/types";

export function makeMeta(overrides: Partial<BookMeta> = {}): BookMeta {
  return {
    id: "testbook0000000",
    title: "Test Book",
    author: "Test Author",
    language: "en",
    addedAt: Date.now(),
    ...overrides,
  };
}

export type SectionSpec = {
  id: string;
  title?: string;
  kind?: SectionKind;
  included?: boolean;
  blocks: Array<{ text: string; kind?: BlockKind }>;
};

export function makeBook(sections: SectionSpec[], metaOverrides: Partial<BookMeta> = {}): ParsedBook {
  const builtSections: Section[] = sections.map((s, order) => {
    const blocks: Block[] = s.blocks.map((b) => ({
      kind: b.kind ?? "paragraph",
      text: b.text,
    }));
    const kind: SectionKind = s.kind ?? "body";
    return {
      id: s.id,
      href: `${s.id}.xhtml`,
      title: s.title ?? s.id,
      order,
      kind,
      included: s.included ?? kind === "body",
      blocks,
      charCount: blocks.reduce((sum, b) => sum + b.text.length, 0),
    };
  });
  return { meta: makeMeta(metaOverrides), sections: builtSections };
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** ~`length` characters of clean, typeable, single-spaced text with no
 * leading/trailing whitespace - used to stress-test long blocks. */
export function makeLongText(length: number): string {
  const unit = "abcdefghi "; // 9 letters + 1 space = 10 chars
  const repeats = Math.ceil(length / unit.length);
  let text = unit.repeat(repeats).slice(0, length);
  if (text.endsWith(" ")) text = text.slice(0, -1) + "z";
  return text;
}

export function getHiddenInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".scr-hidden-input");
  if (!input) throw new Error("hidden input not found - did the session start()?");
  return input;
}

export function pressChar(input: HTMLInputElement, ch: string): void {
  const event = new KeyboardEvent("keydown", {
    key: ch,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
}

export function pressBackspace(input: HTMLInputElement): void {
  const event = new KeyboardEvent("keydown", {
    key: "Backspace",
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
}

export function pressEnter(input: HTMLInputElement): void {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
}

/** Types every character of `text` in order via real keydown dispatch. */
export function typeText(input: HTMLInputElement, text: string): void {
  for (const ch of text) pressChar(input, ch);
}

/** Sum of block text lengths across all included sections of `book`. */
export function totalIncludedChars(book: ParsedBook): number {
  let total = 0;
  for (const section of book.sections) {
    if (!section.included) continue;
    for (const block of section.blocks) total += block.text.length;
  }
  return total;
}
