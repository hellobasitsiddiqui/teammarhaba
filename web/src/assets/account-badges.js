// Account-state badges (TM-168): render the verification flags from the `/me` state block — Email
// verified, Age verified — each with a clear "not verified / off" variant, reusing the shared badge
// primitive (`.tm-badge` + `.tm-badge-ok` / `.tm-badge-off`, from TM-133).
//
// Where the flags live in the /me payload (see backend MeResponse / AccountState, TM-163/TM-164):
//   - emailVerified → `accountState.emailVerified`  (live from Firebase; may be null = unknown)
//   - ageVerified   → top-level `ageVerified`       (our DB, self-attested; always a boolean)
//
// The Firebase-sourced flags are best-effort: in credential-free dev/test (and on the admin list
// projection, which doesn't carry them) they arrive as `null`/`undefined`. Per the product owner
// (TM-911), an UNKNOWN verification status MEANS not verified, so we collapse null/undefined straight
// to the "off" / "not verified" state — never a separate "unknown" chip. A verification we can't
// confirm is, to the user, simply not verified.
//
// NOTE (TM-911): MFA is intentionally NOT surfaced here — it belongs in a dedicated security section
// (TM-912), not the profile identity header. The `accountState.mfaEnabled` data is left untouched;
// it's just no longer rendered as a header badge.
//
// Design mirrors the rest of the codebase: a PURE descriptor function (`accountBadgeStates`) that is
// unit-tested without a DOM, plus a thin DOM renderer (`renderAccountBadges`) built on ui.js `el`.

import { el } from "./ui.js";

/**
 * Normalise a verification flag from the /me payload to a two-state on/off.
 *
 * TM-911: an UNKNOWN status (null/undefined — a flag the backend couldn't read) MEANS not verified,
 * so anything that isn't an explicit `true` collapses to "off". There is no third "unknown" state.
 *
 * @param {*} value the raw flag (true / false / null / undefined)
 * @returns {"on"|"off"}
 */
function twoState(value) {
  return value === true ? "on" : "off";
}

// The badges, in display order. Each carries the labels for its on/off states and an accessible-label
// prefix so a screen reader announces the full meaning (e.g. "Email: verified"), not just the terse
// pill text. TM-911: the MFA badge was removed from this list — MFA moves to a dedicated security
// section (TM-912) and no longer belongs in the profile identity header.
const BADGES = [
  {
    key: "emailVerified",
    aria: "Email",
    labels: { on: "Email verified", off: "Email not verified" },
  },
  {
    key: "ageVerified",
    aria: "Age",
    labels: { on: "Age verified", off: "Age not verified" },
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
 * TM-911: every flag now resolves to a definite on/off (unknown collapses to "not verified"), so all
 * badges always render. The `includeUnknown` option is retained (callers still pass it) but is now a
 * no-op — there is no "unknown" state left to omit or force.
 *
 * @param {object|null|undefined} me the `/me` response
 * @param {{includeUnknown?: boolean}} [opts] retained for call-site compatibility; no longer changes
 *     the output (kept so profile.js / admin callers don't need to change).
 * @returns {Array<{key: string, state: "on"|"off", label: string, ariaLabel: string,
 *     variant: "ok"|"off"}>}
 */
export function accountBadgeStates(me, { includeUnknown = false } = {}) {
  void includeUnknown; // TM-911: no-op — unknown now maps to off, so nothing is ever omitted.
  const flags = extractAccountFlags(me);
  const out = [];
  for (const badge of BADGES) {
    const state = twoState(flags[badge.key]);
    const label = badge.labels[state];
    // Variant drives the CSS class: ok = green, off = red.
    const variant = state === "on" ? "ok" : "off";
    out.push({ key: badge.key, state, label, ariaLabel: `${badge.aria}: ${label}`, variant });
  }
  return out;
}

/**
 * Build a single badge node from a descriptor (the DOM half). `title` + `aria-label` carry the full
 * meaning; the visible text is the terse pill label.
 */
export function accountBadge({ label, ariaLabel, variant }) {
  // variant is only ever "ok" (verified) or "off" (not verified) — TM-911 removed the "unknown" chip.
  const cls = `tm-badge tm-badge-${variant}`;
  return el("span", { class: cls, title: ariaLabel, "aria-label": ariaLabel }, label);
}

/**
 * Render the account-state badges for a /me-shaped object as a single inline group, or `null` when
 * there's nothing to show (so callers can append the result without guarding). Every readable /me
 * always yields the full set of verification badges (TM-911). `includeUnknown` is accepted for
 * call-site compatibility but no longer affects the output.
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
