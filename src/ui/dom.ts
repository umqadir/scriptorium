/** Tiny hand-rolled DOM helper — no framework, per project constraints. */

type Child = Node | string | null | undefined | false;

type ElProps = {
  [key: string]: unknown;
  className?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Record<string, EventListenerOrEventListenerObject>;
};

/**
 * Create an element with attributes/props/children.
 * `el("button", { className: "button", text: "Go", on: { click: fn } })`
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { className, text, html, attrs, on, ...rest } = props;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (html !== undefined) node.innerHTML = html;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (on) {
    for (const [evt, handler] of Object.entries(on)) {
      node.addEventListener(evt, handler);
    }
  }
  for (const [k, v] of Object.entries(rest)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any)[k] = v;
  }
  for (const child of children) {
    appendChild(node, child);
  }
  return node;
}

function appendChild(node: HTMLElement, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === "string") {
    node.appendChild(document.createTextNode(child));
  } else {
    node.appendChild(child);
  }
}

export function clear(node: HTMLElement | DocumentFragment): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const child of children) appendChild(f as unknown as HTMLElement, child);
  return f;
}

/** Debounce a function by `ms`. Trailing-edge only. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number
): ((...args: Args) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Args | undefined;
  const debounced = (...args: Args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      if (lastArgs) fn(...lastArgs);
    }
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastArgs = undefined;
  };
  return debounced;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
