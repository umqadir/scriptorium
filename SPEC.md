# Scriptorium — build spec

Type your way through your own EPUBs, with Monkeytype's feel. Fully local, no backend.

## Non-negotiables

1. **One canonical character stream.** See the invariant block at the top of
   `src/types.ts`. Display and expected-keystroke are the same characters at the
   same indices. No parallel strings, ever. This app exists because Typing Tomes
   got this wrong and reported every keystroke as an error.
2. **No book content leaves the device.** Books live in IndexedDB. Sync carries
   progress + settings only (`SyncPayload`). Never add book text to it.
3. **Fully static.** Builds to plain files, deployable to GitHub Pages. No server,
   no auth, no telemetry, works offline after first load.
4. **GPL-3.0.** We lift Monkeytype's theme palettes and CSS idioms; the derived
   work stays GPL-3.0 with attribution in `NOTICE`.

## Normalization rules (`src/epub/normalize.ts`)

Applied **exactly once**, at parse time, producing `Block.text`.

| Input | Output | Why |
|---|---|---|
| `’ ‘ ‛ ′` | `'` | typeable on any keyboard |
| `“ ” „ ″ « »` | `"` | same |
| `— – ‒ −` | `-` | same |
| `…` | `...` | 1 glyph → 3 keys, so fold the *display* too |
| `      \t \n \r` + runs of spaces | single ` ` | uniform spacing |
| `​ ‌ ‍ ﻿` soft hyphen `­` | *(removed)* | invisible, untypeable |
| `ä é ñ å ø` … | `a e n a o` | **only if `foldAccents`**; NFD + strip combining marks, plus an explicit map for ø/æ/œ/ß/đ/ł |
| `ﬁ ﬂ` ligatures | `fi fl` | untypeable as one key |
| anything still outside the typeable set | *(removed, counted)* | emit a `dropped-chars` warning |

Typeable set after normalization: `A–Z a–z 0–9`, space, and
``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``. Assert this in a test.

Leading/trailing whitespace is trimmed per block; empty blocks are dropped.

## Text extraction (`src/epub/extract.ts`)

The Iliad fixture (`tests/fixtures/`) exercises every one of these. Test against it.

- **Zero-width anchors.** `beyond<a id="GBS.0097.03"/> count` must yield
  `beyond count` — concatenate text nodes directly, never insert a separator
  around inline elements.
- **Literal verse line numbers.** Lines look like
  `<p class="noindent7a1">5   of dogs, of all birds…</p>` — the `5` and its
  spaces are *text content*, not markup. Detect and strip: within a section,
  if ≥3 blocks match `^\d{1,4}\s{2,}` and their numbers form a strictly
  ascending sequence, strip that prefix from those blocks and emit a
  `verse-numbers-stripped` warning. If the sequence check fails, leave them
  alone — a paragraph legitimately starting with a number must survive.
- **Leading literal whitespace.** `<p class="indent1t">   <a/>Sing, goddess…`
  — trim per block (this exact pattern is the Typing Tomes bug).
- **Skip entirely:** `<script>`, `<style>`, `<head>`, elements with
  `display:none` inline style, `<img>`, `<svg>`, `<figure>`, and `<sup>` /
  `<sub>` that contain only digits (footnote markers).
- **Block elements** → one `Block` each: `p`, `h1`–`h6`, `blockquote`, `li`,
  `div` that has no block-level children.
- `kind`: `h1`–`h6` → `heading`; `blockquote` → `blockquote`; a `p` inside a
  section where the majority of `p`s are short (< 90 chars) and the section is
  poetry-ish → `verse`; otherwise `paragraph`.

## Section classification (`src/epub/parse.ts`)

Heuristics on spine href/id + TOC label. `frontmatter`: cover, title, copyright,
toc, dedication, epigraph, preface, foreword, introduction, translator's note,
maps. `backmatter`: notes, endnotes, glossary, index, bibliography, appendix,
colophon, about-the-author, ads. Everything else `body`.

Default `included = (kind === "body")`, user-overridable in the UI and persisted
in `BookProgress.sectionOverrides`. For the Iliad this should include the 24
books and exclude the 196KB intro, 193KB endnotes and 154KB glossary by default.

## Typing engine (`src/engine/`)

- Word-based like Monkeytype: space commits a word. Backspace within the current
  word always allowed; backspace into a *completed* word allowed only if it had
  an error.
- `stopOnError`: `off` (default) lets errors accumulate; `letter` refuses to
  advance past a wrong char; `word` blocks the space commit until the word is right.
- WPM = `chars / 5 / (minutes)`; raw counts every keystroke, net counts correct
  ones. Accuracy = correct / total keystrokes. Consistency = `100 * (1 - CoV)` over
  per-second raw WPM samples, clamped to 0–100.
- Renderer: one `<span>` per character, `contextLines` blocks visible, caret
  positioned from the span's `getBoundingClientRect`. Only mutate the spans whose
  state changed — no full re-render per keystroke.
- Hidden input must set `autocomplete="off" autocorrect="off" autocapitalize="off"
  spellcheck="false"` (Safari will otherwise mangle input).
- Progress bookmarks advance only at finite-lesson boundaries (completion,
  skip, or an explicit section/reset action). Refreshing mid-lesson restarts
  that lesson from its beginning; same-route pause/resume can retain the live
  cursor in memory.

## Storage (`src/store/`)

IndexedDB via `idb`. Stores: `books` (ParsedBook + raw Blob), `progress`,
`lessonNavigation` (local-only finite-lesson history), and `settings`.
Books are multi-MB — localStorage is not an option.

Sync is opt-in and manual-first: export/import a `SyncPayload` JSON file. If a
remote is configured, the same payload round-trips through the user's own private
GitHub Gist (their PAT, their storage). Merge rule: per book, newest `updatedAt`
wins; `lifetime` counters take the max of each field.

## Stack

Vite + TypeScript, no UI framework (the typing hot path is hand-tuned DOM).
`fflate` for unzip, `idb` for storage, `DOMParser` for XHTML. Vitest + happy-dom.
