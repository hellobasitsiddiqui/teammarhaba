// Shared constants for the browser-e2e harness (TM-134). Imported by global-setup (which seeds
// these accounts into the Firebase Auth emulator) and by the specs (which sign in as them).
//
// These are DISPOSABLE emulator accounts — never real users, never prod data. The emulator is
// wiped each run, so fixed credentials are fine and keep tests readable.

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "teammarhaba";

/** Where the Firebase Auth emulator listens (browser + backend both reach it on the host). */
export const AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.E2E_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

/** Where the Firebase Storage emulator listens (browser reaches it for avatar uploads — TM-166). */
export const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.E2E_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";

/** Backend + web base URLs (host-published ports; overridable for local runs). */
export const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://127.0.0.1:8080";
export const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL || "http://127.0.0.1:8081";

/** Seeded accounts. `admin` gets the role=ADMIN custom claim; `target` is the one we disable. */
export const ADMIN = { email: "e2e-admin@teammarhaba.test", password: "e2e-admin-pw-123456" };
export const TARGET = { email: "e2e-target@teammarhaba.test", password: "e2e-target-pw-123456" };

/**
 * Broadcast-compose recipients (TM-366). The admin broadcast e2e needs MORE than the ADMIN+TARGET
 * pair: it multi-selects ≥2 push-eligible accounts AND at least one EMAIL-only opt-out, so it can
 * assert the send fans out to the opted-in users while the opt-out is skipped (TM-364).
 *
 * Each carries the `notificationPref` global-setup PATCHes onto the account and a `token` it registers
 * via POST /me/devices, so the running backend resolves a real device per push-eligible recipient:
 *   • PUSH_RECIPIENT / BOTH_RECIPIENT — opted into push (PUSH / BOTH) + a token ⇒ SENT (targeted ≥ 1).
 *   • OPTOUT_RECIPIENT — pref EMAIL (the push opt-out) + a token that must NEVER be targeted ⇒
 *     SKIPPED_OPTED_OUT. Seeding it WITH a token is deliberate: it proves the skip is by preference,
 *     not merely "no device".
 * The tokens are disposable, emulator-only fakes (never real FCM tokens) — headless CI has no FCM, so
 * the send's `delivered` is legitimately 0; this spec asserts TARGETING/skip, not device receipt.
 */
export const PUSH_RECIPIENT = {
  email: "e2e-push@teammarhaba.test",
  password: "e2e-push-pw-123456",
  notificationPref: "PUSH",
  token: "e2e-broadcast-token-push",
};
export const BOTH_RECIPIENT = {
  email: "e2e-both@teammarhaba.test",
  password: "e2e-both-pw-123456",
  notificationPref: "BOTH",
  token: "e2e-broadcast-token-both",
};
export const OPTOUT_RECIPIENT = {
  email: "e2e-optout@teammarhaba.test",
  password: "e2e-optout-pw-123456",
  notificationPref: "EMAIL",
  token: "e2e-broadcast-token-optout",
};

/** The push-recipient fixtures as one list, in a stable order (used by global-setup + the spec). */
export const BROADCAST_RECIPIENTS = [PUSH_RECIPIENT, BOTH_RECIPIENT, OPTOUT_RECIPIENT];

/**
 * Events-journey accounts (TM-400). The events e2e (events.spec.mjs) needs a small cast, all seeded
 * onboarded + terms-accepted (via global-setup's provisionInBackend, like the broadcast recipients) so
 * they land straight in the app — no first-run gate to walk:
 *   • EVENT_GOER   — the browser user for the RSVP → GOING → cancel journey.
 *   • EVENT_WAITER — the browser user for the waitlist → claim journey: RSVPs a full (capacity-1)
 *                    event so it lands WAITLISTED, then claims the spot once the offer cascade offers it.
 *   • EVENT_FILLER — an API-only user that RSVPs the capacity-1 event to FILL it (so EVENT_WAITER lands
 *                    WAITLISTED), then cancels to FREE it — the "un-RSVP promotes" trigger.
 * None carry an age: the e2e events are created with no age band (TM-415), so the age gate never fires.
 */
export const EVENT_GOER = { email: "e2e-event-goer@teammarhaba.test", password: "e2e-event-goer-pw-123456" };
export const EVENT_WAITER = { email: "e2e-event-waiter@teammarhaba.test", password: "e2e-event-waiter-pw-123456" };
export const EVENT_FILLER = { email: "e2e-event-filler@teammarhaba.test", password: "e2e-event-filler-pw-123456" };

/** The events-journey accounts as one list, in a stable order (seeded by global-setup). */
export const EVENT_ACCOUNTS = [EVENT_GOER, EVENT_WAITER, EVENT_FILLER];

/** Connection for the persisted-state assertion (same Postgres the stack uses). */
export const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "teammarhaba",
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "devpassword",
};
