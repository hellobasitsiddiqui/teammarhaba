// First-party events-API helpers for the events e2e (TM-400).
//
// The events journey has two setup/choreography steps that have NO user-facing UI, so they can't be
// driven through the browser — they're first-party API calls, exactly like the broadcast recipients'
// pref/device seeding in global-setup.mjs:
//
//   • The ADMIN CREATES the events (POST /api/v1/admin/events — TM-392). There is no admin events web
//     form merged yet, so "admin creates (chips, image, visibility window)" is this API call. The user
//     journey (browse → RSVP → waitlist → claim) is what the browser drives.
//   • An API-only FILLER account RSVPs the capacity-1 event to fill it (so the browser user lands
//     WAITLISTED), then cancels to free the spot — the "un-RSVP promotes" trigger behind the claim.
//
// Style mirrors global-setup.provisionInBackend: mint an emulator ID token for the account, then call
// the real first-party API with it — identity is the Bearer token, never the request body. These are
// disposable, emulator-only accounts (never real users / prod data).

import { AUTH_EMULATOR_HOST, API_BASE_URL } from "./fixtures.mjs";

/** Mint an emulator ID token for an account and return its authed request headers (JSON). */
export async function authHeadersFor({ email, password }) {
  const url =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(`emulator sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const { idToken } = await res.json();
  return {
    Authorization: `Bearer ${idToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Create an event via the admin API (POST /api/v1/admin/events → 201). `headers` MUST be an ADMIN's
 * authed headers (the account carries the role=ADMIN custom claim). `overrides` merge onto a sensible
 * visible-now, booking-open draft:
 *   • startAt = now + 7 days  → far past the 60-minute booking cutoff (TM-413), so RSVP/waitlist/claim
 *     are all open;
 *   • visibility window already open (started an hour ago, ends in 30 days) → visible-now in the list;
 *   • an image (a storage-path `imagePath`, the "image" the ticket calls for) and an explicit
 *     visibility window (the "visibility window") — both round-trip on the created record;
 *   • no age band (CreateEventRequest has no age fields), so the TM-415 age gate never fires.
 * Returns the created EventResponse JSON (id, heading, capacity, imagePath, visibilityStart/End, …).
 */
export async function createEvent(headers, overrides = {}) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const draft = {
    heading: "e2e event",
    description: "An automated end-to-end test event. Come along!",
    locationText: "Marhaba Community Hall, 1 Test Street",
    city: "London",
    timezone: "Europe/London",
    startAt: iso(now + 7 * 864e5), // +7 days
    endAt: iso(now + 7 * 864e5 + 3 * 36e5), // +7 days + 3h
    visibilityStart: iso(now - 36e5), // visible since an hour ago
    visibilityEnd: iso(now + 30 * 864e5), // …until 30 days out
    imagePath: "event-images/e2e-tm400", // valid storage-path pattern; the UI renders a placeholder thumb for it
    ...overrides,
  };
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(draft),
  });
  if (res.status !== 201) {
    throw new Error(`create event failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** RSVP as the given account (POST /events/{id}/rsvp). Returns the RsvpResult JSON ({state, counts}). */
export async function apiRsvp(headers, id) {
  const res = await fetch(`${API_BASE_URL}/api/v1/events/${id}/rsvp`, { method: "POST", headers });
  if (!res.ok) {
    throw new Error(`api rsvp failed for event ${id}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Cancel an RSVP / leave the waitlist as the given account (DELETE /events/{id}/rsvp → 200 with a
 *  CancelResult body — TM-414 made leaving return the late-cancellation outcome, not 204 No Content). */
export async function apiCancelRsvp(headers, id) {
  const res = await fetch(`${API_BASE_URL}/api/v1/events/${id}/rsvp`, { method: "DELETE", headers });
  if (res.status !== 200) {
    throw new Error(`api cancel rsvp failed for event ${id}: ${res.status} ${await res.text()}`);
  }
}

/**
 * Reset an account's attendance: cancel its RSVP / waitlist place on every currently-visible event, so
 * a test starts from a clean slate. This keeps the suite IDEMPOTENT across CI retries (`retries: 1`)
 * and re-runs against a shared DB — a lingering GOING would otherwise trip the backend one-active-event
 * guard (TM-413) on the next RSVP. Best-effort: a failed list or a cancel that races a started event is
 * swallowed (the point is a clean slate, not a hard guarantee). Returns the account's authed headers.
 */
export async function resetAttendanceFor(account) {
  const headers = await authHeadersFor(account);
  const res = await fetch(`${API_BASE_URL}/api/v1/events?size=100`, { headers });
  if (!res.ok) return headers; // best-effort — a fresh CI DB is already clean
  const body = await res.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  for (const item of items) {
    if (item.myState && item.myState !== "NONE") {
      try {
        await apiCancelRsvp(headers, item.id);
      } catch {
        /* best-effort reset — ignore (e.g. an already-started event refuses the change) */
      }
    }
  }
  return headers;
}
