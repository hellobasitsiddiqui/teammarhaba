// Playwright global setup (TM-134): seed the Firebase Auth emulator and provision the seeded
// accounts in the backend, so the admin walkthrough has a real ADMIN to sign in as and a real
// USER to disable. Runs once before the suite. Assumes the Auth emulator + backend are already
// up (the workflow / local instructions start them first).
//
// Idempotent: re-running recreates the accounts and re-applies the ADMIN claim.
import admin from "firebase-admin";
import {
  ADMIN,
  TARGET,
  BROADCAST_RECIPIENTS,
  EVENT_ACCOUNTS,
  CHAT_SEED,
  PROJECT_ID,
  API_BASE_URL,
  AUTH_EMULATOR_HOST,
} from "./fixtures.mjs";

/** Create the user if missing, else reset its password — returns the user record. */
async function ensureUser(auth, { email, password }) {
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, emailVerified: true, disabled: false });
    return existing;
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      return auth.createUser({ email, password, emailVerified: true });
    }
    throw err;
  }
}

/** Mint an emulator ID token for the account, then call GET /api/v1/me so the backend
 *  provisions its `users` row (JIT) — that's what makes it appear in the admin list. Also marks the
 *  account onboarding-complete so the TM-250 first-login gate doesn't intercept it: the seeded
 *  ADMIN/TARGET are "returning, complete" fixtures, and every existing spec (admin walkthrough,
 *  profile edit, email-code login as these accounts) expects them to land straight in the app, not on
 *  the gate. They're JIT-provisioned at RUN time — AFTER migrations — so the V8 backfill can't reach
 *  them; we flip the flag here via POST /me/onboarding-complete (the existing idempotent transition).
 *  We ALSO accept the current terms version (TM-170) via POST /me/accept-terms, reading the version the
 *  backend reports on GET /me (`currentTermsVersion`), so the same seeded accounts clear BOTH gates.
 *
 *  Returns the account's authed request headers (Bearer + Accept) so a caller can make further
 *  first-party API calls as this account without minting a second token — used by the broadcast
 *  recipient seeding (TM-366) to PATCH the notification pref and register a device token. */
async function provisionInBackend({ email, password }) {
  const signInUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!signInRes.ok) {
    throw new Error(`emulator sign-in failed for ${email}: ${signInRes.status} ${await signInRes.text()}`);
  }
  const { idToken } = await signInRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) {
    throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  }
  // The backend reports the currently published terms version here (TM-170) — accept exactly that.
  const me = await meRes.json();
  const currentTermsVersion = me.currentTermsVersion;

  // Un-gate the seeded account (TM-250): mark first-run onboarding complete so the gate is bypassed.
  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, {
    method: "POST",
    headers: authed,
  });
  if (!onboardRes.ok) {
    throw new Error(
      `mark onboarding-complete failed for ${email}: ${onboardRes.status} ${await onboardRes.text()}`,
    );
  }

  // Un-gate the seeded account (TM-170): accept the current terms version so the terms gate is bypassed
  // too. Skipped only if the backend somehow reports no current version (it always should).
  if (currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: currentTermsVersion }),
    });
    if (!termsRes.ok) {
      throw new Error(
        `accept-terms failed for ${email}: ${termsRes.status} ${await termsRes.text()}`,
      );
    }
  }

  return authed;
}

/**
 * Seed one broadcast recipient (TM-366): create + provision + un-gate it (via {@link provisionInBackend}),
 * then PATCH its {@code notificationPref} and register a device token, so the running backend resolves a
 * real, opt-in-classified device for the admin broadcast e2e.
 *
 *   • pref = PUSH / BOTH  ⇒ push-eligible, so the broadcast targets its token (Outcome SENT).
 *   • pref = EMAIL        ⇒ the push opt-out (TM-364), so the broadcast SKIPs it even though it has a
 *                           token — proving the skip is by preference, not "no device".
 *
 * The pref is set with PATCH /api/v1/me (the same partial-update the profile page uses) and the token with
 * POST /api/v1/me/devices (the idempotent register that JIT-provisions + persists against the user id, as
 * DeviceTokenServiceIntegrationTest exercises). Both run as the recipient itself, using the authed headers
 * provisionInBackend hands back — identity is the Bearer token, never the body.
 */
async function seedBroadcastRecipient(auth, recipient) {
  await ensureUser(auth, recipient);
  const authed = await provisionInBackend(recipient);

  // Opt the account into (or out of) push by setting its notification preference (TM-162). EMAIL is the
  // default + the push opt-out; PUSH/BOTH opt in. This is the first send path to honour the pref (TM-364).
  const prefRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ notificationPref: recipient.notificationPref }),
  });
  if (!prefRes.ok) {
    throw new Error(
      `set notificationPref failed for ${recipient.email}: ${prefRes.status} ${await prefRes.text()}`,
    );
  }

  // Register a device token so the backend has a device to (attempt to) target — or, for the opt-out
  // account, a device it must deliberately NOT target. Idempotent upsert keyed on the token value, so a
  // re-run just re-points the same disposable token at the same account (no duplicate row).
  const deviceRes = await fetch(`${API_BASE_URL}/api/v1/me/devices`, {
    method: "POST",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ token: recipient.token, platform: "ANDROID" }),
  });
  if (!deviceRes.ok) {
    throw new Error(
      `register device token failed for ${recipient.email}: ${deviceRes.status} ${await deviceRes.text()}`,
    );
  }
}

export default async function globalSetup() {
  // Point the Admin SDK at the emulator (no real credentials needed).
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  const adminUser = await ensureUser(auth, ADMIN);
  await ensureUser(auth, TARGET);

  // Grant the admin its role — the same custom claim the backend authorizes on (TM-110).
  // Set BEFORE provisioning so the minted token already carries role=ADMIN.
  await auth.setCustomUserClaims(adminUser.uid, { role: "ADMIN" });

  await provisionInBackend(ADMIN);
  await provisionInBackend(TARGET);

  // Broadcast-compose recipients (TM-366): ≥2 push-eligible accounts + one EMAIL-only opt-out, each
  // with a device token, so the admin broadcast e2e can multi-select them and assert fan-out + opt-out
  // skip. Seeded sequentially (small N) after the base accounts so the admin list has them to pick.
  for (const recipient of BROADCAST_RECIPIENTS) {
    await seedBroadcastRecipient(auth, recipient);
  }

  // Events-journey accounts (TM-400): a browser goer, a browser waiter and an API-only filler — all
  // provisioned + un-gated (onboarding + terms accepted) so they land straight in the app. The events
  // themselves are created PER RUN by the spec via the admin API (it needs the ids back), not here.
  for (const account of EVENT_ACCOUNTS) {
    await ensureUser(auth, account);
    await provisionInBackend(account);
  }

  // Chat-foundation account (TM-587): provisioned onboarded + terms-accepted so it lands straight in
  // the app. Its chat is populated PER RUN by chat-foundation.spec.mjs via the seed endpoint (which
  // needs the account's own token), not here — mirroring how the events spec creates its events per run.
  await ensureUser(auth, CHAT_SEED);
  await provisionInBackend(CHAT_SEED);

  console.log(
    `[e2e] seeded admin + target + ${BROADCAST_RECIPIENTS.length} broadcast recipients + ` +
      `${EVENT_ACCOUNTS.length} events-journey accounts + 1 chat-foundation account and provisioned them in the backend`,
  );
}
