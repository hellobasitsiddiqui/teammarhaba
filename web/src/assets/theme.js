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
//   Read `window.TEAMMARHABA_CONFIG.theme`. Allowed values: "clean" | "doodle" | "sketch".
//   • unset / missing  → "sketch"  (the default — the hand-drawn wireframe product direction; TM-323)
//   • unknown value    → "sketch"  (fall back to the default; never break the page / never blank)
//   `clean`/`doodle` stay fully selectable by asking for them explicitly (config/THEME = "clean").
//   So `resolveTheme(cfg)` always returns a name that exists in the registry.
//
// ── Dev/test override (TM-216) ────────────────────────────────────────────────────────────────
//   A `?theme=clean|doodle|sketch` query param (read from location.search — it sits BEFORE the `#/...`
//   hash route, e.g. `/?theme=clean#/login`) or a `tm-theme` localStorage key force a theme at boot,
//   layered OVER the config value. Query wins over storage; only ALLOWED values are honoured, any
//   other is ignored. It's a client-side VISUAL toggle only (no behaviour change, no data), so it's
//   harmless in prod and lets you A/B a theme — and the e2e suite flip themes — without a redeploy.
//
// Classic (non-module) script, loaded right after config.js and before paint, so switching the
// family causes no flash of the wrong look (matches the build-info.js pattern). It also publishes
// `window.TeamMarhabaTheme` ({ THEMES, DEFAULT_THEME, resolveTheme, readOverride, activeTheme,
// applyTheme }) so other code and tests can reuse the contract without re-implementing it.
(function () {
  "use strict";

  // Registry of known theme names. Structured as a map so each can carry metadata later (e.g. a
  // human label, asset hints); the value is just a descriptor for now. All three families have a
  // live token block in styles.css, so any is a valid config value that renders fully.
  var THEMES = {
    clean: { label: "Clean" },
    // Now live (TM-213): the doodle token block + wobble skin exist in styles.css, so doodle is a
    // first-class registered family, not just an allowed-but-unstyled request.
    doodle: { label: "Doodle" },
    // Now the DEFAULT (TM-323): a hand-drawn pencil-sketch WIREFRAME family — grayscale "napkin
    // mockup" (sketchy ink-pencil borders/buttons, hand-lettered faces, faint ruled paper, reuses
    // the #wobble-soft skin). Its token block lives in styles.css; clean/doodle stay selectable.
    sketch: { label: "Sketch" },
  };

  // Values config is allowed to ask for (the fixed contract). Kept separate from THEMES so a theme
  // name can be a *valid request* (passes the contract) before its full registry entry/CSS exists.
  var ALLOWED = ["clean", "doodle", "sketch"];

  // The intended default (TM-323): an unconfigured deploy serves "sketch" (the hand-drawn
  // pencil-sketch WIREFRAME look — the product direction). It's also the hard fallback for an
  // unset/unknown config value — a real, registered, working theme, so the page never renders
  // blank. `clean`/`doodle` are still fully selectable by asking for them explicitly
  // (config theme / THEME repo var = "clean"|"doodle").
  var DEFAULT_THEME = "sketch";

  /** Resolve the active theme name from a config object, applying the default + fallback rules.
   *  Always returns one of ALLOWED — never throws, never returns an unknown value. */
  function resolveTheme(cfg) {
    var requested = cfg && cfg.theme;
    return ALLOWED.indexOf(requested) !== -1 ? requested : DEFAULT_THEME;
  }

  // Dev/test override (TM-216). Lets a theme be exercised without a redeploy: a `?theme=` query
  // param (read from location.search — note the app hash-routes, so the query lives BEFORE the
  // `#/...`, e.g. `/?theme=clean#/login`) or a `tm-theme` localStorage key. The query param wins
  // over localStorage; only ALLOWED values are honoured and anything else is ignored (returns
  // null → caller falls back to the configured theme). This is purely a client-side VISUAL toggle
  // layered over the config value — it changes no behaviour and ships no data, so it's harmless in
  // prod (an unconfigured deploy still serves the configured/default theme). It also lets the e2e
  // suite flip themes against a single served bundle. Best-effort: any access error (e.g. a locked
  // localStorage) is swallowed so a bad environment can never break boot.
  var OVERRIDE_STORAGE_KEY = "tm-theme";
  function readOverride() {
    try {
      var fromQuery = new URLSearchParams(window.location.search).get("theme");
      if (ALLOWED.indexOf(fromQuery) !== -1) return fromQuery;
    } catch (e) {
      /* no/locked location.search — ignore */
    }
    try {
      var fromStorage = window.localStorage.getItem(OVERRIDE_STORAGE_KEY);
      if (ALLOWED.indexOf(fromStorage) !== -1) return fromStorage;
    } catch (e) {
      /* no/locked localStorage — ignore */
    }
    return null;
  }

  /** The theme to boot with: the dev override if a valid one is present, else the configured one. */
  function activeTheme(cfg) {
    return readOverride() || resolveTheme(cfg);
  }

  /** Set the resolved theme on <html> as `data-theme`, which scopes the token contract in CSS. */
  function applyTheme(name) {
    var theme = ALLOWED.indexOf(name) !== -1 ? name : DEFAULT_THEME;
    document.documentElement.dataset.theme = theme;
    return theme;
  }

  // Boot: read config (honouring the dev override) and apply, synchronously, before the page paints.
  applyTheme(activeTheme(window.TEAMMARHABA_CONFIG));

  // Expose the contract for reuse (TM-212, e2e, future theme switchers) without re-implementation.
  window.TeamMarhabaTheme = {
    THEMES: THEMES,
    ALLOWED: ALLOWED,
    DEFAULT_THEME: DEFAULT_THEME,
    resolveTheme: resolveTheme,
    readOverride: readOverride,
    activeTheme: activeTheme,
    applyTheme: applyTheme,
  };
})();
