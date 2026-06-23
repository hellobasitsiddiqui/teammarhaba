// Client-side auth guard + minimal hash router for the framework-free web app — TM-109 / 2.2.5.
//
// Views, mapped onto page panels:
//   #/login → the sign-in form  (#auth-signed-out) — public
//   #/home  → authenticated home (#auth-signed-in)  — protected; renders identity from
//             GET /api/v1/me (wired by me.js / TM-108)
//   #/admin → admin users console (#admin-view)     — protected + ADMIN-only (TM-133)
//
// The ADMIN gate reads the verified ID-token `role` claim (TM-110); the backend (TM-111) is the
// real authority — this just hides an unusable page from non-admins.
//
// The guard is UX only — the backend is default-deny (TM-79), which is the real gate. This
// just keeps signed-out users out of protected views and returns them after they sign in.
//
// Owns view visibility (login.js no longer toggles the panels) and the nav's login↔sign-out
// control. Reacts to both `hashchange` and Firebase auth-state changes.

import { onAuthChanged, currentUser, getRole } from "./auth.js";
import { enterAdmin } from "./admin.js";
import { enterProfile } from "./profile.js";
import { toast } from "./ui.js";

const LOGIN = "#/login";
const HOME = "#/home";
const ADMIN = "#/admin";
const PROFILE = "#/profile";
const PROTECTED = new Set([HOME, ADMIN, PROFILE]);

// Cached from the verified ID-token `role` claim (TM-110), refreshed on every auth change so the
// guard + nav can decide synchronously. Fails safe to false (non-admin) until resolved.
let isAdmin = false;
// Whether the admin console is currently mounted/loaded, so we (re)load it only on entry.
let adminActive = false;
// Same, for the self-service profile view (TM-167) — (re)load /me only on entry.
let profileActive = false;
// Where to send a signed-out user who tried to reach a protected view, so we can return them
// after sign-in. Shared with api.js's 401 redirect (same key).
const INTENDED_KEY = "tm.intendedRoute";

const $ = (id) => document.getElementById(id);

/** Normalise the current location hash to one of our known routes. */
function currentRoute() {
  const hash = window.location.hash;
  if (hash === LOGIN || hash === HOME || hash === ADMIN || hash === PROFILE) return hash;
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
  const adminView = $("admin-view");
  const profileView = $("profile-view");
  if (loginView) loginView.hidden = route !== LOGIN;
  if (homeView) homeView.hidden = route !== HOME;
  if (adminView) adminView.hidden = route !== ADMIN;
  if (profileView) profileView.hidden = route !== PROFILE;

  // Nav reflects auth state: a sign-in link when signed out, the sign-out control when in.
  const navSignIn = $("nav-signin");
  const navSignOut = $("signout-btn");
  const navAdmin = $("nav-admin");
  const navProfile = $("nav-profile");
  if (navSignIn) navSignIn.hidden = signedIn;
  if (navSignOut) navSignOut.hidden = !signedIn;
  // The admin link shows only for a signed-in ADMIN (TM-133).
  if (navAdmin) navAdmin.hidden = !(signedIn && isAdmin);
  // The profile link shows for any signed-in user (TM-167).
  if (navProfile) navProfile.hidden = !signedIn;
  const homeAdminLink = $("home-admin-link");
  if (homeAdminLink) homeAdminLink.hidden = !(signedIn && isAdmin);
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
    // Land where the user was headed if they deep-linked a protected route before signing in;
    // otherwise by role — an ADMIN goes to the console, everyone else to home (TM-141).
    const intended = sessionStorage.getItem(INTENDED_KEY) || (isAdmin ? ADMIN : HOME);
    sessionStorage.removeItem(INTENDED_KEY);
    go(intended);
    return;
  }
  // Admin console is ADMIN-only (TM-133). A signed-in non-admin who reaches #/admin is sent home;
  // the backend (TM-111) is the real gate, this just avoids showing an unusable page.
  if (route === ADMIN && !isAdmin) {
    toast("Admins only.", { type: "error" });
    adminActive = false;
    go(HOME);
    return;
  }
  render();
  // Load the console on entry into the admin route (and reset on leaving so re-entry reloads).
  if (route === ADMIN && isAdmin) {
    if (!adminActive) {
      adminActive = true;
      enterAdmin();
    }
  } else {
    adminActive = false;
  }
  // Same for the profile view (TM-167): load /me on entry, reset on leaving so re-entry refreshes.
  if (route === PROFILE) {
    if (!profileActive) {
      profileActive = true;
      enterProfile();
    }
  } else {
    profileActive = false;
  }
}

// Resolve the role from the token (async) before guarding, so the admin route/nav decisions use a
// fresh `isAdmin`. Used for auth-state changes (sign-in/out, reload restore, promotion).
async function resolveRoleThenGuard() {
  // Never let a failed role lookup block the guard: if it throws we still must render, or a
  // signed-in user can be left staring at the sign-in form (TM-141). Fail safe to non-admin.
  try {
    isAdmin = (await getRole()) === "ADMIN";
  } catch {
    isAdmin = false;
  }
  guard();
}

window.addEventListener("hashchange", guard);
// Auth changes re-resolve the role then re-run the guard so views/nav follow immediately.
onAuthChanged(resolveRoleThenGuard);
// Ensure there's always a route in the URL bar, then guard once on load.
if (!window.location.hash) {
  window.location.replace(`${window.location.pathname}${window.location.search}${currentUser() ? HOME : LOGIN}`);
}
guard();
