import {
  DEFAULT_SETTINGS,
  LESSON_LENGTH_STEP,
  MAX_LESSON_LENGTH,
  MIN_LESSON_LENGTH,
  normalizeLessonLength,
  type Settings,
  type SyncPayload,
} from "../types";
import { listBooks } from "../store/books";
import { listProgress, saveProgress } from "../store/progress";
import { mergeSettings } from "../store/settings";
import { formatBytes, getStorageUsage } from "../store/storage-usage";
import {
  buildSyncPayload,
  downloadSyncPayload,
  mergeSyncPayload,
  parseSyncPayloadFile,
} from "../store/sync";
import { themeNames, themes } from "../themes";
import { clear, el } from "./dom";
import { iconSpan } from "./icons";
import { navigate } from "./router";
import { getAppState } from "./state";
import { showToast } from "./toast";

export type ScreenHandle = { unmount?: () => void };

const FONT_FAMILIES = [
  "Roboto Mono",
  "JetBrains Mono",
  "IBM Plex Mono",
  "Source Code Pro",
  "Fira Code",
  "Cascadia Code",
  "SF Mono",
  "Menlo",
  "Consolas",
] as const;

function displayThemeName(name: string): string {
  return name.replaceAll("_", " ");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeImportedSettings(value: unknown): Settings {
  const candidate = value && typeof value === "object" ? value as Partial<Settings> : {};
  const merged = mergeSettings(candidate);
  const caretStyles: Settings["caretStyle"][] = ["line", "block", "underline", "off"];
  const errorModes: Settings["stopOnError"][] = ["off", "letter", "word"];
  const fontSize = typeof merged.fontSize === "number" && Number.isFinite(merged.fontSize)
    ? Math.min(3, Math.max(0.8, Math.round(merged.fontSize * 10) / 10))
    : DEFAULT_SETTINGS.fontSize;
  const contextLines = typeof merged.contextLines === "number" && Number.isFinite(merged.contextLines)
    ? Math.min(8, Math.max(2, Math.round(merged.contextLines)))
    : DEFAULT_SETTINGS.contextLines;

  return {
    theme: typeof merged.theme === "string" && themes[merged.theme] ? merged.theme : DEFAULT_SETTINGS.theme,
    fontFamily:
      typeof merged.fontFamily === "string" && merged.fontFamily.trim().length > 0 && merged.fontFamily.length <= 100
        ? merged.fontFamily.trim()
        : DEFAULT_SETTINGS.fontFamily,
    fontSize,
    caretStyle: caretStyles.includes(merged.caretStyle) ? merged.caretStyle : DEFAULT_SETTINGS.caretStyle,
    smoothCaret: typeof merged.smoothCaret === "boolean" ? merged.smoothCaret : DEFAULT_SETTINGS.smoothCaret,
    stopOnError: errorModes.includes(merged.stopOnError) ? merged.stopOnError : DEFAULT_SETTINGS.stopOnError,
    foldAccents: typeof merged.foldAccents === "boolean" ? merged.foldAccents : DEFAULT_SETTINGS.foldAccents,
    soundOnClick: typeof merged.soundOnClick === "boolean" ? merged.soundOnClick : DEFAULT_SETTINGS.soundOnClick,
    showLiveWpm: typeof merged.showLiveWpm === "boolean" ? merged.showLiveWpm : DEFAULT_SETTINGS.showLiveWpm,
    contextLines,
    lessonLength: normalizeLessonLength(merged.lessonLength),
  };
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  return el(
    "div",
    { className: "field" },
    el("div", { className: "field-label" }, label),
    control,
    help ? el("div", { className: "field-sub" }, help) : null
  );
}

function checkboxField(opts: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): { root: HTMLElement; input: HTMLInputElement } {
  const input = el("input", {
    attrs: { type: "checkbox" },
    checked: opts.checked,
    on: { change: () => opts.onChange(input.checked) },
  }) as HTMLInputElement;
  const root = el(
    "div",
    { className: "field" },
    el("label", { className: "checkbox" }, input, el("span", {}, opts.label)),
    el("div", { className: "field-sub" }, opts.help)
  );
  return { root, input };
}

async function buildLocalPayload(): Promise<SyncPayload> {
  const [books, records] = await Promise.all([listBooks(), listProgress()]);
  const progress = Object.fromEntries(records.map((record) => [record.bookId, record]));
  const knownBooks = Object.fromEntries(
    books.map((book) => [book.id, { title: book.title, author: book.author }])
  );
  return buildSyncPayload({ progress, knownBooks, settings: getAppState().settings });
}

/**
 * Apply a user-selected inbound payload. Progress retains the store's normal
 * per-book merge semantics. Settings intentionally come from the inbound
 * payload: the local store does not track a settings-updated timestamp, and a
 * snapshot built immediately before importing would otherwise always appear
 * newer and make settings import a silent no-op.
 */
async function applyInboundPayload(remote: SyncPayload): Promise<number> {
  const local = await buildLocalPayload();
  const merged = mergeSyncPayload(local, remote);
  await Promise.all(Object.values(merged.progress).map((record) => saveProgress(record)));
  await getAppState().updateSettings(normalizeImportedSettings(remote.settings));
  return Object.keys(merged.progress).length;
}

export function mountSettings(container: HTMLElement): ScreenHandle {
  clear(container);
  let cancelled = false;
  const appState = getAppState();

  const screen = el("div", { className: "settings-screen" });
  const heading = el("h1", {}, "settings");
  const backButton = el(
    "button",
    {
      className: "button text",
      attrs: { type: "button" },
      on: { click: () => navigate({ name: "library" }) },
    },
    iconSpan("arrowLeft"),
    "library"
  );
  screen.appendChild(el("div", { className: "library-toolbar" }, heading, backButton));

  const savePatch = (patch: Partial<Settings>): void => {
    void appState.updateSettings(patch).catch((error: unknown) => {
      console.error("Failed to save settings", error);
      if (!cancelled) showToast("Couldn't save that setting.", "error");
    });
  };

  // Appearance -----------------------------------------------------------
  const fontSelect = el("select", {
    attrs: { "aria-label": "Reader font family" },
    on: { change: () => savePatch({ fontFamily: fontSelect.value }) },
  }) as HTMLSelectElement;
  const fontOptions = new Set<string>(FONT_FAMILIES);
  fontOptions.add(appState.settings.fontFamily);
  for (const fontName of fontOptions) {
    fontSelect.appendChild(el("option", { value: fontName }, fontName));
  }
  fontSelect.value = appState.settings.fontFamily;

  const fontSizeValue = el("span", {}, `${appState.settings.fontSize.toFixed(1)} rem`);
  const fontSizeInput = el("input", {
    attrs: {
      type: "range",
      min: "0.8",
      max: "3",
      step: "0.1",
      value: String(appState.settings.fontSize),
      "aria-label": "Reader font size",
    },
    on: {
      input: () => {
        const value = Number(fontSizeInput.value);
        fontSizeValue.textContent = `${value.toFixed(1)} rem`;
        savePatch({ fontSize: value });
      },
    },
  }) as HTMLInputElement;

  const appearanceGrid = el(
    "div",
    { className: "settings-grid" },
    field("reader font", fontSelect, "Uses the installed font when available, then a monospace fallback."),
    field("font size", el("div", { className: "field" }, fontSizeInput, fontSizeValue))
  );

  const themeSelect = el("select", {
    attrs: { "aria-label": "Theme" },
    on: { change: () => savePatch({ theme: themeSelect.value }) },
  }) as HTMLSelectElement;
  for (const name of themeNames) {
    themeSelect.appendChild(el("option", { value: name }, displayThemeName(name)));
  }
  themeSelect.value = appState.settings.theme;
  const themePreview = el("span", { className: "swatches", attrs: { "aria-hidden": "true" } });

  function renderThemePreview(name: string): void {
    const palette = themes[name];
    clear(themePreview);
    if (!palette) return;
    themePreview.append(
      el("span", { className: "swatch", attrs: { style: `background:${palette.bg}` } }),
      el("span", { className: "swatch", attrs: { style: `background:${palette.main}` } }),
      el("span", { className: "swatch", attrs: { style: `background:${palette.text}` } })
    );
  }
  renderThemePreview(appState.settings.theme);
  const appearanceSection = el(
    "section",
    { className: "settings-section", attrs: { "aria-labelledby": "settings-appearance" } },
    el("h2", { attrs: { id: "settings-appearance" } }, "appearance"),
    appearanceGrid,
    field("theme", el("div", { className: "field theme-select-field" }, themeSelect, themePreview))
  );

  // Typing behaviour -----------------------------------------------------
  const caretButtons = new Map<Settings["caretStyle"], HTMLButtonElement>();
  const caretControl = el("div", { className: "segmented", attrs: { role: "group", "aria-label": "Caret style" } });
  const caretChoices: Array<[Settings["caretStyle"], string]> = [
    ["line", "line"],
    ["block", "block"],
    ["underline", "underline"],
    ["off", "off"],
  ];
  for (const [value, label] of caretChoices) {
    const button = el("button", {
      className: appState.settings.caretStyle === value ? "active" : "",
      text: label,
      attrs: {
        type: "button",
        "aria-pressed": String(appState.settings.caretStyle === value),
      },
      on: {
        click: () => {
          savePatch({ caretStyle: value });
          for (const [candidate, candidateButton] of caretButtons) {
            const active = candidate === value;
            candidateButton.classList.toggle("active", active);
            candidateButton.setAttribute("aria-pressed", String(active));
          }
        },
      },
    }) as HTMLButtonElement;
    caretButtons.set(value, button);
    caretControl.appendChild(button);
  }

  const errorSelect = el("select", {
    attrs: { "aria-label": "Stop on error behavior" },
    on: { change: () => savePatch({ stopOnError: errorSelect.value as Settings["stopOnError"] }) },
  }) as HTMLSelectElement;
  errorSelect.append(
    el("option", { value: "off" }, "keep typing"),
    el("option", { value: "letter" }, "stop on letter"),
    el("option", { value: "word" }, "stop on word")
  );
  errorSelect.value = appState.settings.stopOnError;

  const lessonLengthValue = el("span", {}, `${appState.settings.lessonLength} chars`);
  const lessonLengthInput = el("input", {
    attrs: {
      type: "range",
      min: String(MIN_LESSON_LENGTH),
      max: String(MAX_LESSON_LENGTH),
      step: String(LESSON_LENGTH_STEP),
      value: String(appState.settings.lessonLength),
      "aria-label": "Lesson length",
    },
    on: {
      input: () => {
        const value = normalizeLessonLength(Number.parseInt(lessonLengthInput.value, 10));
        lessonLengthValue.textContent = `${value} chars`;
        savePatch({ lessonLength: value });
      },
    },
  }) as HTMLInputElement;

  const smoothCaret = checkboxField({
    label: "smooth caret",
    help: "Animate the caret between characters.",
    checked: appState.settings.smoothCaret,
    onChange: (checked) => savePatch({ smoothCaret: checked }),
  });
  const foldAccents = checkboxField({
    label: "fold accents on import",
    help: "Convert accented Latin letters to their keyboard-friendly forms in newly imported books.",
    checked: appState.settings.foldAccents,
    onChange: (checked) => savePatch({ foldAccents: checked }),
  });
  const soundOnClick = checkboxField({
    label: "keypress sound",
    help: "Play a short click while typing.",
    checked: appState.settings.soundOnClick,
    onChange: (checked) => savePatch({ soundOnClick: checked }),
  });
  const showLiveWpm = checkboxField({
    label: "live wpm",
    help: "Show your current speed while a session is active.",
    checked: appState.settings.showLiveWpm,
    onChange: (checked) => savePatch({ showLiveWpm: checked }),
  });

  const typingSection = el(
    "section",
    { className: "settings-section", attrs: { "aria-labelledby": "settings-typing" } },
    el("h2", { attrs: { id: "settings-typing" } }, "typing"),
    el(
      "div",
      { className: "settings-grid" },
      field(
        "lesson length",
        el("div", { className: "field" }, lessonLengthInput, lessonLengthValue),
        "Target characters; lessons finish at a nearby word, sentence, or source line."
      ),
      field("caret", caretControl),
      field("errors", errorSelect, "Choose whether a wrong letter or word blocks progress."),
      smoothCaret.root,
      foldAccents.root,
      soundOnClick.root,
      showLiveWpm.root
    )
  );

  // Local storage and file sync -----------------------------------------
  const storageText = el("div", { className: "storage-text" }, "Checking browser storage…");
  const storageFill = el("div", { className: "storage-bar-fill", attrs: { style: "width:0%" } });
  const storageBar = el(
    "div",
    { className: "storage-bar", attrs: { role: "meter", "aria-label": "Browser storage used" } },
    storageFill
  );
  void getStorageUsage().then((usage) => {
    if (cancelled) return;
    if (!usage) {
      storageText.textContent = "Storage estimate isn't available in this browser.";
      storageBar.removeAttribute("role");
      return;
    }
    if (usage.quotaBytes > 0) {
      storageText.textContent = `${formatBytes(usage.usageBytes)} used of ${formatBytes(usage.quotaBytes)} available to this browser`;
    } else {
      storageText.textContent = `${formatBytes(usage.usageBytes)} used; browser quota unavailable`;
    }
    if (usage.percent !== undefined) {
      const percent = Math.min(100, Math.max(0, usage.percent));
      storageFill.setAttribute("style", `width:${percent}%`);
      storageBar.setAttribute("aria-valuemin", "0");
      storageBar.setAttribute("aria-valuemax", "100");
      storageBar.setAttribute("aria-valuenow", percent.toFixed(1));
    }
  });

  const fileStatus = el("div", {
    className: "sync-status",
    attrs: { role: "status", "aria-live": "polite" },
  }, "Settings, progress, and titles only. Never book text.");
  const syncFileInput = el("input", {
    className: "visually-hidden",
    attrs: {
      type: "file",
      accept: ".json,application/json",
      hidden: true,
      tabindex: "-1",
      "aria-hidden": "true",
    },
  }) as HTMLInputElement;
  const exportButton = el("button", { className: "button", attrs: { type: "button" } }, iconSpan("upload"), "export JSON") as HTMLButtonElement;
  const importButton = el("button", { className: "button", attrs: { type: "button" } }, iconSpan("refresh"), "import JSON") as HTMLButtonElement;

  async function runFileAction(status: string, action: () => Promise<string>): Promise<void> {
    exportButton.disabled = true;
    importButton.disabled = true;
    fileStatus.textContent = status;
    fileStatus.setAttribute("role", "status");
    try {
      const success = await action();
      if (!cancelled) {
        fileStatus.textContent = success;
        showToast(success, "success");
      }
    } catch (error: unknown) {
      console.error("Manual sync failed", error);
      if (!cancelled) {
        const message = errorMessage(error, "Sync failed. Please try again.");
        fileStatus.textContent = message;
        fileStatus.setAttribute("role", "alert");
        showToast(message, "error");
      }
    } finally {
      if (!cancelled) {
        exportButton.disabled = false;
        importButton.disabled = false;
      }
    }
  }

  exportButton.addEventListener("click", () => {
    void runFileAction("Preparing a text-free sync export…", async () => {
      downloadSyncPayload(await buildLocalPayload());
      return "Sync file exported.";
    });
  });
  importButton.addEventListener("click", () => syncFileInput.click());
  syncFileInput.addEventListener("change", () => {
    const file = syncFileInput.files?.[0];
    syncFileInput.value = "";
    if (!file) return;
    void runFileAction(`Importing ${file.name}…`, async () => {
      const count = await applyInboundPayload(await parseSyncPayloadFile(file));
      return `Imported and merged progress for ${count} book${count === 1 ? "" : "s"}.`;
    });
  });

  const dataSection = el(
    "section",
    { className: "settings-section", attrs: { "aria-labelledby": "settings-data" } },
    el("h2", { attrs: { id: "settings-data" } }, "local data"),
    field("browser storage", el("div", { className: "field" }, storageBar, storageText)),
    field(
      "sync file",
      el("div", {}, el("div", { className: "button-row" }, exportButton, importButton, syncFileInput), fileStatus),
      "Import keeps the newest position and highest totals."
    )
  );

  screen.append(appearanceSection, typingSection, dataSection);
  container.appendChild(screen);

  const unsubscribe = appState.subscribe((settings) => {
    if (!Array.from(fontSelect.options).some((option) => option.value === settings.fontFamily)) {
      fontSelect.appendChild(el("option", { value: settings.fontFamily }, settings.fontFamily));
    }
    fontSelect.value = settings.fontFamily;
    fontSizeInput.value = String(settings.fontSize);
    fontSizeValue.textContent = `${settings.fontSize.toFixed(1)} rem`;
    errorSelect.value = settings.stopOnError;
    lessonLengthInput.value = String(settings.lessonLength);
    lessonLengthValue.textContent = `${settings.lessonLength} chars`;
    smoothCaret.input.checked = settings.smoothCaret;
    foldAccents.input.checked = settings.foldAccents;
    soundOnClick.input.checked = settings.soundOnClick;
    showLiveWpm.input.checked = settings.showLiveWpm;
    for (const [value, button] of caretButtons) {
      const active = value === settings.caretStyle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    themeSelect.value = settings.theme;
    renderThemePreview(settings.theme);
  });

  return {
    unmount: () => {
      cancelled = true;
      unsubscribe();
    },
  };
}
