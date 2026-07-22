// STEP 1 verify-first gate (TM-933): prove that a phone LINKED to an email account is a valid SMS
// sign-in method for the SAME account — the resulting uid must EQUAL the original account's uid.
//
// This is a STANDALONE script (not part of the Playwright suite). It talks to the SAME stack the
// suite uses (Firebase Auth emulator + backend + Postgres) and reproduces Firebase's native
// semantics exactly as the app's startPhoneSignIn (auth.js:203 → signInWithPhoneNumber) +
// verifySms (login.js:302-306 → confirmationResult.confirm(code)) do — the emulator's
// accounts:sendVerificationCode + accounts:signInWithPhoneNumber are the REST endpoints the Web SDK
// calls under those two functions.
//
// Run: /opt/homebrew/Cellar/node@20/20.20.2/bin/node web/e2e/verify-tm933-uid-equality.mjs
import admin from "firebase-admin";
import { PROJECT_ID, API_BASE_URL, AUTH_EMULATOR_HOST } from "./fixtures.mjs";

const KEY = "fake-api-key";
const IDT = `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts`;

function decodeUid(idToken) {
  // Emulator ID tokens are unsigned JWTs; read the uid (`user_id`/`sub`) from the payload.
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
  return payload.user_id || payload.sub;
}

async function post(path, body) {
  const res = await fetch(`${IDT}:${path}?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  const stamp = Date.now();
  const email = `tm933-verify-${stamp}@teammarhaba.test`;
  const password = "tm933-verify-pw-123456";
  // A phone DISTINCT from the seed's +447700900123, unowned before we link it, so the equality
  // proof can't be a coincidence of a pre-existing phone account. Derived from the run stamp so the
  // script is RE-RUNNABLE against a long-lived emulator (a fixed number would collide with a prior
  // run's still-present phone account — Firebase rejects a second link of an already-owned number).
  const linkedPhone = `+1650555${String(stamp).slice(-4)}`;

  // 1. Create the EMAIL account (no phone yet).
  const created = await auth.createUser({ email, password, emailVerified: true });
  const emailUid = created.uid;
  console.log(`[1] created email account ${email} → uid=${emailUid}`);

  // 1b. Provision it in the backend as an onboarded, complete account (TM-880: phone PATCH before
  //     onboarding-complete). This mirrors the real "already a member" state.
  const signIn = await post("signInWithPassword", { email, password, returnSecureToken: true });
  const authed = { Authorization: `Bearer ${signIn.idToken}`, Accept: "application/json" };
  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  const me0 = await meRes.json();
  await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: linkedPhone }),
  });
  await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (me0.currentTermsVersion) {
    await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: me0.currentTermsVersion }),
    });
  }
  console.log(`[2] provisioned + onboarded ${email} in the backend (phone ${linkedPhone})`);

  // 2. LINK the phone to that EXISTING uid via the emulator admin accounts:update REST (the
  //    deterministic stand-in for TM-930's linkWithCredential — sets phoneNumber ON the same uid).
  await auth.updateUser(emailUid, { phoneNumber: linkedPhone });
  const afterLink = await auth.getUser(emailUid);
  console.log(`[3] linked ${linkedPhone} to uid=${emailUid} (record.phoneNumber=${afterLink.phoneNumber})`);

  // 3. Now run the SMS sign-in flow with that number — exactly what the app does:
  //      startPhoneSignIn → signInWithPhoneNumber  ≡  accounts:sendVerificationCode
  //      confirmationResult.confirm(code)          ≡  accounts:signInWithPhoneNumber
  const { sessionInfo } = await post("sendVerificationCode", { phoneNumber: linkedPhone });
  const codesRes = await fetch(
    `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`,
  );
  const { verificationCodes = [] } = await codesRes.json();
  const code = verificationCodes.filter((v) => v.phoneNumber === linkedPhone).at(-1)?.code;
  console.log(`[4] SMS OTP for ${linkedPhone} = ${code}`);
  const smsSignIn = await post("signInWithPhoneNumber", { sessionInfo, code });
  const smsUid = decodeUid(smsSignIn.idToken);
  console.log(`[5] SMS sign-in resolved → uid=${smsUid} (isNewUser=${smsSignIn.isNewUser === true})`);

  // 4. THE ASSERTION.
  const equal = smsUid === emailUid;
  console.log("\n=== TM-933 STEP 1 RESULT ===");
  console.log(`email-account uid : ${emailUid}`);
  console.log(`sms-signin  uid   : ${smsUid}`);
  console.log(`isNewUser         : ${smsSignIn.isNewUser === true}`);
  console.log(`UIDS EQUAL        : ${equal}`);
  if (!equal) {
    console.error("\nFAIL — linked-phone SMS OTP did NOT resolve to the same account. Ticket premise fails.");
    process.exit(2);
  }
  console.log("\nPASS — linked-phone SMS OTP resolves to the SAME account. No server-side change needed.");
}

main().catch((err) => {
  console.error("verify script error:", err);
  process.exit(1);
});
