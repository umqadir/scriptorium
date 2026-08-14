import { afterEach, describe, expect, test, vi } from "vitest";
import { confirmModal, openModal } from "../../src/ui/modal";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("openModal", () => {
  test("labels the dialog, isolates the background, and restores focus and attributes", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-hidden", "false");
    document.body.appendChild(trigger);
    trigger.focus();

    const handle = openModal({ title: "Preferences", content: document.createElement("p") });
    const dialog = handle.root.querySelector<HTMLElement>('[role="dialog"]');
    const title = handle.root.querySelector<HTMLElement>(".title");

    expect(dialog?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(title?.textContent).toBe("Preferences");
    expect(trigger.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-hidden")).toBe("true");
    expect((document.activeElement as HTMLElement)?.getAttribute("aria-label")).toBe("Close dialog");

    handle.close();
    expect(trigger.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("honors safe autofocus, traps Tab in both directions, and closes once", () => {
    const first = document.createElement("button");
    first.dataset.modalAutofocus = "";
    const last = document.createElement("button");
    const onClose = vi.fn();
    const handle = openModal({ content: [first, last], closable: false, onClose });

    expect(document.activeElement).toBe(first);
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })
    );
    expect(document.activeElement).toBe(last);

    handle.close();
    handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("confirmModal", () => {
  test("focuses cancel by default and resolves false without recursive closing", async () => {
    const result = confirmModal({ title: "Delete book", message: "This cannot be undone." });
    const cancel = document.querySelector<HTMLButtonElement>("[data-modal-autofocus]");

    expect(document.activeElement).toBe(cancel);
    cancel?.click();

    await expect(result).resolves.toBe(false);
    expect(document.querySelector(".modalWrapper")).toBeNull();
  });
});
