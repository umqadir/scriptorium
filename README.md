# Scriptorium

Type your way through your own books. Monkeytype's feel, your EPUB library.

[Open Scriptorium](https://umqadir.github.io/scriptorium/)

Drop in an EPUB, pick which sections you actually want to type, and go. It keeps
your place, tracks WPM, accuracy and consistency, and looks like Monkeytype
because it borrows Monkeytype's themes and typing UI.

Runs entirely in the browser. No account, no server, no upload limits, no
"3 books free" tier.

## Why

Existing options each fall short somewhere: Typersguild and TypeLit put personal
uploads behind a subscription, Entertrained caps the free tier at three books,
and Typing Tomes is free but has a character-alignment bug that reports correct
keystrokes as errors. This is the version that just works.

## Design rules

**One canonical character stream.** The text you see and the text you're graded
against are the same characters at the same indices, normalized exactly once at
parse time. This is not an implementation detail — it is the bug that motivated
the project. Typing Tomes trims its comparison string but not its displayed
string, so a single leading space in the EPUB's XHTML shifts every character by
one and every correct keystroke reads as wrong. Here there is no second string
to drift.

**Your books stay on your machine.** Books live in your browser's IndexedDB and
are never transmitted. Cross-device sync moves progress, settings and book
*titles* only — never text. Books are keyed by a content hash, so importing the
same EPUB on a second device automatically picks up the position you left off at
on the first, without the file ever leaving either one.

**Static and offline.** Builds to plain files, installs as a PWA, and reloads
with the network off after the first visit.

## EPUB handling

Real commercially-produced EPUBs are messy. The parser handles what actually
shows up in them:

- Inline anchors splitting words (`beyond<a id="..."/> count`) — no injected
  or swallowed spaces
- Literal verse line numbers sitting in the text content, stripped only when
  they form a genuine ascending sequence
- Leading whitespace and indentation artifacts in the XHTML
- Curly quotes, em/en dashes and ellipses folded to keys you can actually press
- Accented characters optionally folded to ASCII
- Footnote markers, page-break anchors, hidden divs and images dropped
- Front and back matter classified so a 196KB introduction, endnotes and a
  glossary are excluded by default — and included with one click if you want them

The regression suite uses an original synthetic EPUB containing the same kinds
of malformed markup and conversion artifacts found across a corpus of real
books. It checks the full import pipeline without redistributing copyrighted
text. Local real-book fixtures can be added under `tests/fixtures/`; EPUB files
there are gitignored.

## Development

```bash
pnpm install
pnpm dev
```

```bash
pnpm test
```

```bash
pnpm build
```

The production build includes the web manifest and service worker used for
offline reloads. GitHub Pages deployment is defined in
`.github/workflows/deploy.yml`.

Stack: Vite, TypeScript, no UI framework. `fflate` for unzip, `idb` for storage.
The typing hot path is hand-written DOM — on each keystroke only the character
spans that changed are mutated.

## License

GPL-3.0. Derived from [Monkeytype](https://github.com/monkeytypegame/monkeytype),
also GPL-3.0 — see [NOTICE](NOTICE) for exactly what was borrowed. Not affiliated
with or endorsed by Monkeytype.
