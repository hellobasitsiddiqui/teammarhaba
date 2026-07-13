// Terms/privacy acceptance gate view (TM-170) — the #/terms view. A signed-in, onboarded user who
// has NOT accepted the current terms version (a brand-new user, or anyone after a version bump) is
// routed here by the guard in router.js and CANNOT enter the app until they accept. Accepting posts
// to POST /api/v1/me/accept-terms with the current version; the backend records it (TM-163) and the
// gate lifts (the guard re-checks and sends the user on to where they were headed).
//
// The decision of WHETHER to gate lives in the pure, unit-tested terms-gate.js (needsTermsAcceptance);
// this module is the UI + the accept round-trip. The current version shown/accepted comes from the
// server (MeResponse.currentTermsVersion), so the client never hard-codes its own copy and a config
// bump re-prompts everyone automatically.
//
// Reuses the TM-133 UX kit (el/clear/toast) + the onboarding-card styles (theme-safe: tokens only,
// looks right in the default sketch/doodle theme). XSS-safety is inherited from el() (textContent /
// no innerHTML seam).

import { acceptTerms, getMe, ApiError } from "./api.js";
import { currentTermsVersion } from "./terms-gate.js";
import { clear, el, toast } from "./ui.js";
import { doodle } from "./doodles.js";

// Where the "Terms" and "Privacy" links point. No standalone policy pages exist yet (TM-242), so
// both link to the in-app Help guide (a real, on-host route that needs no server rewrite and carries
// the legal/privacy content for now). Help is PUBLIC, so it stays reachable even while the gate is
// up. Swap these for dedicated /terms and /privacy pages when they land.
const TERMS_LINK = "#/help";
const PRIVACY_LINK = "#/help";

const state = {
  version: "", // the current version we'll accept, read from /me on mount
  loaded: false,
};

let shell = null; // { acceptBtn, versionLabel } once built

const $ = (id) => document.getElementById(id);

// The router supplies this when it mounts the view, so the gate can hand control back on success
// without terms.js importing the router (avoids a cycle). Defaults to a no-op until set.
let onComplete = () => {};

async function load() {
  // Best-effort: read the current version from /me. If /me fails we leave the version blank and the
  // accept button disabled (fail-safe: we never post a guessed/empty version). The guard fails open
  // on a degraded /me, so the user isn't trapped here.
  try {
    const profile = await getMe();
    state.version = currentTermsVersion(profile);
  } catch (err) {
    console.warn("[terms] GET /api/v1/me failed (no version to accept):", err?.message ?? err);
    state.version = "";
  } finally {
    state.loaded = true;
    reflectVersion();
  }
}

/** Reflect the loaded version into the label + accept-button enabled state. */
function reflectVersion() {
  if (!shell) return;
  if (state.version) {
    shell.versionLabel.textContent = `Version ${state.version}`;
    shell.versionLabel.hidden = false;
    shell.acceptBtn.disabled = false;
  } else {
    shell.versionLabel.hidden = true;
    // No version to accept (degraded /me) — keep the button disabled rather than post a blank one.
    shell.acceptBtn.disabled = true;
  }
}

async function accept() {
  if (!state.version) {
    toast("Couldn't load the current terms. Please try again.", { type: "error" });
    return;
  }
  shell.acceptBtn.disabled = true;
  const original = shell.acceptBtn.textContent;
  shell.acceptBtn.textContent = "Accepting…";
  try {
    await acceptTerms(state.version);
    toast("Thanks — you're all set.", { type: "success" });
    // The gate has lifted (server now records this version as accepted). Hand control back to the
    // guard, which re-checks gating and routes the user on to their intended route / home.
    onComplete();
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : "Couldn't record your acceptance. Please try again.";
    toast(msg, { type: "error" });
    shell.acceptBtn.disabled = false;
    shell.acceptBtn.textContent = original;
  }
}

// ---- rendering ------------------------------------------------------------------------------

function buildShell(view) {
  const versionLabel = el("p", {
    class: "tm-muted tm-terms-version",
    id: "terms-version",
    role: "status",
    hidden: true,
  });

  // Terms + Privacy links open the relevant pages. Same-origin hash routes, so no target=_blank
  // needed; they stay within the app shell and the gate is still up when the user returns.
  const links = el("p", { class: "tm-terms-links" }, [
    el("a", { href: TERMS_LINK, id: "terms-link" }, "Terms of Service"),
    " · ",
    el("a", { href: PRIVACY_LINK, id: "privacy-link" }, "Privacy Policy"),
  ]);

  const acceptBtn = el(
    "button",
    { class: "tm-btn tm-btn-primary", type: "button", id: "terms-accept", disabled: true, onClick: accept },
    "Accept and continue",
  );

  clear(view).append(
    el("div", { class: "tm-onboarding-card tm-terms-card" }, [
      el("div", { class: "tm-admin-head" }, [
        el("h2", {}, [
          doodle("host", { class: "tm-doodle-header", title: "Before you continue" }),
          "Before you continue",
        ]),
      ]),
      el("p", {
        class: "tm-muted",
        id: "terms-intro",
        text: "Please review and accept our terms and privacy policy to use Circle.",
      }),
      versionLabel,
      links,
      el("div", { class: "tm-form-actions" }, [acceptBtn]),
    ]),
  );

  shell = { acceptBtn, versionLabel };
}

// ---- mount ----------------------------------------------------------------------------------

/**
 * Called by the router when the #/terms view becomes active. Builds the shell once, reads the
 * current version from /me, and registers the `done` callback the gate invokes after a successful
 * acceptance so the router can re-evaluate gating and move the user on.
 *
 * @param {Function} [done] invoked once acceptance succeeds (router re-guards).
 */
export function enterTerms(done) {
  onComplete = typeof done === "function" ? done : () => {};
  const view = $("terms-view");
  if (!view) return;
  if (!shell) buildShell(view);
  load();
}

// Bridge for ad-hoc use / parity with the other view modules.
if (typeof window !== "undefined") {
  window.tmTerms = { enterTerms };
}
