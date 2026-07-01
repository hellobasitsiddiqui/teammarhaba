// Seed N distinct load-test accounts into the Firebase Auth emulator, then JIT-provision each
// in the backend (GET /api/v1/me) — the exact same mechanism web/e2e/global-setup.mjs uses, but
// parametrised for the load harness (TM-343). Run this ONCE before `k6 run test/load/api-load.js`
// so the k6 script has VUS distinct seeded users to sign in as (one per virtual user).
//
// These are DISPOSABLE emulator accounts — never real users, never prod data. The emulator is
// wiped each run, so fixed credentials are fine.
//
// Usage (from repo root, with the Auth emulator + backend already up — see README.md here):
//   VUS=50 node test/load/seed-users.mjs
//
// Env (all optional; must match what api-load.js expects):
//   VUS                 how many accounts to seed        (default 5)
//   USER_PREFIX         email local-part prefix          (default "loadtest-user")
//   USER_DOMAIN         email domain                     (default "teammarhaba.test")
//   USER_PASSWORD       shared password                  (default "loadtest-pw-123456")
//   FIREBASE_PROJECT_ID / FIREBASE_AUTH_EMULATOR_HOST / E2E_API_BASE_URL — as per web/e2e/fixtures.mjs
import admin from "firebase-admin";

const VUS = Number(process.env.VUS || 5);
const USER_PREFIX = process.env.USER_PREFIX || "loadtest-user";
const USER_DOMAIN = process.env.USER_DOMAIN || "teammarhaba.test";
const USER_PASSWORD = process.env.USER_PASSWORD || "loadtest-pw-123456";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "teammarhaba";
const AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.E2E_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const API_BASE_URL = (process.env.E2E_API_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

async function ensureUser(auth, email, password) {
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

// Sign in via the emulator + call GET /me so the backend provisions the `users` row (JIT, TM-112).
async function provision(email, password) {
  const signInUrl = `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
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

async function main() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  for (let i = 0; i < VUS; i++) {
    const email = `${USER_PREFIX}-${i}@${USER_DOMAIN}`;
    await ensureUser(auth, email, USER_PASSWORD);
    await provision(email, USER_PASSWORD);
  }
  console.log(
    `[seed] seeded + provisioned ${VUS} load-test accounts (${USER_PREFIX}-0..${VUS - 1}@${USER_DOMAIN})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
