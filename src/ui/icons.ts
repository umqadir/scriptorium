/**
 * Small inline-SVG icon set. Kept minimal and hand-drawn (stroke-based,
 * 24x24 viewBox, `currentColor`) so no icon font / CDN is needed offline.
 * Every icon-only button using these must still get an aria-label at the
 * button level — these SVGs are marked aria-hidden.
 */
function svg(paths: string, viewBox = "0 0 24 24"): string {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

export const icons = {
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  trash: svg(
    `<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>`
  ),
  book: svg(
    `<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>`
  ),
  list: svg(
    `<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>`
  ),
  search: svg(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`),
  gear: svg(
    `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`
  ),
  x: svg(`<path d="M18 6 6 18"/><path d="M6 6l12 12"/>`),
  arrowLeft: svg(`<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>`),
  arrowRight: svg(`<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>`),
  upload: svg(`<path d="M12 16V4"/><path d="M6 10l6-6 6 6"/><path d="M4 20h16"/>`),
  check: svg(`<path d="M20 6 9 17l-5-5"/>`),
  command: svg(
    `<path d="M9 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H9"/>`
  ),
  cloud: svg(
    `<path d="M17.5 19H8a5 5 0 1 1 1.29-9.84A6 6 0 0 1 21 11a4 4 0 0 1-3.5 8Z"/>`
  ),
  refresh: svg(
    `<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>`
  ),
  pause: svg(`<path d="M8 5v14"/><path d="M16 5v14"/>`),
  link: svg(
    `<path d="M9 15l6-6"/><path d="M8 8l1.5-1.5a4 4 0 0 1 5.66 5.66L14 13"/><path d="M16 16l-1.5 1.5a4 4 0 0 1-5.66-5.66L10 11"/>`
  ),
} as const;

export type IconName = keyof typeof icons;

export function iconSpan(name: IconName, className = "icon"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = icons[name];
  return span;
}
