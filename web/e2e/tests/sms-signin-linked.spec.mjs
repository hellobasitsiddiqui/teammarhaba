import { test, expect } from "@playwright/test";
import admin from "firebase-admin";
import { expectSignedIn, expectSignedOut, signOutViaProfile } from "../helpers/auth-state.mjs";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "../fixtures.mjs";

// SMS sign-in for LINKED accounts (TM-933, TM-923 subticket D).
//
// Proves the Firebase-native mechanism verified in STEP 1 (verify-tm933-uid-equality.mjs): a phone
// LINKED to an existing email account (TM-930 links it via linkWithCredential; here the emulator
// admin accounts:update REST links it deterministically, decoupled from A's UI) is a valid SMS
// sign-in method for the SAME account — email OTP and SMS OTP open one identity, not two.
//
// Harness = the tm867-otp-6box.spec.mjs SMS path (:156-188): drive the real login UI → "Try another
// way" → SMS, fetch the code from the Auth emulator verificationCodes endpoint, let the six-box
// auto-submit finish sign-in (NO #sms-verify-btn click). No route mocks — live backend + emulator.
//
// Backend is READ-ONLY for this ticket: the expected server-side change is NONE.

// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the controls —
// same init script as the tm867 spec.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

/** The Admin SDK pointed at the emulator (create accounts, link phones onto a uid). Lazily inited so
 *  a single app instance is reused across tests in this file. */
function emulatorAuth() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  return admin.auth();
}

/** Mint an emulator ID token for an email/password account (the REST the SDK's sign-in wraps). */
async function idTokenFor(email, password) {
  const url =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`emulator sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

/**
 * Create + provision an ONBOARDED email account (mirrors global-setup.provisionInBackend, TM-880
 * rule: PATCH /me {phone} BEFORE onboarding-complete). Returns { uid, email, password, headers }.
 * `phone` is the mandatory profile phone stored on the backend row (MeResponse.phone). Kept per-test
 * (not a shared fixture) because each test links a phone to its OWN uid.
 */
async function provisionOnboardedAccount(auth, { email, password, phone }) {
  const user = await auth.createUser({ email, password, emailVerified: true });
  const idToken = await idTokenFor(email, password);
  const headers = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers });
  if (!meRes.ok) throw new Error(`GET /me failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  const me = await meRes.json();

  const patch = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (!patch.ok) throw new Error(`PATCH /me phone failed for ${email}: ${patch.status} ${await patch.text()}`);

  const onboard = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers });
  if (!onboard.ok) {
    throw new Error(`onboarding-complete failed for ${email}: ${onboard.status} ${await onboard.text()}`);
  }
  if (me.currentTermsVersion) {
    const terms = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version: me.currentTermsVersion }),
    });
    if (!terms.ok) throw new Error(`accept-terms failed for ${email}: ${terms.status} ${await terms.text()}`);
  }
  return { uid: user.uid, email, password, headers };
}

/** GET /api/v1/me as the currently signed-in browser user, reading its live ID token from the page.
 *  Proves identity from the SERVER's view (MeResponse: uid + email + phone + accountState), not just
 *  the client Firebase user. */
async function fetchMeFromBrowser(page) {
  // Poll for the token: after the six-box auto-submit fires, `body[data-auth=signed-in]` can flip a
  // beat before auth.currentUser is populated (same auto-submit timing the blackboard notes for the
  // profile-blank-phone spec), so a single immediate read can race to null.
  let idToken = null;
  await expect
    .poll(
      async () => {
        // window.tmAuth.getIdToken() (auth.js:263-266) resolves to the signed-in user's ID token, or null.
        idToken = await page.evaluate(() => window.tmAuth?.getIdToken?.() ?? null);
        return Boolean(idToken);
      },
      { message: "waiting for a signed-in Firebase user to mint an ID token from" },
    )
    .toBe(true);
  // GET /me is a write-on-read (it stamps last_active_at, TM-164) guarded by a @Version optimistic
  // lock. Right after sign-in the APP fires its OWN GET /me to hydrate the session; our probe fetch
  // can land in the same instant and lose the version race → a transient 409 ("changed by another
  // request"). That is a benign concurrency clash, not an identity failure, so retry the probe until
  // the app's write settles and our read wins. Any OTHER non-ok status fails loud immediately.
  let body = null;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${API_BASE_URL}/api/v1/me`, {
          headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" },
        });
        if (res.status === 409) return false; // optimistic-lock clash with the app's own /me — retry
        if (!res.ok) throw new Error(`GET /me (browser identity) failed: ${res.status} ${await res.text()}`);
        body = await res.json();
        return true;
      },
      { message: "waiting for GET /me to win the last_active_at write race after sign-in" },
    )
    .toBe(true);
  return body;
}

/** Fetch the latest SMS OTP the Auth emulator "texted" to a number (the SMS twin of the email peek). */
async function peekSmsCode(phone) {
  const res = await fetch(
    `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`,
  );
  if (!res.ok) throw new Error(`verificationCodes lookup failed: ${res.status}`);
  const { verificationCodes = [] } = await res.json();
  const code = verificationCodes.filter((v) => v.phoneNumber === phone).at(-1)?.code;
  expect(code, `no emulator SMS code for ${phone}`).toMatch(/^\d{6}$/);
  return code;
}

/** Drive the login UI's SMS flow: "Try another way" → enter number → send → fetch code → let the
 *  six-box auto-submit finish (NO #sms-verify-btn click, matching the tm867 SMS contract). */
async function smsSignIn(page, phone) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.click("#try-another-btn");
  await expect(page.locator("#sms-step-phone")).toBeVisible();
  await page.fill("#phone", phone);
  await page.click("#sms-send-btn");
  await expect(page.locator("#sms-step-code")).toBeVisible();
  await expect(page.locator("#sms-code")).toBeFocused();
  const code = await peekSmsCode(phone);
  await page.fill("#sms-code", code); // fans out across the six boxes → auto-submit
}

test("@auth linked-phone SMS sign-in lands in the SAME account — no onboarding gate", async ({ page }) => {
  const auth = emulatorAuth();
  const stamp = Date.now();
  const email = `e2e-linked-${stamp}@teammarhaba.test`;
  // The number we LINK to the account (distinct from the seed default +447700900123). It becomes both
  // the stored profile phone AND the Firebase phone sign-in method for this uid.
  const linkedPhone = `+1650555${String(stamp).slice(-4)}`;

  // 1. An onboarded email account (email sign-in), with `linkedPhone` as its stored profile phone.
  const account = await provisionOnboardedAccount(auth, {
    email,
    password: "e2e-linked-pw-123456",
    phone: linkedPhone,
  });

  // 2. LINK the phone as a Firebase sign-in method ON that same uid (deterministic stand-in for
  //    TM-930's linkWithCredential — the emulator admin accounts:update path the ticket prefers).
  await auth.updateUser(account.uid, { phoneNumber: linkedPhone });

  // 3. Cold SMS sign-in with the linked number.
  await smsSignIn(page, linkedPhone);
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // 4. SAME identity, from the SERVER's view: GET /me returns the original account's email + uid, its
  //    stored profile phone is the linked number, and Firebase reports the phone as VERIFIED — email
  //    OTP and SMS OTP resolve to ONE account, not two.
  //
  //    DRIFT (code over contract): the ticket/prompt say assert `UserResponse.phoneNumber`, but the
  //    SELF endpoint GET /api/v1/me returns MeResponse (api/MeResponse.java), whose stored profile
  //    phone field is `phone` (the E.164 we PATCHed = the linked number) and whose live-Firebase auth
  //    state is `accountState.phoneVerified`. `phoneNumber` (live Firebase auth phone) is the ADMIN
  //    projection UserResponse (api/UserResponse.java:43), not exposed on /me. So we assert `me.phone`
  //    + `me.accountState.phoneVerified` here — same claim ("this account owns the linked number"),
  //    read from the fields the self endpoint actually returns.
  const me = await fetchMeFromBrowser(page);
  expect(me.email).toBe(email);
  expect(me.uid).toBe(account.uid);
  expect(me.phone).toBe(linkedPhone);
  expect(me.accountState?.phoneVerified).toBe(true);

  // 5. NO onboarding/phone completion gate fired — a linked, already-onboarded account lands straight
  //    in the app, never on #/onboarding (users.phone is populated → needsPhoneNumber false).
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .not.toContain("/onboarding");
});

test("@auth TM-720 reset: sign-out from an SMS session restores the email step; email-code reaches the SAME account", async ({
  page,
}) => {
  const auth = emulatorAuth();
  const stamp = Date.now();
  const email = `e2e-reset-${stamp}@teammarhaba.test`;
  const password = "e2e-reset-pw-123456";
  const linkedPhone = `+1650555${String(stamp).slice(-4)}`;

  const account = await provisionOnboardedAccount(auth, { email, password, phone: linkedPhone });
  await auth.updateUser(account.uid, { phoneNumber: linkedPhone });

  // Sign in via SMS first…
  await smsSignIn(page, linkedPhone);
  await expectSignedIn(page);

  // …then sign out the way a real user must now (TM-906: Profile hub → confirm dialog). The TM-720
  // onSignedOut reset chain (login.js:368-383) fires as part of this.
  await signOutViaProfile(page);
  await expectSignedOut(page);

  // TM-720 contract (login.js:368-383): the form is back on the DEFAULT email step, the SMS steps are
  // reset (phone step visible, code step hidden), the alternatives disclosure is collapsed, and the
  // SMS OTP boxes are empty — no stale code can be resubmitted.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await expect(page.locator("#emailcode-step-email")).toBeVisible();
  // The alternatives block is collapsed after the reset, so open it to inspect the SMS steps.
  await page.click("#try-another-btn");
  await expect(page.locator("#sms-step-phone")).toBeVisible();
  await expect(page.locator("#sms-step-code")).toBeHidden();
  for (const sel of ["#sms-code", "#sms-code-2", "#sms-code-3", "#sms-code-4", "#sms-code-5", "#sms-code-6"]) {
    await expect(page.locator(sel)).toHaveValue("");
  }

  // The OTHER door opens the SAME identity: email-code sign-in reaches the original account.
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  const peek = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  const emailCode = (await peek.text()).trim();
  expect(emailCode).toMatch(/^\d{6}$/);
  await page.fill("#emailcode-code", emailCode); // six-box auto-submit
  await expectSignedIn(page);

  const me = await fetchMeFromBrowser(page);
  expect(me.email).toBe(email);
  expect(me.uid).toBe(account.uid);
  expect(me.phone).toBe(linkedPhone);
});

test("@auth CURRENT-STATE PIN: an UNOWNED number creates a fresh phone-only session routed to #/onboarding", async ({
  page,
}) => {
  // ⚠ TRIPWIRE, NOT A BLOCKER. This pins TODAY's behaviour for an SMS number that is NOT linked to any
  // account: Firebase creates a brand-new phone-only account (no email), and because that account has
  // no stored E.164 phone on the backend (users.phone null → profile-core.needsPhoneNumber true), the
  // router holds it at the #/onboarding completion gate.
  //
  // Subtickets B/C (TM-923) will CHANGE this expectation — an unowned number will become a first-class
  // phone-first signup rather than a gate. When they land, flip this assertion (it is a canary that
  // the current-state behaviour changed, not a guard that must forever hold).
  const stamp = Date.now();
  const unownedPhone = `+1650555${String(stamp).slice(-4)}`; // never linked to any account

  await smsSignIn(page, unownedPhone);
  await expectSignedIn(page); // Firebase auth succeeded — a phone-only account now exists…

  // …but it is a NEW, email-less identity held at the phone-completion gate.
  const me = await fetchMeFromBrowser(page);
  expect(me.email).toBeFalsy(); // phone-only account: null email (UserProvisioner, User.java:56-57)
  expect(me.phone).toBeFalsy(); // no stored E.164 profile phone yet → needsPhoneNumber true → gated

  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toContain("/onboarding");
  await expect(page.locator("#onboarding-view")).toBeVisible();
});
