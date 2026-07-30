// topbar-headline.js — the DOM layer for the app top-bar headline (TM-1175).
//
// The app has ONE pinned top bar (#app-topbar): a per-screen headline (left) + the notification bell
// (right), on every signed-in, un-gated surface — restoring the design-kit header (paper-home.html
// .header) that TM-1043 had reduced to a corner-only bell. This module sets the headline TEXT for the
// current route; the pure copy lives in topbar-headline-core.js and the bell/visibility rules are
// shared with the tab bar (tabbar-core.js) so all three agree on "who is signed in and where".
//
// Driven from router.render() alongside updateTabbar/updateNotificationBell — one source of truth, and
// a free refresh on every hashchange + auth change.

import { headlineFor } from "./topbar-headline-core.js";
import { activeTab, shouldShowTabbar } from "./tabbar-core.js";
import { getMe } from "./api.js";

const HEADLINE_ID = "app-topbar-headline";

// The Events headline is templated with the viewer's profile city, which only /me carries. render() is
// synchronous, so we cache the city across renders: null = not fetched yet, "" = fetched but no city.
// Cleared on sign-out so a previous account's city never bleeds into the next.
let cityCache = null;
let cityFetchInFlight = false;

function setText(text) {
  const el = document.getElementById(HEADLINE_ID);
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text; // no headline (signed-out / gated / unknown route) → collapse it entirely
}

// Best-effort /me → city; refresh the Events headline in place when it lands. Degrades to plain
// "Events" on any failure (same best-effort contract as home.js's city context line).
function ensureCity() {
  if (cityCache !== null || cityFetchInFlight) return;
  cityFetchInFlight = true;
  getMe()
    .then((me) => {
      cityCache = me && typeof me.city === "string" ? me.city : "";
    })
    .catch(() => {
      cityCache = ""; // unknown → plain "Events"
    })
    .finally(() => {
      cityFetchInFlight = false;
      // Only repaint if the user is still on the Events tab (they may have navigated away).
      if (activeTab(location.hash) === "events") {
        setText(headlineFor({ tab: "events", cityLabel: cityCache || "" }));
      }
    });
}

/**
 * Set the top-bar headline for the current router state. Mirrors updateTabbar's signature so router
 * can call it with the same object.
 */
export function updateTopbarHeadline({ signedIn, gated, route, isAdmin = false } = {}) {
  if (!signedIn) cityCache = null; // forget the previous user's city on sign-out
  if (!shouldShowTabbar({ signedIn, gated })) {
    setText(""); // signed-out / first-run gate → no header chrome, like the bell + tab bar
    return;
  }
  const tab = activeTab(route);
  const cityLabel = tab === "events" ? cityCache || "" : "";
  setText(headlineFor({ tab, cityLabel }));
  if (tab === "events" && cityCache === null) ensureCity();
}
