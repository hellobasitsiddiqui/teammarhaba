// Language + currency preference pickers (TM-1124) — the two VISUAL-ONLY placeholder dropdowns in the
// profile Appearance/Preferences area.
//
// ⚠ DELIBERATELY INERT (see locale-currency-core.js for the full rationale): there is no i18n layer and
// payments are GBP-only, so selecting a language or currency does NOTHING functional — no translation,
// no conversion, and NO backend/API call. To keep that guarantee un-regressable this module imports
// ONLY the el() kit + the pure core — it never touches api.js — so it literally cannot make a request.
// The single side effect of a change is a localStorage write (so the pick survives reload and doesn't
// read as broken). Real wiring is deferred to TM-1104.
//
// XSS-safe by construction: every node is built with the ui.js el() kit (textContent only, no innerHTML),
// and the pickers only ever read/write an ALLOWED option id (never free text) to the DOM or storage.

import { el } from "./ui.js";
import {
  LANGUAGE_OPTIONS,
  CURRENCY_OPTIONS,
  readLanguage,
  readCurrency,
  writeLanguage,
  writeCurrency,
} from "./locale-currency-core.js";

/** localStorage, or null if it's unavailable (private mode / disabled) — never throws. */
function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Build one labelled <select> field. `options` is the [{id,label}] catalogue; `selected` is the id to
 * pre-select; `onPick` runs with the chosen id on change. Returns the .tm-form-field wrapper.
 */
function buildPicker({ id, label, hint, options, selected, onPick }) {
  const hintId = `${id}-hint`;
  const select = el(
    "select",
    { id, class: "tm-input", "aria-describedby": hintId },
    options.map((o) => el("option", { value: o.id, text: o.label, selected: o.id === selected })),
  );
  // The DOM `.value` mirrors the selected option even in engines that don't honour the `selected`
  // attribute on programmatically-built nodes — belt-and-braces so reload always reflects the store.
  select.value = selected;
  select.addEventListener("change", () => onPick(select.value));

  return el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: label }),
    select,
    el("p", { id: hintId, class: "tm-muted tm-field-hint", text: hint }),
  ]);
}

/**
 * Build the Preferences (language + currency) placeholder section. Returns the section node. Reads the
 * stored (or default) selections, renders the two dropdowns, and on any change persists the pick to
 * localStorage ONLY — no i18n, no conversion, no network.
 */
export function buildLocaleCurrencySettings() {
  const storage = safeStorage();

  const languageField = buildPicker({
    id: "pref-language",
    label: "Language",
    hint: "Coming soon — this saves your choice but the app is English-only for now.",
    options: LANGUAGE_OPTIONS,
    selected: readLanguage(storage),
    onPick: (id) => writeLanguage(storage, id),
  });

  const currencyField = buildPicker({
    id: "pref-currency",
    label: "Currency",
    hint: "Coming soon — this saves your choice but prices are shown in GBP for now.",
    options: CURRENCY_OPTIONS,
    selected: readCurrency(storage),
    onPick: (id) => writeCurrency(storage, id),
  });

  // Reuses .tm-theme-settings (the generic settings sub-section chrome — top divider + heading, shared
  // with the Appearance block) so Preferences reads as a sibling sub-section under the same panel; the
  // extra .tm-preferences hook just spaces the two stacked fields.
  return el(
    "section",
    { class: "tm-theme-settings tm-preferences", id: "preferences-settings", "aria-label": "Preferences" },
    [el("h3", { text: "Preferences" }), languageField, currencyField],
  );
}
