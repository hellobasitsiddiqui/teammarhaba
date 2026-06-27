// Account-state badges (TM-168): render the three verification/security flags from the `/me` state
// block — Email verified, Age verified, MFA on — each with a clear "not verified / off" variant,
// reusing the shared badge primitive (`.tm-badge` + `.tm-badge-ok` / `.tm-badge-off`, from TM-133).
//
// Where the flags live in the /me payload (see backend MeResponse / AccountState, TM-163/TM-164):
//   - emailVerified → `accountState.emailVerified`  (live from Firebase; may be null = unknown)
//   - ageVerified   → top-level `ageVerified`       (our DB, self-attested; always a boolean)
//   - mfaEnabled    → `accountState.mfaEnabled`     (live from Firebase; may be null = unknown)
//
// The Firebase-sourced flags are best-effort: in credential-free dev/test (and on the admin list
// projection, which doesn't carry them) they arrive as `null`/`undefined`. We treat that as a third
// "unknown" state rather than silently asserting "off", so a missing flag never mislabels an account
// as un-verified.
//
// Design mirrors the rest of the codebase: a PURE descriptor function (`accountBadgeStates`) that is
// unit-tested without a DOM, plus a thin DOM renderer (`renderAccountBadges`) built on ui.js `el`.

import { el } from "./ui.js";

/**
 * Normalise a tri-state flag from the /me payload.
 * @param {*} value the raw flag (true / false / null / undefined)
 * @returns {"on"|"off"|"unknown"}
 */
function triState(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return "unknown";
}

// The three badges, in display order. Each carries the labels for its on/off/unknown states and an
// accessible-label prefix so a screen reader announces the full meaning (e.g. "Email: verified"),
// not just the terse pill text.
const BADGES = [
  {
    key: "emailVerified",
    aria: "Email",
    labels: { on: "Email verified", off: "Email not verified", unknown: "Email status unknown" },
  },
  {
    key: "ageVerified",
    aria: "Age",
    labels: { on: "Age verified", off: "Age not verified", unknown: "Age status unknown" },
  },
  {
    key: "mfaEnabled",
    aria: "Two-factor authentication",
    labels: { on: "MFA on", off: "MFA off", unknown: "MFA status unknown" },
  },
];

/**
 * Pull the three account-state flags out of a /me-shaped object, tolerating both shapes the payload
 * uses: `emailVerified` / `mfaEnabled` nested under `accountState`, and `ageVerified` at the top
 * level. A bare flat object (e.g. an admin user projection that happens to carry the flags directly)
 * is also accepted as a fallback, so the same helper works in the admin console.
 *
 * @param {object|null|undefined} me the `/me` response (or any object carrying the flags)
 * @returns {{emailVerified: *, ageVerified: *, mfaEnabled: *}}
 */
export function extractAccountFlags(me) {
  const m = me || {};
  const state = m.accountState || {};
  return {
    emailVerified: state.emailVerified ?? m.emailVerified,
    ageVerified: m.ageVerified ?? state.ageVerified,
    mfaEnabled: state.mfaEnabled ?? m.mfaEnabled,
  };
}

/**
 * PURE: turn a /me-shaped object into ordered badge descriptors — the testable core. No DOM.
 *
 * @param {object|null|undefined} me the `/me` response
 * @param {{includeUnknown?: boolean}} [opts] when `includeUnknown` is false (the default), badges
 *     whose flag couldn't be read are omitted rather than shown as "unknown" — the right call for a
 *     compact list where a row of "unknown" pills would be noise. Pass `true` to always emit all
 *     three (the profile page does this, so the user can see what's missing).
 * @returns {Array<{key: string, state: "on"|"off"|"unknown", label: string, ariaLabel: string,
 *     variant: "ok"|"off"|"unknown"}>}
 */
export function accountBadgeStates(me, { includeUnknown = false } = {}) {
  const flags = extractAccountFlags(me);
  const out = [];
  for (const badge of BADGES) {
    const state = triState(flags[badge.key]);
    if (state === "unknown" && !includeUnknown) continue;
    const label = badge.labels[state];
    // Variant drives the CSS class: ok = green, off = red, unknown = neutral (no on/off colour).
    const variant = state === "on" ? "ok" : state === "off" ? "off" : "unknown";
    out.push({ key: badge.key, state, label, ariaLabel: `${badge.aria}: ${label}`, variant });
  }
  return out;
}

/**
 * Build a single badge node from a descriptor (the DOM half). `title` + `aria-label` carry the full
 * meaning; the visible text is the terse pill label.
 */
export function accountBadge({ label, ariaLabel, variant }) {
  const cls = variant === "unknown" ? "tm-badge tm-badge-unknown" : `tm-badge tm-badge-${variant}`;
  return el("span", { class: cls, title: ariaLabel, "aria-label": ariaLabel }, label);
}

/**
 * Render the account-state badges for a /me-shaped object as a single inline group, or `null` when
 * there's nothing to show (so callers can append the result without guarding). Pass
 * `{ includeUnknown: true }` to always render all three (profile page).
 *
 * @param {object|null|undefined} me the `/me` response (or admin user carrying the flags)
 * @param {{includeUnknown?: boolean, label?: string}} [opts]
 * @returns {HTMLElement|null}
 */
export function renderAccountBadges(me, { includeUnknown = false, label = "Account status" } = {}) {
  const descriptors = accountBadgeStates(me, { includeUnknown });
  if (!descriptors.length) return null;
  // A labelled group so assistive tech announces the cluster as "Account status" before the pills.
  return el(
    "span",
    { class: "tm-badge-group", role: "group", "aria-label": label },
    descriptors.map(accountBadge),
  );
}
