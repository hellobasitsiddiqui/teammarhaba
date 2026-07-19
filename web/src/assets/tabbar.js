// Bottom tab bar — DOM wiring (TM-434).
//
// The markup (`<nav id="app-tabbar">` + the four `#tab-*` links) lives in index.html; the styling +
// the mobile-only breakpoint + safe-area insets live in styles.css. This module is the thin bridge:
// router.js calls `updateTabbar()` from its render() pass (the single source of truth for
// signed-in / gated / current-route), and this reflects that onto the bar — visibility, the content
// bottom-padding, and the active-tab state. The pure rules it applies are in `tabbar-core.js`
// (unit-tested in Node); this file only touches the DOM.
//
// Why router-driven (not self-wired to hashchange/auth like notification-center.js): the tab bar's
// visibility depends on the SAME signedIn/gated/route values router already computes each render, so
// piggy-backing on render() keeps one source of truth and avoids a second, drifting state machine.

import { activeTab, shouldShowTabbar, tabsFor } from "./tabbar-core.js";

const TABBAR_ID = "app-tabbar";
const ADMIN_TAB_LINK_ID = "tab-admin";
// The Admin tab's hand-drawn cog, in the SAME stroke voice as the four static tab icons in
// index.html (viewBox 24, stroke-width 1.9, round caps, currentColor) so it reads as one family.
const ADMIN_TAB_MARKUP = `<svg class="app-tab-icon" viewBox="0 0 24 24" width="24" height="24" fill="none"
     stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true" focusable="false">
    <!-- a little hand-drawn cog — the admin console -->
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.4v2.5M12 18.1v2.5M3.4 12h2.5M18.1 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M18 6l-1.8 1.8M6 18l1.8-1.8" />
  </svg>
  <span class="app-tab-label">Admin</span>`;

// The Admin tab (TM-915) is NOT in index.html — it is injected here ONLY for a verified admin, so a
// normal user's DOM never contains any admin affordance (visibility is UX-only; the route + API stay
// server-gated, TM-133/TM-111). Built on first need and reused; idempotent under render() re-entry —
// present === false removes it (e.g. an admin signing out, or the bar going hidden on a gate).
function syncAdminTab(nav, present) {
  const existing = nav.querySelector(`#${ADMIN_TAB_LINK_ID}`);
  if (!present) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const link = document.createElement("a");
  link.id = ADMIN_TAB_LINK_ID;
  link.className = "app-tab";
  link.href = "#/admin";
  link.innerHTML = ADMIN_TAB_MARKUP;
  nav.append(link); // last slot, after Profile — keeps the locked four in place
}
// Body classes: one toggles the content bottom-padding that keeps page content clear of the fixed bar
// (only when the bar is actually shown); the other hides the bar while a text field is focused so the
// on-screen keyboard opening can't leave the fixed bar overlapping the input / causing a layout jump.
const HAS_TABBAR_CLASS = "tm-has-tabbar";
const KEYBOARD_CLASS = "tm-tabbar-kbd-open";

/** The tab bar `<nav>`, or null if the markup isn't present (defensive — never throw). */
function tabbarEl() {
  return typeof document !== "undefined" ? document.getElementById(TABBAR_ID) : null;
}

/**
 * Reflect the current (signedIn, gated, route) onto the bottom tab bar.
 *  - visibility: shown for a signed-in, un-gated user (the auth/onboarding/terms gate); the CSS
 *    breakpoint further restricts it to narrow / mobile viewports (desktop keeps the top nav). We
 *    drive visibility with the `hidden` ATTRIBUTE (like the top nav's links) because the UA
 *    `[hidden]{display:none!important}` rule must win over the media query — CSS then only *reveals*
 *    a non-hidden bar on mobile.
 *  - content padding: add the bottom-padding body class only while the bar is shown, so a signed-out
 *    or desktop layout is byte-for-byte unchanged (no phantom gap).
 *  - active tab: mark the tab matching the route with aria-current="page" + an .is-active class, and
 *    clear it from the others, so the selected tab is always in sync with the hash (incl. deep links).
 *
 * @param {{signedIn: boolean, gated: boolean, route: string, isAdmin?: boolean}} state
 */
export function updateTabbar({ signedIn, gated, route, isAdmin = false } = {}) {
  const nav = tabbarEl();
  if (!nav) return;

  const visible = shouldShowTabbar({ signedIn, gated });
  nav.hidden = !visible;

  // Admin tab (TM-915): shown only for a signed-in, un-gated admin — the SAME visibility gate as the
  // bar (`visible`), so a gated/onboarding admin doesn't get it either. Inject/remove to match, and
  // drive the grid's column count off tabsFor() so the 4-vs-5 layout has one source of truth.
  const showAdmin = visible && Boolean(isAdmin);
  syncAdminTab(nav, showAdmin);
  nav.dataset.tabs = String(tabsFor({ isAdmin: showAdmin }).length);

  // Only pad the page for the bar when it's actually shown (and only matters at the mobile
  // breakpoint, which the CSS scopes). Keeping this off the <body> when hidden means the desktop /
  // signed-out layout is unaffected.
  if (document.body) document.body.classList.toggle(HAS_TABBAR_CLASS, visible);

  const current = activeTab(route);
  for (const link of nav.querySelectorAll(".app-tab")) {
    // Each link id is `tab-<id>` (e.g. #tab-home) — derive the tab id from it.
    const id = link.id.replace(/^tab-/, "");
    const isActive = id === current;
    link.classList.toggle("is-active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// ── Keyboard-open guard (no layout jump when the on-screen keyboard opens) ───────────────────────
// A `position: fixed` bottom bar can end up overlapping a focused input when the soft keyboard
// opens (the visual viewport shrinks). We hide the bar while a TEXT-ENTRY field is focused and
// restore it on blur — so typing never fights the bar and there's no jump. Buttons/links/checkboxes
// don't open a keyboard, so they don't toggle it. Wired ONCE at module load; state lives only on the
// <body> class, so it's robust to re-entry. Best-effort + fully guarded for a non-DOM (Node) import.
const TEXT_INPUT_TYPES = new Set([
  "text", "email", "tel", "number", "search", "password", "url", "date", "datetime-local", "month",
  "time", "week",
]);

/** True when focusing `node` would raise the on-screen keyboard (a text field / textarea / editable). */
function opensKeyboard(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (node.getAttribute("type") || "text").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return node.isContentEditable === true;
}

function setKeyboardOpen(open) {
  if (document.body) document.body.classList.toggle(KEYBOARD_CLASS, open);
}

function initKeyboardGuard() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  // focusin/focusout bubble (unlike focus/blur), so a single document-level pair covers every field.
  document.addEventListener("focusin", (e) => {
    if (opensKeyboard(e.target)) setKeyboardOpen(true);
  });
  document.addEventListener("focusout", () => {
    // On blur, only clear if focus didn't move to ANOTHER text field (avoids a flicker between two
    // inputs). Checked on the next tick so document.activeElement has settled.
    setTimeout(() => {
      if (!opensKeyboard(document.activeElement)) setKeyboardOpen(false);
    }, 0);
  });
}

initKeyboardGuard();
