// Responsive nav toggle (TM-229) — the hamburger that opens/closes the account nav on narrow
// screens. Framework-free, classic script (no imports), mirroring theme.js / build-info.js.
//
// On wide screens the toggle button is hidden by CSS and #nav-items is always laid out as a row,
// so this code is inert there (we still wire listeners, but the collapsed state has no visual
// effect until the nav breakpoint applies). The CSS owns *when* the collapsed layout kicks in; this
// JS only owns the open/closed state of that collapsed menu.
//
// Behaviour:
//   • Click the hamburger → toggle the menu open/closed (reflected via [data-nav-open] on the nav
//     and aria-expanded on the button — drives both the CSS reveal and a11y).
//   • Click a link/button inside the menu → close it (you navigated; don't leave the menu hanging).
//   • Click outside the nav, or press Escape → close it.
//   • Resize up to the wide layout → force it closed so a menu left open on a phone doesn't persist
//     as a weird artefact after rotating to landscape / widening.
//
// State lives only in the DOM (attributes) — no module state — so it's robust to re-entry.
(function () {
  "use strict";

  function init() {
    var nav = document.querySelector(".app-nav");
    var toggle = document.getElementById("nav-toggle");
    var items = document.getElementById("nav-items");
    if (!nav || !toggle || !items) return;

    function isOpen() {
      return nav.getAttribute("data-nav-open") === "true";
    }

    function setOpen(open) {
      nav.setAttribute("data-nav-open", open ? "true" : "false");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    setOpen(false);

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!isOpen());
    });

    // Tapping any actionable item closes the menu (you've navigated / acted).
    items.addEventListener("click", function (e) {
      var t = e.target;
      if (t && (t.closest("a") || t.closest("button"))) setOpen(false);
    });

    // Outside click closes (only meaningful while open).
    document.addEventListener("click", function (e) {
      if (isOpen() && !nav.contains(e.target)) setOpen(false);
    });

    // Escape closes and returns focus to the toggle.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    // Widening past the nav breakpoint hides the toggle (CSS) — make sure we don't keep a stale
    // open state. The breakpoint is a media query; mirror it here so JS + CSS agree.
    if (window.matchMedia) {
      var mq = window.matchMedia("(min-width: 33rem)");
      var onChange = function (ev) {
        if (ev.matches) setOpen(false);
      };
      // addEventListener is the modern API; addListener is the deprecated fallback.
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
