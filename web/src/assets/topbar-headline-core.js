// topbar-headline-core.js — the PURE resolver for the app top-bar headline (TM-1175).
//
// The app has ONE pinned top bar (#app-topbar, styles.css): a per-screen headline on the left +
// the notification bell on the right, on every signed-in surface (restores the design-kit header —
// paper-home.html .header — that TM-1043 had stripped to a corner-only bell). This module owns the
// single source of truth for WHAT the headline text is, keyed by the active bottom-tab id, so the
// DOM layer (topbar-headline.js) and the tests agree. No DOM, no imports — trivially unit-testable
// and safe to eval under `node --test`.
//
// Copy is Basit-approved (TM-1175):
//   home → "Complete the circle"   events → "Events · <city>" (no city → "Events")
//   chat → "Your event chats"      profile → "About you"
//   help → "Help & tips"           admin → "Admin console"
//
// The 5th tab is Help for a normal user and Admin for an admin (tabbar-core.js) — the caller passes
// whichever tab id is active, so this map covers both.

// Base headline per tab id. `events` is templated with the user's city below, so it is intentionally
// just the stem here.
export const TOPBAR_HEADLINES = Object.freeze({
  home: "Complete the circle",
  events: "Events",
  chat: "Your event chats",
  profile: "About you",
  help: "Help & tips",
  admin: "Admin console",
});

/**
 * Resolve the top-bar headline for the active tab.
 *
 * @param {object} opts
 * @param {string} [opts.tab]        the active bottom-tab id (home|events|chat|profile|help|admin),
 *                                   e.g. from tabbar-core.activeTab(route). Unknown/absent → "" so
 *                                   the caller renders no headline (signed-out / gated / boot).
 * @param {string} [opts.cityLabel]  the signed-in user's profile city (London / Milton Keynes /
 *                                   Sharjah / Karachi). Only used for the Events tab; blank → plain
 *                                   "Events".
 * @returns {string} the headline text ("" when there is no headline for this state).
 */
export function headlineFor({ tab, cityLabel } = {}) {
  const base = TOPBAR_HEADLINES[tab];
  if (!base) return "";
  if (tab === "events") {
    const city = typeof cityLabel === "string" ? cityLabel.trim() : "";
    return city ? `Events · ${city}` : "Events";
  }
  return base;
}
