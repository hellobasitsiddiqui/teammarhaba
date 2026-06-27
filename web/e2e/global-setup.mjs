// Playwright global setup (TM-134): seed the Firebase Auth emulator and provision the seeded
// accounts in the backend, so the admin walkthrough has a real ADMIN to sign in as and a real
// USER to disable. Runs once before the suite. Assumes the Auth emulator + backend are already
// up (the workflow / local instructions start them first).
//
// Idempotent: re-running recreates the accounts and re-applies the ADMIN claim.
import admin from "firebase-admin";
import { ADMIN, TARGET, PROJECT_ID, API_BASE_URL, AUTH_EMULATOR_HOST } from "./fixtures.mjs";

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
 *  backend reports on GET /me (`currentTermsVersion`), so the same seeded accounts clear BOTH gates. */
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

  console.log("[e2e] seeded admin + target accounts and provisioned them in the backend");
}
