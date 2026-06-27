// In-app theme switcher UI (TM-298) — the theme picker shown on the #/profile page.
//
// Theme is otherwise config-only (config.js `theme`, default "sketch") with a dev `?theme=` URL
// override that's UNREACHABLE in the WebView app (no address bar), so mobile users had no way to
// change the look. This adds a user-facing "Appearance" section with a select letting them pick
// clean / doodle / sketch.
//
// It's a thin UI on top of the existing TM-210/TM-216 theme contract published at
// `window.TeamMarhabaTheme` (THEMES, ALLOWED, applyTheme, activeTheme + the `tm-theme` localStorage
// override key). On change we persist the chosen value to that SAME `tm-theme` key and call the
// existing `applyTheme` so it takes effect immediately, no reload — exactly the override the dev
// query param already wrote, just driven from the UI. Boot order is unchanged, so a user who never
// touches this still gets the config-driven default (an empty/locked storage simply means "no
// override" → config wins).
//
// XSS-safety is inherited from the kit: every node is built with `el()` (textContent only) — there
// is no innerHTML seam, and the only values written to storage / `data-theme` are validated against
// the theme registry's ALLOWED list, never free text.

import { el, toast } from "./ui.js";

// The same localStorage key theme.js reads as its override (OVERRIDE_STORAGE_KEY). Kept in sync by
// contract; writing here is identical to what the dev `?theme=`/`tm-theme` path already does.
const OVERRIDE_STORAGE_KEY = "tm-theme";

function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The theme contract published by theme.js (classic script, on window). Null if not loaded yet. */
function themeApi() {
  return (typeof window !== "undefined" && window.TeamMarhabaTheme) || null;
}

/** The currently active theme family, read straight off <html data-theme> (set at boot by theme.js). */
function currentTheme(api) {
  const fromDom = document.documentElement.dataset.theme;
  if (api && api.ALLOWED.indexOf(fromDom) !== -1) return fromDom;
  // Fall back to the configured/default theme if the DOM hasn't been stamped for any reason.
  return api ? api.activeTheme(window.TEAMMARHABA_CONFIG) : "sketch";
}

/**
 * Build the appearance/theme settings section element. Returns the section node (hidden if the theme
 * contract isn't available, so the profile page is never broken by a missing dependency).
 * @returns {HTMLElement}
 */
export function buildThemeSettings() {
  const api = themeApi();

  const select = el("select", {
    id: "theme-select",
    class: "tm-input",
    "aria-describedby": "theme-select-hint",
  });

  const section = el(
    "section",
    { class: "tm-theme-settings", id: "theme-settings", "aria-label": "Appearance" },
    [
      el("h3", { text: "Appearance" }),
      el("div", { class: "tm-form-field" }, [
        el("label", { class: "tm-field-label", for: "theme-select", text: "Theme" }),
        select,
        el("p", {
          id: "theme-select-hint",
          class: "tm-muted tm-field-hint",
          text: "Changes the app's look instantly. Saved on this device.",
        }),
      ]),
    ],
  );

  // No theme contract on window (shouldn't happen — theme.js loads before the app) → stay hidden
  // rather than render a broken/empty picker.
  if (!api) {
    section.hidden = true;
    return section;
  }

  // One <option> per allowed theme, labelled from the registry (THEMES[name].label), falling back to
  // the raw name. Only ALLOWED names are offered, so the value can only ever be a known-good theme.
  for (const name of api.ALLOWED) {
    const meta = api.THEMES[name];
    const label = (meta && meta.label) || name;
    select.append(el("option", { value: name, text: label }));
  }

  // Reflect the active theme as selected on load.
  select.value = currentTheme(api);

  select.addEventListener("change", () => {
    const chosen = select.value;
    // Guard: never apply/persist anything outside the registry (defence-in-depth — the options are
    // already constrained to ALLOWED).
    if (api.ALLOWED.indexOf(chosen) === -1) {
      select.value = currentTheme(api);
      return;
    }
    // Apply immediately (no reload) and persist to the existing override key so it survives a relaunch.
    const applied = api.applyTheme(chosen);
    const storage = safeStorage();
    if (storage) {
      try {
        storage.setItem(OVERRIDE_STORAGE_KEY, applied);
      } catch {
        // Locked/full storage: the theme still changed for this session; just warn it won't persist.
        toast("Theme changed, but couldn't be saved on this device.", { type: "error" });
        return;
      }
    }
    const label = (api.THEMES[applied] && api.THEMES[applied].label) || applied;
    toast(`Theme set to ${label}.`, { type: "success" });
  });

  return section;
}
