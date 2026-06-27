// App product tours + triggers (TM-135). Defines the whole-site walkthrough and the per-page
// tours (data-driven — adding a tour is editing this config, not the engine), and wires when they
// run: the site tour auto-starts once on first login; each page tour auto-starts once on the user's
// first visit to that page; all are replayable from the Help menu in the nav.

import { isTourActive, isTourCompleted, runTour } from "./tour.js";
import { currentUser, onAuthChanged } from "./auth.js";
import { completeOnboarding, getMe } from "./api.js";
import { el } from "./ui.js";
import { SITE_HIGHLIGHTS, PAGE_HIGHLIGHTS } from "./tour-highlights.js";

// The signed-in caller's server-side onboarding-complete flag (TM-171), the DURABLE source of truth
// for "has this user already seen the first-run tour", read from GET /me. localStorage (the tour
// engine's own seen-once state) is a per-device cache that resets when storage is cleared (private
// mode, a new device, the e2e harness), so on its own it would re-show the tour to a returning user.
// Gating the site auto-tour on this server flag — and writing it back on finish/skip — makes the
// first-run tour show exactly once per user, across devices.
//
//   null  → unknown (not resolved yet): we don't auto-run the site tour until we know, so we never
//           flash the tour at a user the server already considers onboarded.
//   true  → onboarding complete server-side: the site auto-tour is suppressed.
//   false → genuinely first-run: the site auto-tour is eligible (subject to localStorage + suppress).
let serverOnboardingCompleted = null;

/**
 * Seed the server onboarding-complete flag (TM-171) from a value the app already has — the router
 * resolves GET /me on every auth change, so it hands us `onboardingCompleted` for free rather than
 * us paying a second round trip. Re-evaluates the auto-tour with the fresh value.
 * @param {boolean|null} completed the server flag, or null to reset to "unknown".
 */
export function setOnboardingCompleted(completed) {
  serverOnboardingCompleted = completed == null ? null : Boolean(completed);
  maybeAutoTour();
}

/**
 * Resolve the server onboarding-complete flag if we don't already have it, then re-evaluate the
 * auto-tour. Best-effort: a /me failure leaves the flag unknown (no auto-tour), never throws — a
 * backend hiccup must not pop an unwanted tour nor break the page. No-op once resolved or while a
 * fetch is already in flight.
 */
let onboardingFetchInFlight = false;
async function ensureOnboardingResolved() {
  if (serverOnboardingCompleted !== null || onboardingFetchInFlight || !currentUser()) return;
  onboardingFetchInFlight = true;
  try {
    const me = await getMe();
    // Guard against a sign-out/switch mid-flight: only apply for the still-current user.
    if (currentUser()) setOnboardingCompleted(Boolean(me?.onboardingCompleted));
  } catch (err) {
    console.warn("[tours] could not resolve onboarding state (auto-tour deferred):", err?.message ?? err);
  } finally {
    onboardingFetchInFlight = false;
  }
}

/**
 * Durably mark first-run onboarding complete server-side (TM-171), invoked when the site tour is
 * finished or skipped. Best-effort and idempotent: optimistically flips our local flag so the tour
 * won't auto-run again this session even if the network is slow/offline, then POSTs
 * /me/onboarding-complete. A failure is non-fatal — the localStorage seen-once state (written by the
 * tour engine) still suppresses the tour on this device; the server write retries naturally the next
 * time the user finishes/replays. Never throws into the engine's fire-and-forget caller.
 */
function markOnboardingCompleteOnServer() {
  serverOnboardingCompleted = true;
  completeOnboarding().catch((err) => {
    console.warn("[tours] POST /me/onboarding-complete failed (will retry later):", err?.message ?? err);
  });
}

// Whole-site walkthrough — the overview, shown once on first login. Targetless steps are centered
// cards; steps whose target is hidden (e.g. the admin link for a non-admin) are skipped automatically.
// `onComplete` (TM-171) fires when the user finishes or skips the tour — marking onboarding complete
// server-side so the first-run tour is durably suppressed across devices, not just this browser.
//
// The step copy/targets are the shared highlight points (tour-highlights.js / TM-178) so the live tour
// and the static annotated help guide can't drift apart; here we only attach the tour's id + lifecycle
// hook. The highlights are a readonly source, so spread into a fresh mutable array for the engine.
const SITE_TOUR = {
  id: "site",
  onComplete: markOnboardingCompleteOnServer,
  steps: [...SITE_HIGHLIGHTS],
};

// Per-page tours, keyed by hash route — auto-started once on first visit to that page. Built from the
// same shared highlight points (tour-highlights.js / TM-178); we just stamp each route's tour id on.
const PAGE_TOURS = {
  "#/admin": { id: "admin", steps: [...PAGE_HIGHLIGHTS["#/admin"]] },
  "#/home": { id: "home", steps: [...PAGE_HIGHLIGHTS["#/home"]] },
};

const HOME_ROUTES = new Set(["", "#", "#/", "#/home"]);

// Let the target view finish rendering before a tour measures/spotlights it.
let pending;
function schedule(fn) {
  clearTimeout(pending);
  pending = setTimeout(fn, 350);
}

/**
 * Opt-in suppression of the first-run AUTO tours (the site tour + per-page tours). Off by default,
 * so production is unaffected; the e2e harness sets `suppressAutoTours: true` in the injected runtime
 * config (serve.mjs) so the seeded test accounts — which start each run with empty localStorage, i.e.
 * look "first-run" every time — don't get the tour overlay (`.tm-tour-blocker`) intercepting clicks
 * mid-flow. Replaying a tour on demand from the Help menu (`runTour(..., {force:true})`) is unaffected.
 */
function autoToursSuppressed() {
  try {
    return Boolean(window.TEAMMARHABA_CONFIG?.suppressAutoTours);
  } catch {
    return false;
  }
}

/** Decide whether to auto-run a tour for the current (route, auth) state. */
function maybeAutoTour() {
  if (autoToursSuppressed() || isTourActive() || !currentUser()) return;
  const route = window.location.hash;

  // The site tour takes priority on first login; page tours wait until it's done. It auto-runs only
  // for a genuinely first-run user — the server onboarding-complete flag (TM-171) is the durable
  // gate, with the per-device localStorage seen-once state as a fast local short-circuit:
  //   - server says already onboarded (true)  → never auto-run (even on a fresh device with empty
  //     localStorage); a returning user isn't re-toured.
  //   - server flag still unknown (null)       → defer: resolve /me, then re-evaluate. We don't run
  //     on an unknown flag, so we never flash the tour at someone the server considers onboarded.
  if (!isTourCompleted("site")) {
    if (serverOnboardingCompleted === null) {
      ensureOnboardingResolved();
      return;
    }
    if (serverOnboardingCompleted === false && HOME_ROUTES.has(route)) {
      schedule(() => runTour(SITE_TOUR));
    }
    return;
  }
  const pageTour = PAGE_TOURS[route];
  if (pageTour && !isTourCompleted(pageTour.id)) schedule(() => runTour(pageTour));
}

// --- Help menu (replay on demand) ----------------------------------------------------------

function closeHelpMenu() {
  document.getElementById("tm-help-menu")?.remove();
}

function toggleHelpMenu(button) {
  if (document.getElementById("tm-help-menu")) {
    closeHelpMenu();
    return;
  }
  const pageTour = PAGE_TOURS[window.location.hash];
  const menu = el("div", { id: "tm-help-menu", class: "tm-help-menu", role: "menu" }, [
    el(
      "button",
      {
        class: "tm-help-item",
        type: "button",
        role: "menuitem",
        onClick: () => {
          closeHelpMenu();
          runTour(SITE_TOUR, { force: true });
        },
      },
      "Take the full tour",
    ),
    pageTour
      ? el(
          "button",
          {
            class: "tm-help-item",
            type: "button",
            role: "menuitem",
            onClick: () => {
              closeHelpMenu();
              runTour(pageTour, { force: true });
            },
          },
          "Tour this page",
        )
      : null,
  ]);
  document.body.append(menu);
  const r = button.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  // Close on the next outside click.
  setTimeout(() => document.addEventListener("click", closeHelpMenu, { once: true }), 0);
}

function wireHelp() {
  const button = document.getElementById("nav-help");
  if (!button) return;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHelpMenu(button);
  });
}

// --- triggers ------------------------------------------------------------------------------

if (typeof window !== "undefined") {
  wireHelp();
  // Let the app (router) seed the resolved onboarding flag without a second /me round trip (TM-171).
  window.tmTours = { ...(window.tmTours || {}), setOnboardingCompleted };
  // The Help control is only useful (and most steps only exist) once signed in.
  onAuthChanged((user) => {
    const help = document.getElementById("nav-help");
    if (help) help.hidden = !user;
    // Reset the per-user onboarding flag to "unknown" on every auth change so one user's state never
    // leaks to the next session; it's re-seeded (router) or re-resolved (GET /me) for the new user.
    serverOnboardingCompleted = null;
    maybeAutoTour();
  });
  window.addEventListener("hashchange", maybeAutoTour);
}
