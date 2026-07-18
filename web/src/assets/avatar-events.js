// Avatar-change broadcast (TM-846) — the single "the user's avatar just changed" signal every
// avatar surface subscribes to, so no surface is ever repainted piecemeal (and left stale) again.
//
// WHY THIS EXISTS: the avatar upload used to hand-repaint each surface it knew about (the nav
// avatar + its own preview) and silently missed the profile identity header + strength %, which
// kept the old glyph until a full reload (the TM-846 bug). With a broadcast, a NEW avatar surface
// just subscribes here — the upload path never has to learn about it.
//
// Deliberately dependency-free (no DOM, no Firebase): subscribers read the fresh `photoURL` off
// the Firebase user themselves (it stays the single source of truth — no payload is carried), and
// having zero imports keeps this module loadable under plain `node --test` like the *-core modules.
//
// Current subscribers: nav-avatar.js (the nav chip) and profile.js (the avatar control's preview +
// the identity header / strength hub). Announcer: profile.js's upload success path.

/** The registered listeners. A Set so double-subscribing the same fn is a no-op, not a double-fire. */
const listeners = new Set();

/**
 * Subscribe to avatar changes. The callback takes no arguments — read the current `photoURL` off
 * the Firebase user (the single source of truth) when it fires.
 *
 * @param {() => void} fn called after every announced avatar change.
 * @returns {() => void} an unsubscribe function (unused by the always-on surfaces, but the standard
 *   contract for any future short-lived subscriber, e.g. a modal).
 */
export function onAvatarChangedEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Announce that the signed-in user's avatar changed (called after the upload success path has set
 * the new `photoURL` on the Firebase user, so every subscriber reads the fresh value).
 *
 * Listeners are isolated: one throwing subscriber must not stop the others repainting — an avatar
 * paint failure in one corner should never leave a DIFFERENT surface stale.
 */
export function announceAvatarChanged() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.warn("[avatar-events] a subscriber failed:", err?.message ?? err);
    }
  }
}
