import { el } from "./dom";

let container: HTMLElement | undefined;

function getContainer(): HTMLElement {
  if (!container) {
    container = el("div", { className: "toast-stack", attrs: { role: "status", "aria-live": "polite" } });
    document.body.appendChild(container);
  }
  return container;
}

export type ToastKind = "info" | "warning" | "error" | "success";

export function showToast(message: string, kind: ToastKind = "info", timeoutMs = 4500): void {
  const stack = getContainer();
  const toast = el("div", { className: `toast toast-${kind}` }, message);
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-in"));
  const remove = () => {
    toast.classList.remove("toast-in");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500); // fallback if transitionend doesn't fire
  };
  setTimeout(remove, timeoutMs);
}
