// Phone re-gate of an EXISTING, COMPLETED account (TM-899 — TM-892 review finding, PR #587 M2;
// EXTENDED by TM-932 for the retroactive VERIFIED-phone re-gate).
//
// TM-880's headline behaviour is that the completion gate applies to EXISTING accounts, not just new
// signups: any signed-in user whose stored phone is missing / not parseable E.164 is routed back
// through `#/onboarding` on every navigation — onboardingCompleted=true included (the router's
// `Boolean(onboardingCompleted) && !needsPhoneNumber(me)` term, router.js). TM-932 tightens this: an
// account whose stored phone is present + parseable but NOT the number Firebase has actually VERIFIED
// (`!needsVerifiedPhone(me, currentUser().phoneNumber)`) is re-gated too — realising the strict
// "one verified number = one account" (TM-923) for the WHOLE existing user base, not just new signups.
//
// TM-992 (decision C = GRACE, then FORCE) then SOFTENED the TM-932 verified-phone term: the router only
// folds it into `isOnboarded` when phoneReverifyDecision says HARD_GATE — i.e. a CONFIG-DRIVEN deadline
// (`window.TEAMMARHABA_CONFIG.phoneReverifyDeadline`) exists AND has passed. Inside the grace window (or,
// the SAFE DEFAULT, with no deadline configured at all) the account stays UN-gated and gets only the
// dismissible nudge banner (phone-reverify-notice.js). TM-1010: this spec originally still asserted the
// pre-TM-992 IMMEDIATE hard gate, which made it red on main — the hard-gate test now forces the deadline
// PAST (per-page config override), and a grace-window test pins the nudge-not-gate default.
//
// This spec now carries three behavioural checks (all on main only — the fast PR twins
// web/tools/profile-regate-core.test.mjs + phone-reverify-core.test.mjs guard the wiring on the PR gate):
//   1. TM-880 (phone CLEARED): a completed account whose phone is cleared server-side is re-gated
//      (needsPhoneNumber — NOT softened by TM-992, which covers only the verified-phone term). Its
//      control account now seeds a VERIFIED phone (Admin SDK) so it lands un-gated BEFORE the clear.
//   2. TM-932/TM-992 (phone UNVERIFIED, deadline PAST): a completed account with a STORED phone but NO
//      linked Firebase phone credential (the common retroactive population) is HARD-re-gated once the
//      re-verify deadline has passed (forced past for the page), and verifying through the gate
//      (Firebase OTP + link, via the Auth emulator) un-gates it.
//   3. TM-992 (phone UNVERIFIED, grace window): the same population WITHOUT a configured deadline lands
//      IN the app with the dismissible nudge banner — grace, never a lock-out.
//
// FAIL-BEFORE (unit twin proves it deterministically; this main-only spec is the behavioural sibling):
// dropping `!needsVerifiedPhone(...)`/the HARD_GATE term from the router ternary leaves the UNVERIFIED
// account un-gated past the deadline and test 2's gate-intercept assertions fail; a "gate everyone"
// regression (e.g. hard-gating without a deadline) fails test 1's un-gated control AND test 3's
// grace-window landing (a verified/inside-grace account must NOT be gated).
//
// Idioms: per-run self-owned account via the Auth emulator's accounts:signUp + the public-API
// un-gate sequence (the chat-search / payment-webhook-safety pattern — no shared fixture touched);
// verified-phone seeding via the Admin SDK `auth.updateUser({phoneNumber})` (the same mechanism
// global-setup + sms-signin-linked.spec use); pinned phone-width viewport so the bottom tab bar is a
// real, visible surface (the chat-search pattern); tour-suppression beforeEach; email+password
// "Try another way" sign-in; gate OTP peeked from the Auth emulator (the tm930 gate-verify pattern).

import { test, expect } from "@playwright/test";
import admin from "firebase-admin";
import { AUTH_EMULATOR_HOST, API_BASE_URL, PROJECT_ID, uniqueTestPhone } from "../fixtures.mjs";
import { peekPhoneOtp, completeInterestsStep } from "../helpers/onboarding.mjs";

// The completion gate deliberately hides the bottom tab bar (a gate must not be side-steppable —
// the TM-885 verdict), and the bar only renders at a phone width (`@media (max-width: 33rem)` —
// desktop keeps it display:none). Pin a Pixel-5-ish viewport so "tab bar hidden" is a REAL assertion
// (visible before the gate, hidden behind it), not vacuously true on a desktop viewport. Runs under
// the default (desktop) project — self-contained, no shared-config testMatch change (chat-search's
// approach).
test.use({ viewport: { width: 393, height: 851 } });

// Suppress the first-run product tour so its backdrop can't overlay the surfaces under assertion —
// the identical localStorage init-script the sibling specs use.
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

/** The Admin SDK pointed at the emulator — lazily inited, reused across tests in this file. Used to
 *  LINK a verified phone onto a uid (the same mechanism global-setup + sms-signin-linked.spec use). */
function emulatorAuth() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  return admin.auth();
}

/**
 * Create a FRESH, per-run account and walk it to FULLY COMPLETED: signUp on the Auth emulator, JIT
 * provision (GET /me), seed a valid E.164 phone (mandatory before onboarding-complete since TM-880),
 * mark onboarding complete, accept the current terms — the exact post-#587 global-setup sequence,
 * replicated inline so no shared helper/fixture is touched (the chat-search isolation pattern).
 *
 * TM-932: `verifyPhone` controls whether the stored phone is ALSO seeded as a VERIFIED Firebase phone
 * (Admin SDK `updateUser({phoneNumber})` — verified-by-construction, exactly how global-setup seeds
 * the personas). With it, the account's stored phone equals its Firebase-verified number, so it lands
 * UN-gated (needsVerifiedPhone is satisfied). WITHOUT it (the retroactive population), the stored phone
 * is present on the backend row but no phone credential is linked, so the account is re-gated on entry.
 *
 * Returns the creds for the browser sign-in, the account's own authed headers, its uid, and the stored
 * E.164 phone — so a test can later clear the phone, or re-verify it through the gate, AS THE ACCOUNT
 * ITSELF (no admin backdoor beyond the phone link that models a real verified account).
 *
 * @param {{verifyPhone?: boolean}} [opts] verifyPhone=true seeds the stored phone as a verified
 *   Firebase phone (un-gated control); false (default) leaves it unverified (the retroactive case).
 */
async function createCompletedAccount({ verifyPhone = false } = {}) {
  const email = `e2e-regate-${Date.now()}-${Math.floor(Math.random() * 1e4)}@teammarhaba.test`;
  const password = "e2e-regate-pw-123456";

  const signUpUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const signUpRes = await fetch(signUpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!signUpRes.ok) {
    throw new Error(`emulator signUp failed for ${email}: ${signUpRes.status} ${await signUpRes.text()}`);
  }
  const { idToken, localId: uid } = await signUpRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  const currentTermsVersion = (await meRes.json()).currentTermsVersion;

  // TM-934: a per-run-unique number so this fresh "completed" account never collides with a persona or
  // a prior run under the strict 1:1 uniqueness rule (V48 index).
  const phone = uniqueTestPhone();
  const phoneRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (!phoneRes.ok) throw new Error(`seed phone failed for ${email}: ${phoneRes.status} ${await phoneRes.text()}`);

  // TM-932: optionally seed the SAME number as a VERIFIED Firebase phone (Admin SDK) so the account's
  // stored phone matches its verified number → un-gated. Without this, the stored phone is unverified
  // (no linked credential), which is exactly the retroactive population needsVerifiedPhone re-gates.
  if (verifyPhone) {
    await emulatorAuth().updateUser(uid, { phoneNumber: phone });
  }

  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (!onboardRes.ok) {
    throw new Error(`onboarding-complete failed for ${email}: ${onboardRes.status} ${await onboardRes.text()}`);
  }

  if (currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: currentTermsVersion }),
    });
    if (!termsRes.ok) throw new Error(`accept-terms failed for ${email}: ${termsRes.status} ${await termsRes.text()}`);
  }

  return { email, password, authed, uid, phone };
}

/**
 * Force the retroactive re-verify deadline PAST for this page, so phoneReverifyDecision returns
 * HARD_GATE for an unverified stored phone. TM-992 shipped grace-then-force: without a configured
 * deadline the SAFE DEFAULT is grace-only (a dismissible nudge, NEVER the hard #/onboarding re-gate),
 * so the hard-gate path can only be exercised deterministically by configuring a deadline that has
 * already passed.
 *
 * Mechanism: serve.mjs synthesises /assets/config.js as a classic script that ASSIGNS a frozen
 * `window.TEAMMARHABA_CONFIG` AFTER init-scripts run, so a plain assignment here would be clobbered.
 * Instead install an accessor whose setter re-merges `phoneReverifyDeadline` into whatever config.js
 * assigns — the exact per-spec config-override pattern paid-rsvp/subscribe use for the membership flag.
 * The init-script persists across reloads of this page, so the deadline stays past for the whole test.
 * Must be called BEFORE the first page.goto.
 */
async function forcePastReverifyDeadline(page, deadline = "2020-01-01") {
  await page.addInitScript((past) => {
    const merge = (cfg) => Object.freeze({ ...(cfg || {}), phoneReverifyDeadline: past });
    let current = merge(window.TEAMMARHABA_CONFIG || {});
    Object.defineProperty(window, "TEAMMARHABA_CONFIG", {
      configurable: true,
      get() {
        return current;
      },
      set(next) {
        current = merge(next);
      },
    });
  }, deadline);
}

/** Sign in through the real UI (email+password "Try another way" — the sibling specs' path). */
async function signInThroughUi(page, { email, password }) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  await page.click("#try-another-btn");
  await page.fill("#password", password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-in")).toBeVisible();
}

test("@profile a COMPLETED account whose phone is cleared is re-gated on reload (TM-880 wiring)", async ({ page }) => {
  // TM-932: the control must land UN-gated, so it needs a VERIFIED phone (a bare stored phone with no
  // linked credential is now itself re-gated by needsVerifiedPhone). Seed the phone verified; the test
  // then CLEARS it to exercise the TM-880 phone-less re-gate (needsPhoneNumber), which is orthogonal.
  const account = await createCompletedAccount({ verifyPhone: true });

  // 1. Sign in through the real UI (email+password "Try another way" — the sibling specs' path).
  await signInThroughUi(page, account);

  // 2. CONTROL (the fail-before seam): with the VERIFIED phone still on record this completed account
  //    lands IN the app — no gate, tab bar shown. This proves the gate assertions below aren't
  //    vacuously true for this account (a "gate everyone" regression fails HERE; a "gate no one", below).
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();

  // 3. Clear the phone server-side AS THE ACCOUNT ITSELF: PATCH /me {"phone":""} (the boundary
  //    pattern's `^$` alternative admits the empty string, and updateProfile applies any non-null
  //    changed value — so this is the real API path to a phone-less EXISTING account, exactly the
  //    pre-TM-880 population the re-gate exists for). Verify the clear landed before reloading so a
  //    gate assertion can never pass against a stale phone.
  const clearRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...account.authed, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "" }),
  });
  expect(clearRes.ok, `PATCH /me {"phone":""} should succeed, got ${clearRes.status}`).toBe(true);
  const cleared = await (await fetch(`${API_BASE_URL}/api/v1/me`, { headers: account.authed })).json();
  expect(cleared.phone ?? "").toBe("");
  expect(cleared.onboardingCompleted, "the flag must survive the clear — ONLY the phone re-gates").toBe(true);

  // 4. Reload: the router re-resolves GET /me — onboardingCompleted is still true, but the account
  //    now has no parseable stored phone, so `!needsPhoneNumber(me)` flips isOnboarded false and the
  //    completion gate intercepts, with the phone pair ready to collect the number.
  await page.reload();
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-phone")).toBeVisible();
  await expect(page.locator("#onboarding-phone-country")).toBeVisible();

  // 5. The gate deliberately hides the bottom tab bar (visible in step 2 at this same viewport) —
  //    a gated user gets no navigation chrome to side-step the gate with (the TM-885 verdict).
  await expect(page.locator("#app-tabbar")).toBeHidden();

  // 6. And the gate HOLDS across navigation: a direct hash-nav to #/home is bounced straight back
  //    (the guard re-runs on every hashchange — re-gating "on every navigation", not just reload).
  await page.evaluate(() => { window.location.hash = "#/home"; });
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page).toHaveURL(/#\/onboarding$/);
  await expect(page.locator("#app-tabbar")).toBeHidden();
});

test("@profile a COMPLETED account with an UNVERIFIED stored phone is HARD-re-gated once the re-verify deadline has passed, and verifying un-gates it (TM-932/TM-992)", async ({
  page,
}) => {
  // The retroactive population: a completed account with a STORED phone on the backend row but NO
  // linked Firebase phone credential (verifyPhone omitted → the phone is unverified). This is exactly
  // what needsVerifiedPhone re-gates — the whole point of TM-932. The stored phone is a real, valid,
  // unique E.164, so needsPhoneNumber is satisfied; only needsVerifiedPhone gates it.
  const account = await createCompletedAccount(); // NO verifyPhone — stored phone is unverified
  const national = account.phone.replace(/^\+44/, ""); // uniqueTestPhone() is a GB (+44) number

  // TM-992 (grace-then-force): the hard re-gate fires ONLY once the config-driven re-verify deadline has
  // passed — inside the grace window (the harness default: no deadline) the account gets the dismissible
  // nudge, not a gate (asserted by the grace-window test below). Force the deadline PAST for this page so
  // phoneReverifyDecision is deterministically HARD_GATE and the gate assertions below are exercised.
  await forcePastReverifyDeadline(page);

  await signInThroughUi(page, account);

  // 1. RE-GATED: onboardingCompleted=true and the stored phone is present + parseable, but it isn't the
  //    account's Firebase-verified number (there is no linked phone at all) — and the re-verify deadline
  //    has passed, so phoneReverifyDecision is HARD_GATE, isOnboarded flips false and the completion gate
  //    intercepts, tab bar hidden. Without the router's HARD_GATE term this account would land in the app
  //    with the tab bar shown — the fail-before seam.
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-phone-send")).toBeVisible(); // the TM-930 verify step
  await expect(page.locator("#app-tabbar")).toBeHidden();

  // The gate PREFILLS the stored number into the (picker, national) pair (prefillPhone), so the user
  // just proves ownership — the national part is the stored number without its +44 dial code.
  await expect(page.locator("#onboarding-phone")).toHaveValue(national, { timeout: 15_000 });

  // Fill the other three required gate fields. This ephemeral account was flipped onboardingCompleted
  // via POST /me/onboarding-complete WITHOUT name/location/age (only the phone was PATCHed), so those
  // are blank in the prefill — the atomic gate submit needs all four. Retry against the async blank
  // prefill (TM-590) so a late GET /me can't clobber the typed values before we submit.
  await expect(async () => {
    await page.fill("#onboarding-name", "Retro Verify");
    await page.selectOption("#onboarding-location", "London");
    await page.fill("#onboarding-age", "34");
    await expect(page.locator("#onboarding-name")).toHaveValue("Retro Verify");
    await expect(page.locator("#onboarding-phone")).toHaveValue(national); // prefill still holds
  }).toPass({ timeout: 15_000 });

  // 2. VERIFY through the gate: send the OTP, peek it from the Auth emulator, fill the first box (the
  //    six-box widget auto-submits) → confirmPhoneLink links the credential to this account. The stored
  //    number now IS the verified number.
  await page.click("#onboarding-phone-send");
  await expect(page.locator("#onboarding-phone-otp-group")).toBeVisible({ timeout: 10_000 });
  await page.fill("#onboarding-phone-otp", await peekPhoneOtp(account.phone));
  await expect(page.locator("#onboarding-phone-verified")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#onboarding-phone-verified")).toContainText("Verified");

  // 3. Submit the gate → interests → the app. Completing the atomic gate (name/location/age + the now-
  //    verified phone) re-flips onboardingCompleted and the router re-guards onto the app WITHOUT a
  //    manual reload — the number is verified, so needsVerifiedPhone no longer holds it.
  const onboarded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await onboarded;
  // Interests step (self-skips if the catalogue can't load) — the shared helper walks it exactly like
  // the tm930 gate-verify + golden-path specs; then the app with the tab bar back.
  await completeInterestsStep(page);
  await expect(page.locator("#onboarding-view")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#app-tabbar")).toBeVisible();

  // 4. UN-GATED for good: a reload re-resolves GET /me + the now-verified Firebase phone, so
  //    needsVerifiedPhone is satisfied and the account stays in the app (no re-gate loop). The forced
  //    PAST deadline is still in effect on this reload (the init-script persists for the page), so
  //    staying un-gated proves it's the VERIFICATION that satisfied the policy (decision NONE), not the
  //    deadline quietly ceasing to apply.
  await page.reload();
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();
});

test("@profile inside the grace window an UNVERIFIED stored phone gets the dismissible nudge, NOT the gate (TM-992)", async ({
  page,
}) => {
  // The same retroactive population as the hard-gate test above, but WITHOUT forcing the deadline: the
  // harness config (serve.mjs) carries no phoneReverifyDeadline — matching the committed prod default —
  // so phoneReverifyDecision returns GRACE_NUDGE (the SAFE DEFAULT: never lock existing users out before
  // product picks a date). The account must land IN the app, tab bar shown, with only the dismissible
  // nudge banner up. This is exactly the shipped TM-992 behaviour this spec used to contradict (TM-1010).
  const account = await createCompletedAccount(); // unverified stored phone, NO deadline override

  await signInThroughUi(page, account);

  // UN-gated: grace, not force. (A regression back to the TM-932 immediate hard gate fails HERE.)
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();

  // The soft nudge is up — phone-reverify-notice.js renders it only on GRACE_NUDGE, with the no-deadline
  // copy (no date to quote). Its "Verify now" routes into the SAME #/onboarding verify flow the hard gate
  // forces, so grace and force land in exactly one place.
  await expect(page.locator("#phone-reverify-notice")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#phone-reverify-notice")).toContainText("verify your phone number");

  // Dismiss is honoured within the visit (in-memory, like the email-verify banner).
  await page.click("#phone-reverify-notice .tm-verify-banner-dismiss");
  await expect(page.locator("#phone-reverify-notice")).toBeHidden();
});
