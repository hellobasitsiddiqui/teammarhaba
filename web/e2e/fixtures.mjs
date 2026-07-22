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

// ─── Verified-phone number allocation (TM-934) ──────────────────────────────────────────────────
//
// WHY: TM-923 makes the mandatory onboarding phone OTP-VERIFIED + UNIQUE (strict 1:1 number↔account),
// enforced two ways once TM-934's DB half lands:
//   • Firebase phone-credential linking (the emulator rejects a number already linked to another uid);
//   • the backend `users_phone_normalized_uq` partial UNIQUE index (V48) — the second live account to
//     claim the same normalized phone gets a 409.
// So the old scheme — every seeded persona + several specs PATCHing the SAME free-text `+447700900123`
// — now collides on the second account. Every persona needs its OWN fixed number, and any ephemeral
// per-run account needs a per-run-unique number.
//
// SCHEME: each of the 9 seeded personas owns one fixed number from the Ofcom "fictional" mobile block
// reserved for drama/examples — `+447700900000`–`+447700900999` (never routable, safe to hard-code).
// We allocate `+4477009001NN`, NN = 00…08, one per persona, exposed as `.phone` on the persona object.
// Specs read `persona.phone` instead of hard-coding a literal. See web/e2e/README.md for the table.
//
// EPHEMERAL accounts (specs that sign a brand-new user up per run) use {@link uniqueTestPhone} so a
// re-run against a NON-wiped emulator/Postgres never re-links a number a prior run already took.

/**
 * A per-run-unique GB E.164 phone in the Ofcom fictional block, for EPHEMERAL accounts that a spec signs
 * up fresh each run and mirrors onto users.phone directly (no browser gate walk). Derives 5 varying
 * digits from the wall clock (+ an optional worker index), so concurrent workers and re-runs against
 * persisted state never collide on a number under the strict 1:1 uniqueness rule.
 *
 * Format: `+447700` + 5 clock digits → e.g. `+447700 48213`. Its normalized (digits-only) key is 11
 * digits, whereas the fixed persona numbers `+4477009001NN` normalize to 12 digits — so a generated
 * number can NEVER equal a persona number (different digit length), independent of the clock value. Two
 * generated numbers only clash if their millisecond clocks agree modulo the window, which across a
 * single serial run never happens (the same pattern tm930-gate-phone-verify-link's uniqueGbNumber uses).
 *
 * @param {number} [workerIndex=0] Playwright's `testInfo.workerIndex` (serial today, but future-proofed).
 * @returns {string} an E.164 number, e.g. "+447700048213".
 */
export function uniqueTestPhone(workerIndex = 0) {
  // 5 varying digits: low 4 of the ms clock + a 1-digit worker lane (0–9). Padded, so always 5 digits.
  const tail = String((Date.now() % 10_000) * 10 + (workerIndex % 10)).padStart(5, "0");
  return `+447700${tail}`;
}

/**
 * Seeded accounts. `admin` gets the role=ADMIN custom claim; `target` is the one we disable.
 * Each carries its allocated verified phone (TM-934) — global-setup seeds it as a VERIFIED phone via the
 * Admin SDK (auth.updateUser), and specs that assert the stored number read `PERSONA.phone`.
 */
export const ADMIN = { email: "e2e-admin@teammarhaba.test", password: "e2e-admin-pw-123456", phone: "+447700900100" };
export const TARGET = { email: "e2e-target@teammarhaba.test", password: "e2e-target-pw-123456", phone: "+447700900101" };

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
  phone: "+447700900102", // TM-934 allocated
};
export const BOTH_RECIPIENT = {
  email: "e2e-both@teammarhaba.test",
  password: "e2e-both-pw-123456",
  notificationPref: "BOTH",
  token: "e2e-broadcast-token-both",
  phone: "+447700900103", // TM-934 allocated
};
export const OPTOUT_RECIPIENT = {
  email: "e2e-optout@teammarhaba.test",
  password: "e2e-optout-pw-123456",
  notificationPref: "EMAIL",
  token: "e2e-broadcast-token-optout",
  phone: "+447700900104", // TM-934 allocated
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
export const EVENT_GOER = { email: "e2e-event-goer@teammarhaba.test", password: "e2e-event-goer-pw-123456", phone: "+447700900105" };
export const EVENT_WAITER = { email: "e2e-event-waiter@teammarhaba.test", password: "e2e-event-waiter-pw-123456", phone: "+447700900106" };
export const EVENT_FILLER = { email: "e2e-event-filler@teammarhaba.test", password: "e2e-event-filler-pw-123456", phone: "+447700900107" };

/** The events-journey accounts as one list, in a stable order (seeded by global-setup). */
export const EVENT_ACCOUNTS = [EVENT_GOER, EVENT_WAITER, EVENT_FILLER];

/**
 * Chat-foundation account (TM-587). A seeded, un-gated account whose chat is populated — via the
 * profile-gated seed endpoint (POST /api/v1/test/chat/seed, see chat-seed.mjs) — with a couple of
 * event group threads + an admin "from TeamMarhaba" channel, each with messages + unread state. This
 * lets chat-foundation.spec.mjs render + assert the populated conversation list / an open thread / the
 * unread Chat-tab badge against a LIVE backend, closing the TM-564 evidence gap (which had to use
 * route mocks because no write/seed path existed). Provisioned onboarded + terms-accepted in
 * global-setup so it lands straight in the app; the chat rows themselves are seeded per run by the spec.
 */
export const CHAT_SEED = { email: "e2e-chat-seed@teammarhaba.test", password: "e2e-chat-seed-pw-123456", phone: "+447700900108" };

/**
 * Every seeded persona, in allocation order (ADMIN=…100 … CHAT_SEED=…108). Used by global-setup to
 * seed each one's verified phone, and by {@link assertUniquePersonaPhones} to fail loudly if two ever
 * share a number (which the strict-1:1 rule would otherwise turn into an opaque seeding 409).
 */
export const ALL_PERSONAS = [
  ADMIN,
  TARGET,
  PUSH_RECIPIENT,
  BOTH_RECIPIENT,
  OPTOUT_RECIPIENT,
  EVENT_GOER,
  EVENT_WAITER,
  EVENT_FILLER,
  CHAT_SEED,
];

/**
 * Fail LOUDLY at setup time if any two personas were given the same allocated phone (a copy-paste slip
 * in the table above), rather than letting it surface as an inscrutable Admin-SDK / index 409 mid-seed.
 * Called by global-setup before it seeds. Also verifies every persona actually HAS a phone.
 */
export function assertUniquePersonaPhones() {
  const seen = new Map();
  for (const p of ALL_PERSONAS) {
    if (!p.phone) throw new Error(`persona ${p.email} has no allocated phone (TM-934 fixtures)`);
    if (seen.has(p.phone)) {
      throw new Error(
        `duplicate persona phone ${p.phone}: ${seen.get(p.phone)} and ${p.email} — ` +
          `each persona needs its own number under strict 1:1 Firebase phone uniqueness (TM-934).`,
      );
    }
    seen.set(p.phone, p.email);
  }
}

/** Connection for the persisted-state assertion (same Postgres the stack uses). */
export const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "teammarhaba",
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "devpassword",
};

/**
 * A per-run unique, LETTERS-ONLY stamp (digits 0-9 → a-j). The profile name/city fields reject
 * digits since TM-771, so unique-per-run values typed into First name / Last name / City must be
 * alphabetic — e.g. `Testville-${lettersOnlyStamp()}`. Emails, event locations and other free-text
 * fields can keep the plain numeric Date.now() form.
 */
export function lettersOnlyStamp() {
  return String(Date.now()).replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
}
