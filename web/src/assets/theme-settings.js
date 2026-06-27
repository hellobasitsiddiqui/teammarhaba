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

// Broadcast a theme change to every mounted instance of this control so their <select>s stay in sync
// (the same picker is mounted on both the Profile page and the login card — TM-332).
const THEME_EVENT = "tm-theme-changed";

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
 * contract isn't available, so the host page is never broken by a missing dependency).
 *
 * The same control is mounted in two places — the Profile page (TM-298, signed-in) and the login
 * card (TM-332, signed-out). Both can co-exist in the DOM at once (views are hidden, not removed), so
 * element ids are made unique via `idSuffix` to avoid duplicate-id collisions and keep each <label>
 * bound to its own <select>. The default (no suffix) preserves the original `theme-select`/
 * `theme-settings` ids so the existing Profile instance is byte-for-byte unchanged. There is ONE theme
 * source of truth: every instance reads/writes the same `tm-theme` key and calls the same
 * `applyTheme`, so changing the theme in either place updates both live.
 *
 * @param {{ idSuffix?: string }} [opts] `idSuffix` namespaces the section/select/hint ids (e.g. "login").
 * @returns {HTMLElement}
 */
export function buildThemeSettings({ idSuffix = "" } = {}) {
  const api = themeApi();

  const sectionId = idSuffix ? `theme-settings-${idSuffix}` : "theme-settings";
  const selectId = idSuffix ? `theme-select-${idSuffix}` : "theme-select";
  const hintId = idSuffix ? `theme-select-hint-${idSuffix}` : "theme-select-hint";

  const select = el("select", {
    id: selectId,
    class: "tm-input",
    "aria-describedby": hintId,
  });

  const section = el(
    "section",
    { class: "tm-theme-settings", id: sectionId, "aria-label": "Appearance" },
    [
      el("h3", { text: "Appearance" }),
      el("div", { class: "tm-form-field" }, [
        el("label", { class: "tm-field-label", for: selectId, text: "Theme" }),
        select,
        el("p", {
          id: hintId,
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

  // Keep this instance's <select> in sync when ANOTHER mounted instance changes the theme (the same
  // control is mounted on both Profile and login — TM-332). The change handler broadcasts THEME_EVENT;
  // every instance updates its own select so they never drift out of step. No-op for a lone instance.
  document.addEventListener(THEME_EVENT, (e) => {
    const applied = e?.detail?.theme;
    if (applied && api.ALLOWED.indexOf(applied) !== -1 && select.value !== applied) {
      select.value = applied;
    }
  });

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
    // Tell any sibling instance (e.g. the login-card picker while the profile picker is also mounted)
    // to reflect the new value, so the two pickers never show different themes.
    document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: applied } }));
    const label = (api.THEMES[applied] && api.THEMES[applied].label) || applied;
    toast(`Theme set to ${label}.`, { type: "success" });
  });

  return section;
}
