// Theme system core (TM-210). Lets the whole app's visual *family* be switched by config, with no
// behaviour change. This file is the boot step: it reads the active theme from runtime config and
// sets `data-theme` on <html>; the matching CSS token contract lives in styles.css.
//
// ── Two independent axes ──────────────────────────────────────────────────────────────────────
//   • dark / light  — the existing TM-133 axis, chosen by the OS via `prefers-color-scheme`.
//   • theme family   — the NEW TM-210 axis (`data-theme`), chosen by config. Today only "clean"
//                       exists and it equals the current look, so this is purely the mechanism +
//                       the default; "doodle" slots in later (TM-212 injects the real value).
// The two compose: each theme family defines its tokens for both light and dark.
//
// ── How a theme is defined ────────────────────────────────────────────────────────────────────
//   1. Add its name to THEMES below (the registry of known/allowed values).
//   2. Add a `[data-theme="<name>"]` token block in styles.css overriding the CSS custom
//      properties (colours, fonts, radii, borders, surfaces) — and its dark variant under
//      `@media (prefers-color-scheme: dark)`. "clean" inherits the base `:root` tokens, so it
//      needs no override block — it IS the current look.
//
// ── How the active theme is chosen (FIXED CONTRACT — TM-212 depends on this) ───────────────────
//   Read `window.TEAMMARHABA_CONFIG.theme`. Allowed values: "clean" | "doodle".
//   • unset / missing  → "clean"
//   • unknown value    → "clean"   (fall back; never break the page)
//   So `resolveTheme(cfg)` always returns a name that exists in the registry.
//
// Classic (non-module) script, loaded right after config.js and before paint, so switching the
// family causes no flash of the wrong look (matches the build-info.js pattern). It also publishes
// `window.TeamMarhabaTheme` ({ THEMES, DEFAULT_THEME, resolveTheme, applyTheme }) so other code and
// tests can reuse the contract without re-implementing it.
(function () {
  "use strict";

  // Registry of known theme names. Structured as a map so each can carry metadata later (e.g. a
  // human label, asset hints); the value is just a descriptor for now. "doodle" is reserved here
  // as an allowed config value so TM-212 can inject it before its CSS lands — it still resolves to
  // a known name and falls through to the base look until its token block exists.
  var THEMES = {
    clean: { label: "Clean" },
    // doodle: { label: "Doodle" }, // slots in with TM-22x; reserved as an allowed value below.
  };

  // Values config is allowed to ask for (the fixed contract). Kept separate from THEMES so a theme
  // name can be a *valid request* (passes the contract) before its full registry entry/CSS exists.
  var ALLOWED = ["clean", "doodle"];

  var DEFAULT_THEME = "clean";

  /** Resolve the active theme name from a config object, applying the default + fallback rules.
   *  Always returns one of ALLOWED — never throws, never returns an unknown value. */
  function resolveTheme(cfg) {
    var requested = cfg && cfg.theme;
    return ALLOWED.indexOf(requested) !== -1 ? requested : DEFAULT_THEME;
  }

  /** Set the resolved theme on <html> as `data-theme`, which scopes the token contract in CSS. */
  function applyTheme(name) {
    var theme = ALLOWED.indexOf(name) !== -1 ? name : DEFAULT_THEME;
    document.documentElement.dataset.theme = theme;
    return theme;
  }

  // Boot: read config and apply, synchronously, before the page paints.
  applyTheme(resolveTheme(window.TEAMMARHABA_CONFIG));

  // Expose the contract for reuse (TM-212, e2e, future theme switchers) without re-implementation.
  window.TeamMarhabaTheme = {
    THEMES: THEMES,
    ALLOWED: ALLOWED,
    DEFAULT_THEME: DEFAULT_THEME,
    resolveTheme: resolveTheme,
    applyTheme: applyTheme,
  };
})();
