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
import { enterOnboarding } from "./onboarding.js";
import { enterHelp } from "./help.js";
import { enterDiagnostics } from "./diagnostics.js";
import { getMe } from "./api.js";
import { toast } from "./ui.js";

const LOGIN = "#/login";
const HOME = "#/home";
const ADMIN = "#/admin";
// Self-service edit-profile view (TM-167) — protected, available to any signed-in user.
const PROFILE = "#/profile";
// First-login profile gate (TM-250) — protected; a signed-in but not-yet-onboarded user is forced
// here and can't reach any other app view until they complete it.
const ONBOARDING = "#/onboarding";
// Static Help guide (TM-255) — PUBLIC: reachable signed-in or signed-out, so it's deliberately NOT
// in PROTECTED. The onboarding gate (below) still wins over it for a signed-in, not-yet-onboarded
// user, so the gate can't be side-stepped via #/help.
const HELP = "#/help";
// QA diagnostics view (TM-297) — GPS / FCM-token / native-plugin readouts. PROTECTED (signed-in only):
// it's a QA enabler reached from the profile/settings area, not a public page, and the push/token
// readout only makes sense for a signed-in session. It is NOT promoted in the main nav (unobtrusive).
const DIAGNOSTICS = "#/diagnostics";
const PROTECTED = new Set([HOME, ADMIN, PROFILE, ONBOARDING, DIAGNOSTICS]);

// Cached from the verified ID-token `role` claim (TM-110), refreshed on every auth change so the
// guard + nav can decide synchronously. Fails safe to false (non-admin) until resolved.
let isAdmin = false;
// Whether the signed-in caller has completed first-login onboarding (TM-250). Resolved from
// GET /api/v1/me alongside the role on each auth change, so the gate decision is synchronous in the
// guard. Fails OPEN (true = not gated) on a lookup error: a backend hiccup must never trap a user
// behind the gate with no way through — the backend is still the real authority on what they can do.
let isOnboarded = true;
// Whether the admin console is currently mounted/loaded, so we (re)load it only on entry.
let adminActive = false;
// Same idea for the edit-profile view (TM-167): (re)load it only on entry, reset on leaving.
let profileActive = false;
// Same lifecycle for the onboarding gate view (TM-250): mount once, (re)load on entry.
let onboardingActive = false;
// Same idea for the static Help view (TM-255): mount once on entry, reset on leaving.
let helpActive = false;
// Same lifecycle for the QA diagnostics view (TM-297): mount once on entry, refresh its live readouts
// each entry (handled inside enterDiagnostics), reset on leaving so a future entry re-enters.
let diagnosticsActive = false;
// Where to send a signed-out user who tried to reach a protected view, so we can return them
// after sign-in. Shared with api.js's 401 redirect (same key).
const INTENDED_KEY = "tm.intendedRoute";

const $ = (id) => document.getElementById(id);

/** Normalise the current location hash to one of our known routes. */
function currentRoute() {
  const hash = window.location.hash;
  if (hash === LOGIN || hash === HOME || hash === ADMIN || hash === PROFILE || hash === ONBOARDING || hash === HELP || hash === DIAGNOSTICS) return hash;
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
  const onboardingView = $("onboarding-view");
  const helpView = $("help-view");
  const diagnosticsView = $("diagnostics-view");
  if (loginView) loginView.hidden = route !== LOGIN;
  if (homeView) homeView.hidden = route !== HOME;
  if (adminView) adminView.hidden = route !== ADMIN;
  if (profileView) profileView.hidden = route !== PROFILE;
  if (onboardingView) onboardingView.hidden = route !== ONBOARDING;
  if (helpView) helpView.hidden = route !== HELP;
  if (diagnosticsView) diagnosticsView.hidden = route !== DIAGNOSTICS;

  // While the first-login gate is up (signed in but not onboarded — TM-250), suppress the in-app nav
  // links so the user can't side-step the gate; only the sign-out control stays (never trap a user).
  const gated = signedIn && !isOnboarded;

  // Nav reflects auth state: a sign-in link when signed out, the sign-out control when in.
  const navSignIn = $("nav-signin");
  const navSignOut = $("signout-btn");
  const navAdmin = $("nav-admin");
  const navProfile = $("nav-profile");
  if (navSignIn) navSignIn.hidden = signedIn;
  if (navSignOut) navSignOut.hidden = !signedIn;
  // The Help-page link (TM-255) is normally always shown (public, signed-in or out), but is hidden
  // while the first-login gate is up so a gated user can't side-step it via the nav (the guard also
  // bounces them back to the gate, but hiding the link keeps the gated nav clean).
  const navHelpLink = $("nav-help-link");
  if (navHelpLink) navHelpLink.hidden = gated;
  // The edit-profile link shows for any signed-in, onboarded user (TM-167; hidden while gated).
  if (navProfile) navProfile.hidden = !signedIn || gated;
  // The admin link shows only for a signed-in, onboarded ADMIN (TM-133; hidden while gated).
  if (navAdmin) navAdmin.hidden = !(signedIn && isAdmin) || gated;
  const homeAdminLink = $("home-admin-link");
  if (homeAdminLink) homeAdminLink.hidden = !(signedIn && isAdmin) || gated;
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
  // First-login profile gate (TM-250). A signed-in user who hasn't completed onboarding is forced to
  // the gate and cannot reach ANY other view until they finish it. This precedes the login-return and
  // admin checks so the gate wins over them. The gate keeps the INTENDED route untouched, so once the
  // user completes it the normal login-return logic still lands them where they were headed.
  if (signedIn && !isOnboarded && route !== ONBOARDING) {
    // Preserve a deep-linked protected target (if not already remembered) so we can return there
    // after the gate; an in-app route like #/profile shouldn't be lost behind the gate.
    if (route !== LOGIN && !sessionStorage.getItem(INTENDED_KEY)) {
      sessionStorage.setItem(INTENDED_KEY, route);
    }
    go(ONBOARDING);
    return;
  }
  // Conversely, an already-onboarded user has no business on the gate — send them on.
  if (signedIn && isOnboarded && route === ONBOARDING) {
    const intended = sessionStorage.getItem(INTENDED_KEY) || (isAdmin ? ADMIN : HOME);
    sessionStorage.removeItem(INTENDED_KEY);
    go(intended);
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
  // Same lifecycle for the edit-profile view (TM-167): mount + reload its values on entry.
  if (route === PROFILE) {
    if (!profileActive) {
      profileActive = true;
      enterProfile();
    }
  } else {
    profileActive = false;
  }
  // First-login gate view (TM-250): mount on entry, passing the `done` callback the gate invokes
  // after a successful submit. `done` flips our local onboarded flag (the server now reports it) and
  // re-guards, which moves the now-onboarded user on to their intended route / home.
  if (route === ONBOARDING) {
    if (!onboardingActive) {
      onboardingActive = true;
      enterOnboarding(onOnboardingComplete);
    }
  } else {
    onboardingActive = false;
  }
  // Static Help view (TM-255): mount its content once on entry (idempotent — there's no per-visit
  // data to load), reset on leaving so a future entry re-mounts if needed.
  if (route === HELP) {
    if (!helpActive) {
      helpActive = true;
      enterHelp();
    }
  } else {
    helpActive = false;
  }
  // QA diagnostics view (TM-297): mount on entry; enterDiagnostics() also refreshes the live push/token
  // readout each call, so re-entering picks up a token registered after the first visit. Reset on leave.
  if (route === DIAGNOSTICS) {
    if (!diagnosticsActive) {
      diagnosticsActive = true;
      enterDiagnostics();
    }
  } else {
    diagnosticsActive = false;
  }
}

/** Invoked by the onboarding gate once the user completes it (TM-250): drop the gate + re-route. */
function onOnboardingComplete() {
  isOnboarded = true;
  onboardingActive = false; // allow a future re-mount (e.g. a later sign-out → new gated user)
  guard();
}

// How long to wait for the role + onboarding lookups before we stop blocking on them. In the Android
// WebView against real Firebase, the first `getIdToken()` (token exchange) and the `GET /me` that
// follow a custom-token sign-in can hang indefinitely (no rejection, just never settling) — and an
// un-timed `await` on them was the TM-307 dead-end: navigation off `#/login` never fired because the
// promise it waited on never settled. We guard NAVIGATION-FIRST below, so this is only a backstop for
// re-guarding with fresh role/onboarding values; if it doesn't arrive in time we proceed with the
// fail-safe defaults rather than stalling the user on the login card.
const ROLE_RESOLVE_TIMEOUT_MS = 8000;

/** Resolve `promise`, or `fallback` if it neither resolves nor rejects within `ms`. Never rejects. */
function settleOrFallback(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish({ timedOut: true, value: fallback }), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        finish({ timedOut: false, value });
      })
      .catch((err) => {
        clearTimeout(timer);
        finish({ timedOut: false, error: err, value: fallback });
      });
  });
}

// Resolve the role (from the token) AND onboarding state (from GET /me) so the admin route/nav AND the
// first-login gate (TM-250) decisions use fresh values. Used for auth-state changes (sign-in/out,
// reload restore, promotion).
//
// TM-307: navigation must NOT block on these lookups. Previously this `await`ed both BEFORE the first
// guard(), so a hanging token-exchange / `GET /me` in the Android WebView left the user stranded on
// `#/login` with no error (sign-in had succeeded, but the nav never fired). We now:
//   1. guard() IMMEDIATELY with the current cached role/onboarding values, so a confirmed signed-in
//      user is navigated off `#/login` straight away (worst case: a brand-new user briefly lands on
//      `#/home` and is then moved to `#/onboarding` when /me resolves — far better than a dead-end);
//   2. resolve role + onboarding in the BACKGROUND with a timeout, then re-guard with the fresh
//      values (this is what moves a not-yet-onboarded user to the gate, or an ADMIN to the console);
//   3. surface a visible error if the lookups actually fail/time out — never a silent stall.
async function resolveRoleThenGuard() {
  const signedIn = Boolean(currentUser());
  // Signed-out: reset to safe defaults (no gate, non-admin) and skip the network calls entirely.
  if (!signedIn) {
    isAdmin = false;
    isOnboarded = true;
    guard();
    return;
  }

  // 1) NAVIGATE FIRST. Don't wait on the network — a confirmed signed-in user must leave `#/login`
  //    now, using whatever cached role/onboarding values we have (fail-safe: non-admin, not gated).
  guard();

  // 2) Resolve role + onboarding in the background, each with a timeout so a hung request can't keep
  //    us from ever applying the real values. Each fails safe independently:
  //     - role: non-admin (TM-141 — never strand a signed-in user on the login form).
  //     - onboarded: fail OPEN (true = not gated) so a /me hiccup can't trap a user behind the gate;
  //       the backend stays the real authority on what an un-onboarded account may actually do.
  const [adminOutcome, onboardedOutcome] = await Promise.all([
    settleOrFallback(getRole(), ROLE_RESOLVE_TIMEOUT_MS, "USER"),
    settleOrFallback(getMe(), ROLE_RESOLVE_TIMEOUT_MS, null),
  ]);

  // Bail if the user signed out (or switched) while the lookups were in flight — don't apply stale
  // values or re-guard for a session that no longer exists.
  if (!currentUser()) return;

  isAdmin = adminOutcome.value === "ADMIN";
  isOnboarded = onboardedOutcome.value ? Boolean(onboardedOutcome.value.onboardingCompleted) : true;

  // 3) Surface a visible signal if the onboarding/role resolution failed or timed out, so a degraded
  //    backend never looks like a silent dead-end. We've still navigated the user into the app on the
  //    fail-safe defaults (no gate, non-admin), so this is a soft warning, not a hard block.
  if (adminOutcome.timedOut || onboardedOutcome.timedOut || adminOutcome.error || onboardedOutcome.error) {
    console.warn("[router] role/onboarding lookup degraded after sign-in:", {
      roleTimedOut: Boolean(adminOutcome.timedOut),
      meTimedOut: Boolean(onboardedOutcome.timedOut),
      roleError: adminOutcome.error?.message,
      meError: onboardedOutcome.error?.message,
    });
    toast("Signed in, but we couldn't fully load your profile. Some features may be limited.", {
      type: "error",
    });
  }

  // Re-guard with the fresh values: moves a not-yet-onboarded user to the gate, an ADMIN to the
  // console, etc. By now we're already off `#/login`, so this only refines where the user landed.
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
