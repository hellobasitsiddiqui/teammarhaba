// Session-guard core (TM-720) — the pure, browser-free logic that stops one user's in-flight or
// cached state leaking onto the next user's screen on a shared device.
//
// Two web races motivate it, both cheap to reason about once the logic is pulled out of the DOM
// modules and unit-tested here (the same core/renderer split the codebase uses everywhere —
// notification-bell-core.js, verify-banner-state.js, appearance-core.js):
//
//   1. STALE /me AFTER SIGN-OUT / SWITCH. A `GET /me` fired for user A can resolve AFTER A has
//      signed out (or B has signed in). Applying that response then re-shows A's email banner over
//      the login screen (verify-banner.js) or repaints A's accent + rewrites the boot hint that
//      sign-out just cleared (appearance-sync.js). The guard: capture "who am I for" when the request
//      STARTS, and drop the response if the active user is no longer that same user when it RESOLVES.
//
//   2. CACHE SURVIVES SIGN-OUT. A module-level cache keyed to the signed-in user (events.js's
//      listing cache) survives a sign-out, so the next user's derivation can read the previous
//      user's state. The rule is trivial (a sign-out is any auth change to a null user) but naming
//      it keeps the DOM modules declarative and testable.
//
// Zero DOM/Firebase deps, so it runs under `node --test web/tools/*.test.mjs` (the CI web gate).

/**
 * A stable identity token for the *active* auth user — the value the stale-response guard compares.
 * A Firebase auth callback passes the `User` (with `.uid`) or `null` when signed out; we reduce it
 * to a plain string uid (or null). Tolerant of a bare uid string / an already-null value so callers
 * that only hold `currentUser()?.uid` can pass it straight through.
 * @param {{uid?: string}|string|null|undefined} userOrUid a Firebase User, a bare uid, or null.
 * @returns {?string} the uid, or null when signed out / unknown.
 */
export function sessionKey(userOrUid) {
  if (userOrUid == null) return null;
  if (typeof userOrUid === "string") return userOrUid || null;
  if (typeof userOrUid === "object" && typeof userOrUid.uid === "string") return userOrUid.uid || null;
  return null;
}

/**
 * Is a response captured for session `startedFor` still safe to apply, given the session that is
 * active `now`? Safe ONLY when a user is still signed in AND it's the SAME user the request was
 * started for. A response is dropped when:
 *   • the user has since signed out       (now === null)               — the classic "banner over login"
 *   • a different user has signed in       (now !== startedFor)         — the "cross-user leak"
 *   • the request was started signed-out   (startedFor == null)         — never apply an anonymous /me
 *
 * @param {?string} startedFor the sessionKey captured when the request STARTED.
 * @param {?string} now        the sessionKey of the CURRENTLY active user (at resolve time).
 * @returns {boolean} true iff the response is for the still-active user and should be applied.
 */
export function isResponseCurrent(startedFor, now) {
  if (startedFor == null || now == null) return false;
  return startedFor === now;
}

/**
 * Does this auth change represent a SIGN-OUT (or a switch away from a user)? True whenever there is
 * no active user — the single condition every "clear the previous user's state" reset keys off
 * (clear the events cache, close the notification panel, wipe the foreground-push inbox…).
 * @param {{uid?: string}|string|null|undefined} userOrUid the auth callback's user (or null).
 * @returns {boolean}
 */
export function isSignedOut(userOrUid) {
  return sessionKey(userOrUid) == null;
}
