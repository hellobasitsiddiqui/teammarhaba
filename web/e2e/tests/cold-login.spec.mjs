import { test, expect } from "@playwright/test";
import { API_BASE_URL, EVENT_GOER } from "../fixtures.mjs";

// COLD email-code login (TM-738) — the gold-standard auth journey: sign in from a FULLY SIGNED-OUT
// state (no cached Firebase token, auth storage cleared) and prove the user boots all the way into
// the app on HOME, not the login screen. This is the cold-vs-warm distinction: a warm login only
// restores an existing session (and can hide a broken cold path); a cold login exercises the whole
// enter-email → get-code → authenticate → route-to-home path from scratch.
//
// It is a deliberate complement to email-code-login.spec.mjs (which signs in a fresh, never-seen
// address and only asserts the signed-IN panel). Here we:
//   1. establish + ASSERT the cold precondition — clear every Firebase auth-persistence seam
//      (localStorage `firebase:authUser:*` + the `firebaseLocalStorageDb` IndexedDB) and confirm the
//      app boots to the SIGNED-OUT login form;
//   2. sign in via the email-code front door (backend "emails" a 6-digit code → the emulator-only
//      peek endpoint hands it to us → verify → custom-token sign-in);
//   3. assert boot into HOME (#auth-signed-in), with NEITHER first-run gate (onboarding / terms)
//      intercepting and the login form gone.
//
// We sign in as the SEEDED, already-onboarded + terms-accepted EVENT_GOER (global-setup provisions
// it un-gated, so the guard routes it straight to #/home — see router.js: a signed-in user on
// #/login lands on HOME by role). A brand-new address would instead hit the onboarding gate, so it
// could never assert "reaches Home" — hence a returning, complete account is the right fixture here.
// The email is fixed (deterministic — uniqueness comes from the fixture, not a timestamp): the peek
// endpoint keys on the address and returns the LAST code emailed to it, so a fresh request each run
// is self-contained even with a stable email.
//
// Emulator-only, hermetic: no real email/SMS, no secrets, no test-login backdoor. Same Firebase Auth
// emulator + peek endpoint every other @auth spec uses.

// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the controls —
// the identical localStorage init-script every other auth spec uses.
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

/** Read the last code the backend "emailed" to an address (emulator-only peek endpoint). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Wipe every Firebase auth-persistence backend so the next load is a genuine COLD start (no cached
 * user, no token to silently restore). auth.js persists to localStorage (`firebase:authUser:*`)
 * first, then falls back to IndexedDB (`firebaseLocalStorageDb`), so we clear BOTH — otherwise a
 * leftover session from a prior run/step could warm-restore and mask a broken cold login. Runs in
 * the page after a first navigation (storage APIs need an origin). Returns once the IndexedDB delete
 * has actually completed so the subsequent reload can't race a half-cleared store.
 */
async function clearAuthStorage(page) {
  await page.evaluate(async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage may be unavailable in a locked-down context — non-fatal for the cold intent. */
    }
    // Delete Firebase's IndexedDB persistence store and wait for the request to settle (success,
    // error, or blocked) so we don't reload mid-delete.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const req = indexedDB.deleteDatabase("firebaseLocalStorageDb");
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish;
      } catch {
        finish();
      }
      // Safety net: never hang the test if the delete callbacks don't fire.
      setTimeout(finish, 2000);
    });
  });
}

test("@auth cold login: from a fully signed-out state, an emailed code signs the user in and boots them into Home", async ({
  page,
}) => {
  const email = EVENT_GOER.email;

  // ── Establish the COLD precondition ──────────────────────────────────────────────────────────
  // Land on the app once (so storage APIs have an origin), wipe every auth-persistence seam, then
  // reload: this is the "fully signed-out, no cached token" start the cold path must exercise.
  await page.goto("/#/login");
  await clearAuthStorage(page);
  await page.reload();

  // ASSERT the precondition held: the app boots to the SIGNED-OUT login form, not a restored session.
  // (A warm/restored session would have routed us to #auth-signed-in instead — this proves it didn't.)
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  await expect(page.locator("#signout-btn")).toBeHidden();
  // The email-code front door is the default (password field hidden until "try another way").
  await expect(page.locator("#emailcode-send-btn")).toBeVisible();

  // ── Step 1: request the code. Wait for the request POST to settle before peeking. ────────────
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;

  // The code step is now shown and names the address we're signing in.
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  await expect(page.locator("#emailcode-sent-to")).toHaveText(email);

  // ── Step 2: fetch the issued code and enter it → the backend verifies + mints a custom token → ─
  //           the client signs in with it (signInWithCustomToken). TM-867: filling the first OTP
  //           box with the whole code distributes across the six boxes + AUTO-submits (no click).
  const code = await peekCode(email);
  expect(code).toMatch(/^\d{6}$/);
  await page.fill("#emailcode-code", code);

  // ── Boots into the app: the sign-out control appears and the signed-out form is gone. ────────
  await expect(page.locator("#signout-btn")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── The crux: HOME, not a gate. EVENT_GOER is already onboarded + terms-accepted, so the guard
  //    routes it straight to #/home (router.js: a signed-in user on #/login lands on HOME by role).
  //    Assert the Home view is showing AND neither first-run gate (onboarding / terms) intercepted —
  //    which is what distinguishes "reached the app" from merely "authenticated".
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#terms-view")).toBeHidden();
  // The signed-in Home carries the "Events near you" feed container (data-testid from index.html).
  await expect(page.locator('[data-testid="home-feed"]')).toBeVisible();
  // ...and the router settled on the home route (not left on #/login).
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/home");
});
