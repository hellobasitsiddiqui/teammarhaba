// Phone re-gate of an EXISTING, COMPLETED account (TM-899 — TM-892 review finding, PR #587 M2).
//
// TM-880's headline behaviour is that the completion gate applies to EXISTING accounts, not just new
// signups: any signed-in user whose stored phone is missing / not parseable E.164 is routed back
// through `#/onboarding` on every navigation — onboardingCompleted=true included (the router's
// `Boolean(onboardingCompleted) && !needsPhoneNumber(me)` term, router.js). Every pre-existing gate
// spec exercised a BRAND-NEW user, gated by onboardingCompleted=false regardless — so this spec is
// the first to make the needsPhoneNumber term itself load-bearing: it provisions a fully COMPLETED
// account (phone seeded, onboarding complete, terms accepted — the post-#587 global-setup sequence),
// proves it lands in the app un-gated, then clears the phone server-side and asserts the re-gate.
//
// FAIL-BEFORE: the first half (phone still set → NOT gated) and the second half (phone cleared →
// gated) are the two sides of the same router term. Neutering `!needsPhoneNumber(...)` in router.js
// (the exact refactor risk TM-892 flagged) leaves the account un-gated after the clear and the
// gate-intercepts assertions below fail; conversely a "gate everyone" regression fails the un-gated
// half. The unit twin (web/tools/profile-regate-core.test.mjs) guards the same wiring on the fast PR
// gate — this suite runs on main only.
//
// Idioms: per-run self-owned account via the Auth emulator's accounts:signUp + the public-API
// un-gate sequence (the chat-search / payment-webhook-safety pattern — no shared fixture touched);
// pinned phone-width viewport so the bottom tab bar is a real, visible surface (the chat-search
// pattern); tour-suppression beforeEach; email+password "Try another way" sign-in.

import { test, expect } from "@playwright/test";
import { AUTH_EMULATOR_HOST, API_BASE_URL, uniqueTestPhone } from "../fixtures.mjs";

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

/**
 * Create a FRESH, per-run account and walk it to FULLY COMPLETED: signUp on the Auth emulator, JIT
 * provision (GET /me), seed a valid E.164 phone (mandatory before onboarding-complete since TM-880),
 * mark onboarding complete, accept the current terms — the exact post-#587 global-setup sequence,
 * replicated inline so no shared helper/fixture is touched (the chat-search isolation pattern).
 * Returns the creds for the browser sign-in plus the account's own authed headers, so the spec can
 * later clear the phone AS THE ACCOUNT ITSELF (no admin backdoor).
 */
async function createCompletedAccount() {
  const email = `e2e-regate-${Date.now()}@teammarhaba.test`;
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
  const { idToken } = await signUpRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  const currentTermsVersion = (await meRes.json()).currentTermsVersion;

  // TM-934: a per-run-unique number so this fresh "completed" account never collides with a persona or
  // a prior run under the strict 1:1 uniqueness rule (V48 index). The test then CLEARS it (below) to
  // exercise the phone-less re-gate, so the specific value doesn't matter beyond being unique + valid.
  const phoneRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: uniqueTestPhone() }),
  });
  if (!phoneRes.ok) throw new Error(`seed phone failed for ${email}: ${phoneRes.status} ${await phoneRes.text()}`);

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

  return { email, password, authed };
}

test("@profile a COMPLETED account whose phone is cleared is re-gated on reload (TM-880 wiring)", async ({ page }) => {
  const account = await createCompletedAccount();

  // 1. Sign in through the real UI (email+password "Try another way" — the sibling specs' path).
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-in")).toBeVisible();

  // 2. CONTROL (the fail-before seam): with the phone still on record this completed account lands
  //    IN the app — no gate, tab bar shown. This proves the gate assertions below aren't vacuously
  //    true for this account (a "gate everyone" regression fails HERE; a "gate no one" one, below).
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
