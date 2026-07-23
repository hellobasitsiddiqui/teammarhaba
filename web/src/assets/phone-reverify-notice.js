// Retroactive phone re-verify GRACE notice (TM-992 — decision C = GRACE, then FORCE) — the DOM half.
//
// TM-932 hard-gated any account whose stored phone was never OTP-verified on its next entry. TM-992
// softens that to grace-then-force: BEFORE the configured deadline (or, the safe default, while none is
// set) the user isn't gated — they see THIS dismissible banner nudging them to verify by the deadline;
// only AFTER the deadline does the router (router.js) fold the re-gate back into the onboarding gate.
//
// This module owns ONLY the grace nudge. It reuses the exact pattern of the email-verify banner
// (verify-banner.js): a dismissible host mounted into the app shell, visibility driven off live state
// (GET /me + the Firebase-verified phone), rebuilt on every auth change, in-memory dismissal (a fresh
// load re-nags, but we don't pester within a visit), cleared on sign-out. Built from ui.js's el() + theme
// tokens only — XSS-safe (textContent, never innerHTML) and theme-safe (no hard-coded colours).
//
// The show/hide DECISION is the pure core (phone-reverify-core.js): we compute needsVerifiedPhone (the
// shared TM-932 rule) and feed it, the parsed config deadline, and now into phoneReverifyDecision. We
// render the banner ONLY for GRACE_NUDGE — NONE means nothing to do, and HARD_GATE is the router's job
// (the user is bounced to #/onboarding, not left on a page with a banner).

import { onAuthChanged, currentUser } from "./auth.js";
import { getMe } from "./api.js";
import { el } from "./ui.js";
import { sessionKey, isResponseCurrent } from "./session-guard-core.js";
import { needsVerifiedPhone } from "./profile-core.js";
// TM-1009: the deploy-time switch over the whole verified-phone requirement
// (config.flags.requireVerifiedPhone, shipped OFF). With the flag OFF, effectiveReverifyDecision
// collapses the decision to NONE so this banner never nags about a requirement that is switched off.
import { verifiedPhoneRequired, effectiveReverifyDecision } from "./verified-phone-flag.js";
import {
  phoneReverifyDecision,
  parseReverifyDeadline,
  reverifyNoticeText,
  ReverifyDecision,
  REVERIFY_CTA_TARGET,
  PHONE_VERIFY_REQUEST_EVENT,
} from "./phone-reverify-core.js";

const HOST_ID = "phone-reverify-notice";

// Dismissed for the current page session only (in memory, like the email-verify banner) — a fresh load
// re-nags an unverified user, but we don't pester repeatedly within one visit. Reset on sign-out.
let dismissed = false;

/** The prod-config re-verify deadline (`window.TEAMMARHABA_CONFIG.phoneReverifyDeadline`), or null. */
function deadlineConfig() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG?.phoneReverifyDeadline) || null;
}

/** The banner host, created once and mounted into the app shell (below the status line). Null off-DOM. */
function host() {
  if (typeof document === "undefined") return null;
  let node = document.getElementById(HOST_ID);
  if (node) return node;
  const app = document.querySelector("main.app");
  if (!app) return null;
  node = el("div", {
    id: HOST_ID,
    class: "tm-verify-banner tm-phone-reverify-notice",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });
  // Right below the title/tagline/status, above the nav — the same slot the email-verify banner uses.
  const status = document.getElementById("status");
  if (status && status.parentNode === app) {
    status.insertAdjacentElement("afterend", node);
  } else {
    app.prepend(node);
  }
  return node;
}

/** Render the banner body for a given (parsed) deadline. Rebuilt wholesale each time — it's tiny. */
function paint(deadline) {
  const node = host();
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);

  const message = el("span", { class: "tm-verify-banner-text", text: reverifyNoticeText(deadline) });

  // "Verify now" lands on the PROFILE and asks it to reveal the TM-1005 "Verify this number"
  // affordance (the shared REVERIFY_CTA_TARGET + PHONE_VERIFY_REQUEST_EVENT contract from
  // phone-reverify-core.js). It deliberately does NOT route to #/onboarding any more: during the grace
  // window the router still counts the account as onboarded (the verified-phone term only folds into
  // the gate on HARD_GATE), so router.js bounced an onboarded user straight off #/onboarding — the CTA
  // was a dead-end (TM-1005). The event is dispatched AFTER the hash nav so the profile's listener (or
  // its post-paint pending pickup) always runs against the destination view.
  const verifyBtn = el("button", {
    type: "button",
    class: "tm-verify-banner-resend",
    text: "Verify now",
    onClick: () => {
      hide();
      if (typeof window !== "undefined") {
        window.location.hash = REVERIFY_CTA_TARGET;
        window.dispatchEvent(new CustomEvent(PHONE_VERIFY_REQUEST_EVENT));
      }
    },
  });

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

  node.appendChild(el("span", { class: "tm-verify-banner-icon", "aria-hidden": "true", text: "📱" }));
  node.appendChild(message);
  node.appendChild(el("span", { class: "tm-verify-banner-actions" }, [verifyBtn, dismissBtn]));
}

function show(deadline) {
  const node = host();
  if (!node) return;
  paint(deadline);
  node.hidden = false;
}

function hide() {
  const node = host();
  if (node) node.hidden = true;
}

/**
 * Re-read GET /me and reconcile the notice against the live re-verify decision. Called on every auth
 * change so the banner appears/clears on its own (e.g. it disappears once the user verifies and their
 * Firebase phone links). Best-effort: a failed /me read hides the banner rather than throwing.
 */
export async function refresh() {
  if (typeof document === "undefined") return;
  // Capture who this /me is FOR — if the user signs out (or switches) while it's in flight, a late
  // response must be dropped (it would nag the previous user over the login screen). Same guard as the
  // email-verify banner (TM-720).
  const startedFor = sessionKey(currentUser());
  let me = null;
  try {
    me = await getMe();
  } catch (err) {
    console.warn("[phone-reverify-notice] GET /me failed:", err?.message ?? err);
    if (isResponseCurrent(startedFor, sessionKey(currentUser()))) hide();
    return;
  }
  // Signed out / switched user since we asked → this response is for someone else; drop it silently.
  if (!isResponseCurrent(startedFor, sessionKey(currentUser()))) return;

  // The verified phone comes from the Firebase user (NOT /me — MeResponse carries only the self-reported
  // value), pinned to the SAME session the /me was resolved for.
  const verifiedPhone = currentUser()?.phoneNumber ?? null;
  // TM-1009: with the verified-phone requirement switched OFF the decision collapses to NONE — the
  // grace nudge must not nag users to verify a number nothing requires verified. Same call-site
  // short-circuit as the router's isOnboarded fold, so banner and gate can never disagree.
  const decision = effectiveReverifyDecision(
    verifiedPhoneRequired(),
    phoneReverifyDecision({
      needsReverify: needsVerifiedPhone(me, verifiedPhone),
      deadline: parseReverifyDeadline(deadlineConfig()),
      now: Date.now(),
    }),
  );

  // Show the nudge ONLY in the grace window (and only if not dismissed this session). NONE = nothing to
  // do; HARD_GATE = the router bounces the user to #/onboarding, so a banner would be moot.
  if (decision === ReverifyDecision.GRACE_NUDGE && !dismissed) {
    show(parseReverifyDeadline(deadlineConfig()));
  } else {
    hide();
  }
}

// React to auth state. On sign-out reset the per-session dismissal so the next user is re-checked;
// otherwise re-read /me to reflect the (possibly just-verified) state.
onAuthChanged((user) => {
  if (!user) {
    dismissed = false;
    hide();
    return;
  }
  refresh();
});

if (typeof window !== "undefined") {
  window.tmPhoneReverifyNotice = { refresh };
}
