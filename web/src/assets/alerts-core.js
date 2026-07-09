// Site-wide alert banner — the pure, browser-free core (TM-243).
//
// Split out of alerts.js the same way verify-banner-state.js / splash-env.js were split out of their
// mounting modules: this is the unit-testable half — given the server's active alerts and the two
// dismissal stores, decide WHICH banners to render and record a dismissal into the RIGHT store — with
// zero DOM, fetch or timer dependencies, so `node --test web/tools/*.test.mjs` (the PR gate) can guard
// the behaviour without a browser.
//
// CONTRACT. The backend already decided "active" against the server clock, so this core never looks at
// time — it only layers the CLIENT dismissal semantics on top:
//   • ACKNOWLEDGE (sticky)   — an "OK" that persists in localStorage keyed by id + a CONTENT HASH, so
//                              it never nags again, but an EDITED alert (new hash) re-shows.
//   • DISMISS (session-only) — a "✕" that hides it for the current session (sessionStorage); it returns
//                              next session until the alert expires.
//   • PERSISTENT             — no dismiss control at all; it clears only when the server stops
//                              returning it (i.e. at expiry).
//
// A "store" here is anything with `getItem(key)` / `setItem(key, value)` — the real localStorage /
// sessionStorage in the browser, or a plain in-memory fake in tests.

/**
 * The dismissal behaviours, mirroring the backend {@code AlertDismissal} enum names exactly (the API
 * sends these strings). Frozen so a typo is a clear failure, not a silent new mode.
 * @readonly @enum {string}
 */
export const Dismissal = Object.freeze({
  ACKNOWLEDGE: "ACKNOWLEDGE",
  DISMISS: "DISMISS",
  PERSISTENT: "PERSISTENT",
});

/**
 * The severity levels, mirroring the backend {@code AlertLevel} enum names exactly. Each maps to a
 * Paper theme token via {@link levelClass}; the colour itself is never hard-coded here.
 * @readonly @enum {string}
 */
export const Level = Object.freeze({
  INFO: "INFO",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
});

/**
 * A stable, order-insensitive hash of the parts of an alert a user "acknowledged" — its level,
 * dismissal and message. Used to key the sticky (ACKNOWLEDGE) dismissal so that an operator EDITING an
 * alert (same id, new content) produces a new key and therefore RE-SHOWS to everyone, even those who
 * dismissed the previous wording. FNV-1a 32-bit rendered base36 — short, deterministic, dependency-free
 * (this is a cache key, not a security hash).
 *
 * @param {{level?: string, dismissal?: string, message?: string}} alert
 * @returns {string}
 */
export function contentHash(alert) {
  const src = `${alert?.level ?? ""}|${alert?.dismissal ?? ""}|${alert?.message ?? ""}`;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(36);
}

/** The localStorage key for a sticky (ACKNOWLEDGE) dismissal — id + content hash so edits re-show. */
export function ackKey(alert) {
  return `tm.alert.ack.${alert.id}.${contentHash(alert)}`;
}

/** The sessionStorage key for a session (DISMISS) dismissal — also content-hashed so edits re-show. */
export function sessionKey(alert) {
  return `tm.alert.session.${alert.id}.${contentHash(alert)}`;
}

/** The Paper theme modifier class for a level (drives colour via CSS token). Unknown → info (safe). */
export function levelClass(level) {
  switch (level) {
    case Level.CRITICAL:
      return "tm-alert--critical";
    case Level.WARNING:
      return "tm-alert--warning";
    case Level.INFO:
    default:
      return "tm-alert--info";
  }
}

/**
 * The ARIA role for a banner: CRITICAL is announced assertively ({@code role="alert"} interrupts the
 * screen reader), INFO/WARNING politely ({@code role="status"}). Matches the AC's a11y requirement.
 */
export function ariaRole(level) {
  return level === Level.CRITICAL ? "alert" : "status";
}

/** Whether this alert renders a dismiss control at all (PERSISTENT has none — it only auto-expires). */
export function showsDismissControl(dismissal) {
  return dismissal === Dismissal.ACKNOWLEDGE || dismissal === Dismissal.DISMISS;
}

/**
 * The label/aria-label for the dismiss control: "OK" for the sticky acknowledge, a "✕" close for the
 * session dismiss, {@code null} for PERSISTENT (no control). The visible glyph and the accessible name
 * are returned separately so the "✕" button still announces "Dismiss".
 *
 * @returns {?{text: string, ariaLabel: string}}
 */
export function dismissControl(dismissal) {
  if (dismissal === Dismissal.ACKNOWLEDGE) {
    return { text: "OK", ariaLabel: "Acknowledge and dismiss" };
  }
  if (dismissal === Dismissal.DISMISS) {
    return { text: "×", ariaLabel: "Dismiss" };
  }
  return null;
}

/**
 * Has the user already dismissed this alert (given the two stores)? ACKNOWLEDGE checks the persistent
 * localStorage key; DISMISS checks the per-session sessionStorage key; PERSISTENT is never "dismissed"
 * (it clears only at expiry, when the server stops returning it).
 *
 * @param {{id: number|string, level: string, dismissal: string, message: string}} alert
 * @param {{ackStore: {getItem: Function}, sessionStore: {getItem: Function}}} stores
 * @returns {boolean}
 */
export function isDismissed(alert, { ackStore, sessionStore }) {
  if (alert.dismissal === Dismissal.ACKNOWLEDGE) {
    return Boolean(ackStore?.getItem(ackKey(alert)));
  }
  if (alert.dismissal === Dismissal.DISMISS) {
    return Boolean(sessionStore?.getItem(sessionKey(alert)));
  }
  return false; // PERSISTENT
}

/**
 * The alerts that should actually render right now: the server's active set minus the ones this client
 * has dismissed, order preserved (the API already returns them newest-first). This is the single
 * "what does the banner host paint" decision.
 *
 * @param {Array} alerts the active alerts from GET /alerts/active.
 * @param {{ackStore: {getItem: Function}, sessionStore: {getItem: Function}}} stores
 * @returns {Array}
 */
export function visibleAlerts(alerts, stores) {
  if (!Array.isArray(alerts)) return [];
  return alerts.filter((alert) => alert && !isDismissed(alert, stores));
}

/**
 * A stable fingerprint of a *rendered* banner set — each visible alert reduced to `id + contentHash`,
 * in order. The banner host uses this to decide whether a poll actually changed anything: two ~5-min
 * polls that yield the same fingerprint are visually identical, so the host can leave the mounted DOM
 * untouched instead of clear()+rebuild. That matters for accessibility — every rebuilt `.tm-alert`
 * carries a live-region role (`role="alert"`/`aria-live`), and re-inserting that node makes screen
 * readers RE-ANNOUNCE a still-active alert; a PERSISTENT CRITICAL notice would loop assertively for its
 * whole lifetime, undercutting "announce CRITICAL once" (TM-572).
 *
 * Keyed by id + contentHash (not message alone) so the diff mirrors the dismissal keys: a new, removed
 * or EDITED alert (same id, new hash) — a real change worth re-announcing — changes the fingerprint and
 * repaints, while an unchanged set does not. Order-sensitive: a reordering is a genuine visual change.
 * The field/record separators are control chars that can't occur in an id or a base36 hash, so distinct
 * sets can never collide into the same string.
 *
 * @param {Array} visible the alerts about to be painted (already dismissal-filtered).
 * @returns {string}
 */
export function alertsSignature(visible) {
  if (!Array.isArray(visible)) return "";
  return visible.map((alert) => `${alert?.id}${contentHash(alert)}`).join("");
}

/**
 * Record a dismissal into the correct store: ACKNOWLEDGE persists to localStorage (survives sessions),
 * DISMISS to sessionStorage (this session only), PERSISTENT is a no-op (nothing to remember). Pure with
 * respect to the injected stores, so a test can assert exactly what was written where.
 *
 * @param {{id: number|string, level: string, dismissal: string, message: string}} alert
 * @param {{ackStore: {setItem: Function}, sessionStore: {setItem: Function}}} stores
 */
export function recordDismissal(alert, { ackStore, sessionStore }) {
  if (alert.dismissal === Dismissal.ACKNOWLEDGE) {
    ackStore?.setItem(ackKey(alert), "1");
  } else if (alert.dismissal === Dismissal.DISMISS) {
    sessionStore?.setItem(sessionKey(alert), "1");
  }
  // PERSISTENT: nothing to record.
}
