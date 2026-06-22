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
 *  provisions its `users` row (JIT) — that's what makes it appear in the admin list. */
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

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" },
  });
  if (!meRes.ok) {
    throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
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
