// Profile screen — pure logic core (TM-514).
//
// The visual refresh of the Profile / Edit-profile / Public-profile screens to the approved paper
// wireframes (design-kit/pages/paper-profile, paper-edit-profile, paper-public-profile) keeps its
// DOM-free, framework-free rules HERE so they can be unit-tested in plain Node (`node --test`), the
// same extraction pattern as account-badges.js / tabbar-core.js / events-core.js (see
// docs/agents/conventions/AGENTIC-LESSONS "extract the pure logic to test it"). The DOM half lives in
// profile.js; the markup styling lives in styles.css.
//
// NONE of these functions touch the DOM, Firebase, or the network — they take a `/me`-shaped object
// (backend MeResponse, see web/src/api-docs/openapi.json) plus a couple of plain booleans and return
// plain data the renderer maps to elements.

// The Profile routes. `#/profile` is the Profile hub + inline edit form (kept as ONE route so the
// existing self-service edit e2e — which navigates to #/profile and expects #profile-form — stays
// green); `#/profile/public` is the additive "how others see you" public-profile preview. Both live in
// the single #profile-view container and both light the bottom-nav Profile tab (tabbar-core treats any
// `#/profile/...` sub-path as the Profile tab).
export const PROFILE_ROUTE = "#/profile";
export const PROFILE_PUBLIC_ROUTE = "#/profile/public";

/**
 * Which Profile layout a hash route wants.
 * @param {string} hash the current `window.location.hash`
 * @returns {"public"|"view"} "public" for the public-profile preview, "view" for the hub + edit form.
 */
export function profileMode(hash) {
  return hash === PROFILE_PUBLIC_ROUTE ? "public" : "view";
}

/** The email local-part (before the @), or "" — a friendly display fallback when no name is set. */
function emailLocalPart(email) {
  if (typeof email !== "string") return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** The first letter of `s` uppercased, or "" if there isn't one. */
function firstInitial(s) {
  const m = typeof s === "string" ? s.trim().match(/[A-Za-z0-9]/) : null;
  return m ? m[0].toUpperCase() : "";
}

/**
 * The identity block shown at the top of the Profile hub (paper-profile: avatar + name + "City · age").
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @returns {{ full: string, short: string, initial: string, metaLine: string,
 *   city: string, age: (number|null) }}
 *   `full` = best full name; `short` = "First L." (wireframe style) when both parts exist, else `full`;
 *   `initial` = avatar glyph (a letter, or "🙂" when nothing is known); `metaLine` = "City · age".
 */
export function identitySummary(me) {
  const m = me || {};
  const first = (m.firstName || "").trim();
  const last = (m.lastName || "").trim();
  const joined = [first, last].filter(Boolean).join(" ");
  const full = joined || (m.displayName || "").trim() || emailLocalPart(m.email) || "Your profile";
  // "First L." — the wireframe's compact identity (e.g. "Basit S."). Falls back to the full name.
  const short = first && last ? `${first} ${last[0].toUpperCase()}.` : full;
  const city = (m.city || "").trim();
  const age = Number.isFinite(m.age) && m.age > 0 ? m.age : null;
  const metaLine = [city, age != null ? String(age) : ""].filter(Boolean).join(" · ");
  return {
    full,
    short,
    // The avatar glyph is drawn from a REAL identity source (name / displayName / email), never the
    // "Your profile" placeholder — so a brand-new, empty profile shows the friendly 🙂 (matching the
    // avatar fallback in profile.js) rather than a "Y".
    initial: firstInitial(first || last || (m.displayName || "").trim() || emailLocalPart(m.email)) || "🙂",
    metaLine,
    city,
    age,
  };
}

// The fields that count toward "profile strength" (the paper-profile completeness bar) and the
// friendly label each contributes to the "what's missing" nudge. Photo is tracked separately (it's a
// Firebase photoURL, not a /me field) but counts the same. Kept declarative so the bar, the percentage
// and the nudge always agree.
const STRENGTH_FIELDS = [
  { key: "name", label: "a name" },
  { key: "city", label: "your city" },
  { key: "age", label: "your age" },
  { key: "phone", label: "a phone" },
  { key: "photo", label: "a photo" },
];

/**
 * The profile-completeness / "profile strength" model (paper-profile). Returns the percentage, the
 * filled/total counts, the ordered list of what's still missing, and a short call-to-action nudge —
 * the restyled continuation of the shipped completeness prompt (TM-514 AC: preserved + restyled).
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @param {{ hasPhoto?: boolean }} [opts] whether the Firebase user currently has a photoURL
 * @returns {{ percent: number, filled: number, total: number, missing: string[], complete: boolean,
 *   nudge: string }}
 */
export function profileStrength(me, { hasPhoto = false } = {}) {
  const m = me || {};
  const present = {
    name: Boolean((m.firstName || "").trim() || (m.lastName || "").trim() || (m.displayName || "").trim()),
    city: Boolean((m.city || "").trim()),
    age: Number.isFinite(m.age) && m.age > 0,
    phone: Boolean((m.phone || "").trim()),
    photo: Boolean(hasPhoto),
  };
  const total = STRENGTH_FIELDS.length;
  const missing = STRENGTH_FIELDS.filter((f) => !present[f.key]).map((f) => f.label);
  const filled = total - missing.length;
  const percent = Math.round((filled / total) * 100);
  const complete = missing.length === 0;
  // The nudge names at most the first two gaps so it stays a short line (e.g. "Add a photo + your city").
  const nudge = complete ? "Your profile is all set" : `Add ${missing.slice(0, 2).join(" + ")}`;
  return { percent, filled, total, missing, complete, nudge };
}

/**
 * The public-profile preview model (paper-public-profile: avatar + name + "City · joined Mon YYYY").
 * Renders how OTHERS see the signed-in user; a real other-user endpoint (`GET /users/{id}`) doesn't
 * exist yet (noted as a TM-514 follow-up), so the preview is built from the caller's own `/me`.
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @param {{ now?: Date }} [opts] injectable clock for deterministic tests
 * @returns {{ short: string, initial: string, metaLine: string, city: string, joined: string }}
 */
export function publicSummary(me, { now = new Date() } = {}) {
  const id = identitySummary(me);
  const created = me && me.accountState ? me.accountState.createdAt : null;
  const joined = formatJoined(created, now);
  const metaLine = [id.city, joined ? `joined ${joined}` : ""].filter(Boolean).join(" · ");
  return { short: id.short, initial: id.initial, metaLine, city: id.city, joined };
}

/** Format an ISO instant as "Mon YYYY" (e.g. "Jun 2026"); "" for a missing/invalid/future value. */
export function formatJoined(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${month} ${d.getFullYear()}`;
}
