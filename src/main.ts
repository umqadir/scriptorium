import "./styles/main.css";

import { getSettings, getSettingsSync } from "./store/settings";
import { themeNames } from "./themes";
import { clear, el } from "./ui/dom";
import { iconSpan, type IconName } from "./ui/icons";
import { mountImport, startImportFlow } from "./ui/import";
import { mountLibrary, type ScreenHandle } from "./ui/library";
import { openModal, type ModalHandle } from "./ui/modal";
import { mountReader } from "./ui/reader";
import {
  currentRoute,
  navigate,
  onRouteChange,
  routeToHash,
  type Route,
} from "./ui/router";
import { mountSettings } from "./ui/settings";
import { getAppState, initAppState } from "./ui/state";
import { showToast } from "./ui/toast";

type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void | Promise<void>;
};

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) throw new Error("Scriptorium could not find its #app mount point.");
const app: HTMLElement = appElement;

// Apply the localStorage mirror before opening IndexedDB. This keeps first paint
// on the user's chosen theme while the durable settings record is loading.
initAppState(getSettingsSync());

const fileInput = el("input", {
  className: "visually-hidden",
  attrs: {
    type: "file",
    accept: ".epub,application/epub+zip",
    hidden: true,
    tabindex: "-1",
    "aria-hidden": "true",
  },
}) as HTMLInputElement;

const brand = el(
  "a",
  {
    className: "app-brand",
    attrs: { href: routeToHash({ name: "library" }), "aria-label": "Scriptorium home" },
  },
  iconSpan("book"),
  "scriptorium"
);
const brandGroup = el(
  "div",
  { className: "app-brand-group" },
  brand,
  el(
    "a",
    {
      className: "app-credit",
      attrs: {
        href: "https://monkeytype.com/",
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": "Scriptorium is a Monkeytype fork; open Monkeytype",
      },
    },
    "a Monkeytype fork"
  )
);

function navLink(route: Route, icon: IconName, label: string): HTMLAnchorElement {
  return el(
    "a",
    {
      className: "icon-button",
      attrs: { href: routeToHash(route), "aria-label": label, title: label },
    },
    iconSpan(icon)
  );
}

const libraryLink = navLink({ name: "library" }, "book", "Open library");
const settingsLink = navLink({ name: "settings" }, "gear", "Open settings");
const commandButton = el(
  "button",
  {
    className: "icon-button",
    attrs: {
      type: "button",
      "aria-label": "Open command palette",
      title: "Commands (Ctrl or Command + K)",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
    },
  },
  iconSpan("command")
);
const nav = el(
  "nav",
  { className: "app-nav", attrs: { "aria-label": "Primary navigation" } },
  libraryLink,
  settingsLink,
  commandButton
);
const header = el("header", { className: "app-header" }, brandGroup, nav);
const main = el("main", {
  className: "app-main",
  attrs: { id: "main-content", tabindex: "-1" },
});

app.replaceChildren(header, main, fileInput);

let activeScreen: ScreenHandle | undefined;
let routeGeneration = 0;
let stopRouting: (() => void) | undefined;
let bootGeneration = 0;
let palette: ModalHandle | undefined;

function isEpub(file: File): boolean {
  return file.name.toLowerCase().endsWith(".epub") || file.type === "application/epub+zip";
}

function importFile(file: File): void {
  if (!isEpub(file)) {
    showToast("Please choose an EPUB file.", "warning");
    return;
  }
  closePalette();
  startImportFlow(file);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) importFile(file);
});

function closePalette(): void {
  const open = palette;
  if (!open) return;
  palette = undefined;
  commandButton.setAttribute("aria-expanded", "false");
  open.close();
}

function commandCatalog(): Command[] {
  const commands: Command[] = [
    {
      id: "library",
      label: "Go to library",
      hint: "navigation",
      icon: "book",
      keywords: "home books",
      run: () => navigate({ name: "library" }),
    },
    {
      id: "import",
      label: "Import an EPUB",
      hint: "local file",
      icon: "upload",
      keywords: "add open book file",
      run: () => fileInput.click(),
    },
    {
      id: "settings",
      label: "Open settings",
      hint: "navigation",
      icon: "gear",
      keywords: "preferences options",
      run: () => navigate({ name: "settings" }),
    },
  ];

  for (const name of themeNames) {
    commands.push({
      id: `theme:${name}`,
      label: `Theme: ${name.replaceAll("_", " ")}`,
      hint: name === getAppState().settings.theme ? "current" : "appearance",
      icon: "check",
      keywords: `color appearance ${name}`,
      run: () => getAppState().updateSettings({ theme: name }),
    });
  }
  return commands;
}

function openCommandPalette(): void {
  if (palette) {
    closePalette();
    return;
  }

  const allCommands = commandCatalog();
  let visibleCommands: Command[] = [];
  let selected = 0;
  const search = el("input", {
    attrs: {
      type: "search",
      role: "combobox",
      placeholder: "Type a command or theme…",
      "aria-label": "Search commands",
      "aria-controls": "command-list",
      "aria-autocomplete": "list",
      "aria-expanded": "true",
      autocomplete: "off",
      spellcheck: "false",
    },
  }) as HTMLInputElement;
  const list = el("div", {
    className: "command-list ffscroll",
    attrs: { id: "command-list", role: "listbox", "aria-label": "Commands" },
  });
  const searchRow = el("div", { className: "command-search" }, iconSpan("search"), search);

  function matches(command: Command, query: string): boolean {
    const haystack = `${command.label} ${command.keywords ?? ""}`.toLowerCase().replaceAll("_", " ");
    return query.split(/\s+/).every((part) => haystack.includes(part));
  }

  function run(command: Command): void {
    closePalette();
    Promise.resolve(command.run()).catch((error: unknown) => {
      console.error("Command failed", error);
      showToast("That command couldn't be completed.", "error");
    });
  }

  function renderCommands(): void {
    const query = search.value.trim().toLowerCase().replaceAll("_", " ");
    const matchesQuery = allCommands.filter((command) => matches(command, query));
    // Keep the idle palette compact. Theme search still covers every palette.
    const currentThemeId = `theme:${getAppState().settings.theme}`;
    visibleCommands = (
      query
        ? matchesQuery
        : matchesQuery.filter(
            (command) => !command.id.startsWith("theme:") || command.id === currentThemeId
          )
    ).slice(0, 40);
    selected = Math.min(selected, Math.max(0, visibleCommands.length - 1));
    clear(list);

    if (visibleCommands.length === 0) {
      search.removeAttribute("aria-activedescendant");
      list.appendChild(el("div", { className: "command-empty" }, "No matching commands"));
      return;
    }

    visibleCommands.forEach((command, index) => {
      const optionId = `command-${index}`;
      const option = el(
        "button",
        {
          className: `command-item${index === selected ? " active" : ""}`,
          attrs: {
            id: optionId,
            type: "button",
            role: "option",
            "aria-selected": index === selected ? "true" : "false",
          },
          on: {
            click: () => run(command),
            mouseenter: () => {
              updateSelection(index);
            },
          },
        },
        iconSpan(command.icon),
        el("span", { className: "command-label" }, command.label),
        command.hint ? el("span", { className: "command-hint" }, command.hint) : null
      );
      list.appendChild(option);
    });
    search.setAttribute("aria-activedescendant", `command-${selected}`);
  }

  function updateSelection(index: number): void {
    selected = index;
    list.querySelectorAll<HTMLElement>(".command-item").forEach((item, itemIndex) => {
      const isSelected = itemIndex === selected;
      item.classList.toggle("active", isSelected);
      item.setAttribute("aria-selected", String(isSelected));
    });
    search.setAttribute("aria-activedescendant", `command-${selected}`);
  }

  search.addEventListener("input", () => {
    selected = 0;
    renderCommands();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && visibleCommands.length > 0) {
      event.preventDefault();
      updateSelection((selected + 1) % visibleCommands.length);
      list.querySelector<HTMLElement>(".command-item.active")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp" && visibleCommands.length > 0) {
      event.preventDefault();
      updateSelection((selected - 1 + visibleCommands.length) % visibleCommands.length);
      list.querySelector<HTMLElement>(".command-item.active")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      const command = visibleCommands[selected];
      if (command) {
        event.preventDefault();
        run(command);
      }
    }
  });

  renderCommands();
  const handle = openModal({
    content: [searchRow, list],
    className: "command-palette-wrapper",
    onClose: () => {
      if (palette === handle) palette = undefined;
      commandButton.setAttribute("aria-expanded", "false");
    },
  });
  handle.root.id = "commandPalette";
  palette = handle;
  commandButton.setAttribute("aria-expanded", "true");
  search.focus();
}

commandButton.addEventListener("click", openCommandPalette);

function keyboardShortcut(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette();
  }
}
document.addEventListener("keydown", keyboardShortcut);

let dragDepth = 0;
let dropOverlay: HTMLElement | undefined;

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function showDropOverlay(): void {
  if (dropOverlay) return;
  dropOverlay = el(
    "div",
    { className: "drop-overlay", attrs: { role: "status", "aria-live": "polite" } },
    iconSpan("upload"),
    "drop your EPUB to import"
  );
  document.body.appendChild(dropOverlay);
}

function hideDropOverlay(): void {
  dragDepth = 0;
  dropOverlay?.remove();
  dropOverlay = undefined;
}

window.addEventListener("dragenter", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDropOverlay();
});
window.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!dropOverlay) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDropOverlay();
});
window.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  hideDropOverlay();
  const epub = files.find(isEpub);
  if (epub) importFile(epub);
  else showToast("Drop an .epub file to import it.", "warning");
});
window.addEventListener("blur", hideDropOverlay);

function setRouteChrome(route: Route): void {
  const inReader = route.name === "reader";
  header.hidden = inReader;
  app.style.gridTemplateRows = inReader ? "1fr" : "";
  if (route.name === "library") libraryLink.setAttribute("aria-current", "page");
  else libraryLink.removeAttribute("aria-current");
  if (route.name === "settings") settingsLink.setAttribute("aria-current", "page");
  else settingsLink.removeAttribute("aria-current");
  document.title = route.name === "settings" ? "Settings — Scriptorium" : "Scriptorium";
}

function mountRoute(route: Route): ScreenHandle | Promise<ScreenHandle> {
  switch (route.name) {
    case "library":
      return mountLibrary(main);
    case "import":
      return mountImport(main);
    case "settings":
      return mountSettings(main);
    case "reader":
      return mountReader(main, route.bookId);
  }
}

async function renderRoute(route: Route): Promise<void> {
  const generation = ++routeGeneration;
  closePalette();
  activeScreen?.unmount?.();
  activeScreen = undefined;
  setRouteChrome(route);
  main.setAttribute("aria-busy", "true");

  try {
    const mounted = await mountRoute(route);
    if (generation !== routeGeneration) {
      mounted.unmount?.();
      return;
    }
    activeScreen = mounted;
    main.removeAttribute("aria-busy");
  } catch (error) {
    if (generation !== routeGeneration) return;
    console.error(`Failed to mount ${route.name} screen`, error);
    main.removeAttribute("aria-busy");
    renderScreenError(route);
  }
}

function renderScreenError(route: Route): void {
  clear(main);
  main.appendChild(
    el(
      "section",
      { className: "empty-state", attrs: { role: "alert" } },
      iconSpan("x"),
      el("h1", {}, "something went wrong"),
      el("p", {}, "This screen couldn't be opened. Your books and progress have not been changed."),
      el(
        "div",
        { className: "button-row" },
        el("button", { className: "button active", on: { click: () => void renderRoute(route) } }, "try again"),
        route.name !== "library"
          ? el("button", { className: "button", on: { click: () => navigate({ name: "library" }) } }, "library")
          : null
      )
    )
  );
}

function renderBootError(error: unknown): void {
  console.error("Failed to open Scriptorium storage", error);
  header.hidden = false;
  main.removeAttribute("aria-busy");
  clear(main);
  main.appendChild(
    el(
      "section",
      { className: "empty-state", attrs: { role: "alert" } },
      iconSpan("x"),
      el("h1", {}, "browser storage is unavailable"),
      el(
        "p",
        {},
        "Scriptorium couldn't open its local book storage. Check this site's storage permissions, then try again."
      ),
      el(
        "button",
        { className: "button active", on: { click: () => void hydrateAndStart() } },
        "try again"
      )
    )
  );
}

async function hydrateAndStart(): Promise<void> {
  const generation = ++bootGeneration;
  ++routeGeneration;
  stopRouting?.();
  stopRouting = undefined;
  activeScreen?.unmount?.();
  activeScreen = undefined;
  closePalette();
  clear(main);
  main.setAttribute("aria-busy", "true");
  main.appendChild(
    el(
      "div",
      { className: "import-progress", attrs: { role: "status" } },
      el("div", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      el("p", {}, "opening your library…")
    )
  );

  try {
    const durableSettings = await getSettings();
    if (generation !== bootGeneration) return;
    initAppState(durableSettings);
    stopRouting = onRouteChange((route) => void renderRoute(route));
    await renderRoute(currentRoute());
  } catch (error) {
    if (generation !== bootGeneration) return;
    renderBootError(error);
  }
}

void hydrateAndStart();
