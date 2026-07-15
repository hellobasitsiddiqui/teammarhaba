// Pure decision for the router's admin-route guard (TM-733).
//
// The admin routes (#/admin, #/admin/events, the event/venue forms, #/admin/messages and its compose
// form) are ADMIN-only client-side gates (the backend is the real authority). The guard bounces a
// non-admin who reaches one back to Home with an "Admins only." toast.
//
// The bug this fixes: on a deep-link or a full reload straight to an admin route, the guard runs
// BEFORE the role lookup has resolved (router navigates-first, then resolves role in the background —
// TM-307). At that first pass `isAdmin` is still its fail-safe default (false), so a real admin who
// deep-linked / reloaded #/admin was ALWAYS bounced to Home with a spurious "Admins only." toast, then
// never returned even once the role resolved. Gating the bounce on `roleResolved` holds the route
// until the role is actually known: a confirmed non-admin is still bounced (with the toast); an admin
// (or the not-yet-known case) is held so the follow-up re-guard can mount the console for them.

/**
 * Should the admin-route guard bounce this caller to Home (with the "Admins only." toast)?
 *
 * Only when the caller is DEFINITELY a non-admin: the role has been resolved AND it is not admin. When
 * the role is not yet resolved (fresh deep-link / reload, background lookup still in flight) we do NOT
 * bounce — the route is held so the follow-up re-guard, run once the role resolves, makes the real
 * decision (mount the console for an admin, or bounce a confirmed non-admin then).
 *
 * @param {{ isAdmin?: boolean, roleResolved?: boolean }} state guard state
 * @returns {boolean} true → bounce to Home + toast "Admins only."; false → hold / allow
 */
export function shouldBounceNonAdmin({ isAdmin = false, roleResolved = false } = {}) {
  return roleResolved && !isAdmin;
}
