// Paper appearance BOOT (TM-529) — replaces the retired theme.js. Classic (non-module) script that
// runs right after config.js and BEFORE the page paints, so the wavy/sketchy state and the per-user
// accent are set on <html> with no flash of the wrong look (same slot the old theme boot used).
//
// Paper is the single theme — its tokens live on :root in styles.css. The only per-user look is:
//   • data-sketchy on/off   — the wavy/sketchy wobble (default ON for a new user)
//   • --accent / --on-accent — the chosen curated swatch (default = the CSS :root teal)
//
// SOURCE OF TRUTH is the server: GET /api/v1/me returns themeAccent/themeSketchy, applied once auth
// resolves by appearance-sync.js. This boot only paints a fast, no-flash FIRST guess from a
// localStorage HINT that appearance-sync/-settings keep in step with the server. No hint (brand-new,
// signed-out, or cleared) → the default: sketchy ON + the CSS default accent. Best-effort: any
// storage/parse error is swallowed so a bad environment can never break boot (never blanks the page).
//
// It is deliberately dependency-free (can't `import` — this must run before deferred modules): the
// hint carries the already-resolved hex/onAccent, so no palette is needed here. The palette + the
// contract live in appearance-core.js (an ES module) for the modules that CAN import.
(function () {
  "use strict";

  var HINT_KEY = "tm-appearance";
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var root = document.documentElement;

  var hint = null;
  try {
    var raw = window.localStorage.getItem(HINT_KEY);
    if (raw) hint = JSON.parse(raw);
  } catch (e) {
    /* no/locked storage or malformed JSON — fall through to the defaults */
  }

  // Sketchy defaults ON (the app's character); only an explicit stored `false` turns it off.
  var sketchy = !(hint && hint.sketchy === false);
  root.setAttribute("data-sketchy", sketchy ? "on" : "off");

  // Accent: only re-point if the hint carries a valid resolved swatch colour; otherwise the CSS
  // :root default (teal) stands. Validate as a #rrggbb string so nothing untrusted reaches CSS.
  if (hint && HEX.test(hint.hex || "")) {
    root.style.setProperty("--accent", hint.hex);
    if (HEX.test(hint.onAccent || "")) {
      root.style.setProperty("--on-accent", hint.onAccent);
    }
  }
})();
