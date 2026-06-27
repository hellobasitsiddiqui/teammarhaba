// Email-verification banner (TM-169) — the DOM-mounting half.
//
// An unverified signed-in user sees a dismissible "Verify your email" banner with a Resend action.
// Resend calls the backend resend-verification endpoint (POST /api/v1/me/resend-verification, TM-165,
// surfaced as resendVerification() in api.js). Once the user verifies and their Firebase token
// refreshes, onAuthChanged re-fires, we re-read GET /me, and — because visibility is driven off the
// live `accountState.emailVerified` flag (TM-164, the same flag the TM-168 badge reads) — the banner
// disappears on its own. No persisted state of our own; Firebase stays the source of truth.
//
// Scope (per TM-169): this module owns ONLY the verify banner + resend. It does not touch the badge
// (TM-168), /me's shape, or the profile page (TM-170/171) — it just reads emailVerified off /me.
//
// Theme-safe: built from ui.js's el() + theme tokens only (no hard-coded colours), so it renders
// correctly under clean / doodle / sketch. XSS-safe: only textContent, never innerHTML.

import { onAuthChanged } from "./auth.js";
import { getMe, resendVerification } from "./api.js";
import { el } from "./ui.js";
import {
  shouldShowBanner,
  resendOutcome,
  resendMessage,
  isResendDisabled,
  ResendState,
} from "./verify-banner-state.js";

const HOST_ID = "verify-banner";

// The user can dismiss the banner for the current page session. We deliberately keep this in memory
// only (not localStorage): a fresh load / new session re-nags an unverified user, but we don't pester
// them repeatedly within one visit. Cleared on sign-out so the next user starts clean.
let dismissed = false;
let lastEmail = null;

/** The banner host, created once and prepended into the app shell. Null until first mounted. */
function host() {
  if (typeof document === "undefined") return null;
  let node = document.getElementById(HOST_ID);
  if (node) return node;
  const app = document.querySelector("main.app");
  if (!app) return null;
  node = el("div", {
    id: HOST_ID,
    class: "tm-verify-banner",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });
  // Right below the title/tagline/status, above the nav — the first thing a returning user sees.
  const status = document.getElementById("status");
  if (status && status.parentNode === app) {
    status.insertAdjacentElement("afterend", node);
  } else {
    app.prepend(node);
  }
  return node;
}

/** Render the banner body for a given resend state. Rebuilt wholesale each time — it's tiny. */
function paint(state) {
  const node = host();
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);

  const message = el("span", { class: "tm-verify-banner-text", text: resendMessage(state, lastEmail) });

  const resendBtn = el("button", {
    type: "button",
    class: "tm-verify-banner-resend",
    text: state === ResendState.SENDING ? "Sending…" : "Resend",
    onClick: onResend,
  });
  resendBtn.disabled = isResendDisabled(state);

  const dismissBtn = el("button", {
    type: "button",
    class: "tm-verify-banner-dismiss",
    "aria-label": "Dismiss",
    text: "×",
    onClick: () => {
      dismissed = true;
      hide();
    },
  });

  node.appendChild(el("span", { class: "tm-verify-banner-icon", "aria-hidden": "true", text: "✉️" }));
  node.appendChild(message);
  node.appendChild(el("span", { class: "tm-verify-banner-actions" }, [resendBtn, dismissBtn]));
}

function show(state = ResendState.IDLE) {
  const node = host();
  if (!node) return;
  paint(state);
  node.hidden = false;
}

function hide() {
  const node = host();
  if (node) node.hidden = true;
}

/** Resend click: drive the friendly state machine off the endpoint's outcome (sent / rate / fail). */
async function onResend() {
  paint(ResendState.SENDING);
  let outcome;
  try {
    await resendVerification();
    outcome = resendOutcome(null);
  } catch (err) {
    outcome = resendOutcome(err);
  }
  paint(outcome);
  // If Firebase says it's already verified, the banner is stale — re-read /me to clear it.
  if (outcome === ResendState.ALREADY_VERIFIED) {
    refresh();
  }
}

/**
 * Re-read GET /me and reconcile the banner against the live emailVerified flag. Called on every auth
 * change (sign-in, token refresh after verification, sign-out) so the banner appears/clears on its own.
 * Best-effort: a failed /me read leaves the banner as-is rather than throwing.
 */
export async function refresh() {
  if (typeof document === "undefined") return;
  let me = null;
  try {
    me = await getMe();
  } catch (err) {
    // 401 already redirected (api.js); any other failure — don't nag on an unknown state.
    console.warn("[verify-banner] GET /me failed:", err?.message ?? err);
    hide();
    return;
  }
  lastEmail = me?.email ?? null;
  if (shouldShowBanner(me) && !dismissed) {
    show(ResendState.IDLE);
  } else {
    hide();
  }
}

// React to auth state. On sign-out reset the per-session dismissal so the next user is re-checked;
// otherwise re-read /me to reflect the (possibly just-verified) state.
onAuthChanged((user) => {
  if (!user) {
    dismissed = false;
    lastEmail = null;
    hide();
    return;
  }
  refresh();
});

if (typeof window !== "undefined") {
  window.tmVerifyBanner = { refresh };
}
