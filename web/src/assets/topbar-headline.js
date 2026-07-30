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

// The Events tab is now its OWN header (TM-1175, option A): the events browse surface no longer paints
// a city heading, so the bar must show the currently-BROWSED city — which the city-switcher changes and
// is NOT the profile city. events.js pushes it here on every (re)paint; it overrides the profile city
// for the Events headline only. null = fall back to the profile city (cityCache).
let eventsCity = null;

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
  if (!signedIn) { cityCache = null; eventsCity = null; } // forget the previous user's context on sign-out
  if (!shouldShowTabbar({ signedIn, gated })) {
    setText(""); // signed-out / first-run gate → no header chrome, like the bell + tab bar
    return;
  }
  const tab = activeTab(route);
  // Events prefers the browsed city (events.js pushes it via setTopbarEventsCity); falls back to the
  // profile city until events.js has painted.
  const cityLabel = tab === "events" ? eventsCity || cityCache || "" : "";
  setText(headlineFor({ tab, cityLabel }));
  if (tab === "events" && eventsCity === null && cityCache === null) ensureCity();
}

/**
 * Push the Events browse city into the top-bar headline. Called by events.js on every (re)paint /
 * city-switch, since the Events surface no longer paints its own city heading (TM-1175, option A).
 * `city` is the currently-browsed city ("" when none / all-cities). No-op unless Events is the active tab.
 *
 * @param {string} city the browsed city label ("" for none)
 */
export function setTopbarEventsCity(city) {
  eventsCity = typeof city === "string" ? city : "";
  if (activeTab(location.hash) === "events") {
    setText(headlineFor({ tab: "events", cityLabel: eventsCity || cityCache || "" }));
  }
}
