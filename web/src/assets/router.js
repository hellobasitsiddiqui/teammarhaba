// Client-side auth guard + minimal hash router for the framework-free web app — TM-109 / 2.2.5.
//
// Two views, mapped onto the existing panels (TM-106):
//   #/login → the sign-in form  (#auth-signed-out) — public
//   #/home  → authenticated home (#auth-signed-in)  — protected; renders identity from
//             GET /api/v1/me (wired by me.js / TM-108)
//
// The guard is UX only — the backend is default-deny (TM-79), which is the real gate. This
// just keeps signed-out users out of protected views and returns them after they sign in.
//
// Owns view visibility (login.js no longer toggles the panels) and the nav's login↔sign-out
// control. Reacts to both `hashchange` and Firebase auth-state changes.

import { onAuthChanged, currentUser } from "./auth.js";

const LOGIN = "#/login";
const HOME = "#/home";
const PROTECTED = new Set([HOME]);
// Where to send a signed-out user who tried to reach a protected view, so we can return them
// after sign-in. Shared with api.js's 401 redirect (same key).
const INTENDED_KEY = "tm.intendedRoute";

const $ = (id) => document.getElementById(id);

/** Normalise the current location hash to one of our known routes. */
function currentRoute() {
  const hash = window.location.hash;
  if (hash === LOGIN || hash === HOME) return hash;
  // Unknown/empty hash: default by auth state.
  return currentUser() ? HOME : LOGIN;
}

/** Navigate by setting the hash (triggers the hashchange handler). */
function go(route) {
  if (window.location.hash !== route) {
    window.location.hash = route;
  } else {
    render(); // already on this hash — re-render (e.g. after auth change)
  }
}

/** Show the view for `route`, hide the other, and reflect auth state in the nav. */
function render() {
  const signedIn = Boolean(currentUser());
  const route = currentRoute();

  const loginView = $("auth-signed-out");
  const homeView = $("auth-signed-in");
  if (loginView) loginView.hidden = route !== LOGIN;
  if (homeView) homeView.hidden = route !== HOME;

  // Nav reflects auth state: a sign-in link when signed out, the sign-out control when in.
  const navSignIn = $("nav-signin");
  const navSignOut = $("signout-btn");
  if (navSignIn) navSignIn.hidden = signedIn;
  if (navSignOut) navSignOut.hidden = !signedIn;
}

/**
 * The guard: enforce the auth rules for the current (route, auth) pair, then render.
 *  - signed-out on a protected route → remember it and bounce to login.
 *  - signed-in on the login route    → return to the remembered route (or home).
 */
function guard() {
  const signedIn = Boolean(currentUser());
  const route = currentRoute();

  if (!signedIn && PROTECTED.has(route)) {
    sessionStorage.setItem(INTENDED_KEY, route);
    go(LOGIN);
    return;
  }
  if (signedIn && route === LOGIN) {
    const intended = sessionStorage.getItem(INTENDED_KEY) || HOME;
    sessionStorage.removeItem(INTENDED_KEY);
    go(intended);
    return;
  }
  render();
}

window.addEventListener("hashchange", guard);
// Auth changes (sign-in/out, reload restore) re-run the guard so views/nav follow immediately.
onAuthChanged(guard);
// Ensure there's always a route in the URL bar, then guard once on load.
if (!window.location.hash) {
  window.location.replace(`${window.location.pathname}${window.location.search}${currentUser() ? HOME : LOGIN}`);
}
guard();
