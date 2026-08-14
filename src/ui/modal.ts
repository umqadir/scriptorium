import { el } from "./dom";
import { iconSpan } from "./icons";

export type ModalHandle = {
  root: HTMLElement;
  close: () => void;
};

/**
 * Generic centered modal, Monkeytype-style (dim backdrop, rounded panel).
 * Traps focus, makes the page behind the dialog inert, returns focus to the
 * trigger on close, and closes on Escape or backdrop click. Content is
 * caller-supplied.
 */
let modalId = 0;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true"
  );
}

export function openModal(opts: {
  title?: string;
  content: HTMLElement | HTMLElement[];
  className?: string;
  closable?: boolean;
  onClose?: () => void;
}): ModalHandle {
  const closable = opts.closable ?? true;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const titleId = opts.title ? `modal-title-${++modalId}` : undefined;
  const title = opts.title
    ? el("div", { className: "title", attrs: { id: titleId } }, opts.title)
    : null;

  const body = el(
    "div",
    {
      className: "modal",
      attrs: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "aria-label": titleId ? undefined : "Dialog",
        tabindex: "-1",
      },
    },
    title,
    ...(Array.isArray(opts.content) ? opts.content : [opts.content])
  );

  let closed = false;

  const wrapper = el(
    "div",
    {
      className: `modalWrapper ${opts.className ?? ""}`.trim(),
      on: {
        mousedown: (e: Event) => {
          if (closable && e.target === wrapper) close();
        },
        keydown: (e: Event) => {
          const ke = e as KeyboardEvent;
          if (closable && ke.key === "Escape") {
            e.preventDefault();
            close();
            return;
          }
          if (ke.key !== "Tab") return;
          const focusable = focusableElements(body);
          if (focusable.length === 0) {
            e.preventDefault();
            body.focus();
            return;
          }
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          const active = document.activeElement;
          if (ke.shiftKey && (active === first || active === body)) {
            e.preventDefault();
            last.focus();
          } else if (!ke.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          } else if (!body.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        },
      },
    },
    body
  );

  if (closable) {
    body.prepend(
      el(
        "button",
        {
          className: "textButton modal-close",
          attrs: { type: "button", "aria-label": "Close dialog" },
          on: { click: () => close() },
        },
        iconSpan("x")
      )
    );
  }

  document.body.appendChild(wrapper);
  const background = Array.from(document.body.children)
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== wrapper)
    .map((node) => ({
      node,
      hadInert: node.hasAttribute("inert"),
      ariaHidden: node.getAttribute("aria-hidden"),
    }));
  for (const entry of background) {
    entry.node.setAttribute("inert", "");
    entry.node.setAttribute("aria-hidden", "true");
  }

  const initialFocus =
    body.querySelector<HTMLElement>("[data-modal-autofocus]") ??
    focusableElements(body)[0] ??
    body;
  initialFocus.focus();

  function close(): void {
    if (closed) return;
    closed = true;
    wrapper.remove();
    for (const entry of background) {
      if (!entry.hadInert) entry.node.removeAttribute("inert");
      if (entry.ariaHidden === null) entry.node.removeAttribute("aria-hidden");
      else entry.node.setAttribute("aria-hidden", entry.ariaHidden);
    }
    opts.onClose?.();
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  }

  return { root: wrapper, close };
}

/** Yes/no confirmation modal. Resolves true if confirmed, false if cancelled. */
export function confirmModal(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
      handle.close();
    };
    const actions = el(
      "div",
      { className: "modal-actions" },
      el("button", {
        className: "button text",
        text: opts.cancelLabel ?? "cancel",
        attrs: { type: "button", "data-modal-autofocus": "" },
        on: { click: () => finish(false) },
      }),
      el("button", {
        className: `button ${opts.danger ? "danger" : "active"}`,
        text: opts.confirmLabel ?? "confirm",
        attrs: { type: "button" },
        on: { click: () => finish(true) },
      })
    );
    const handle = openModal({
      title: opts.title,
      content: [el("p", { className: "text" }, opts.message), actions],
      onClose: () => {
        if (settled) return;
        settled = true;
        resolve(false);
      },
    });
  });
}
