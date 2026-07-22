import { test, expect } from "@playwright/test";
import admin from "firebase-admin";
import pg from "pg";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID, dbConfig, lettersOnlyStamp } from "../fixtures.mjs";

// TM-907 — the name lock, end to end through the REAL SPA + backend. A user who has real-world event
// history (here: a reliability strike, the same derived-live signal `NameLockService` reads) can no
// longer CHANGE an already-set first/last name: the Profile screen renders those fields READ-ONLY
// pre-emptively (not save-then-error) with a visible, screen-reader-announced explanation. A user with
// NO history edits their name freely (the current behaviour, preserved).
//
// The lock is DERIVED LIVE from event history, so we induce it the cheapest true way: set
// `users.late_cancel_count = 1` (a first-event no-show / late-cancel strike — one of the two documented
// lock triggers) directly in Postgres, then reload so a fresh GET /api/v1/me reports `nameLocked:true`.
// No mocking — the read-only state comes from the real backend flag through applyNameLock() in
// profile.js. The backend write-path refusals (422) are covered by NameLockIntegrationTest; this spec
// owns the web read-only UX contract + the carve-out.
//
// Account setup uses the SERVER-side onboarded-provision path (create in the Auth emulator → PATCH the
// mandatory phone → POST /me/onboarding-complete), NOT the onboarding UI. This mirrors the proven
// sms-signin-linked.spec.mjs pattern: an already-onboarded account cold-signs-in straight into the app
// with NO onboarding gate to drive, so the spec doesn't depend on the (fragile, TM-954-affected)
// completeOnboarding helper. Fresh per-run accounts (never-seen emails, their own uid + a per-test
// phone) mean the strike UPDATE only ever touches the throwaway account it just created — it can never
// lock a shared fixture.

/** The Admin SDK pointed at the emulator (create the throwaway accounts). Lazily inited + reused. */
function emulatorAuth() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  return admin.auth();
}

/** Mint an emulator ID token for an email/password account (the REST the SDK's sign-in wraps). */
async function idTokenFor(email, password) {
  const url = `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`emulator sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

/**
 * Create + provision an ONBOARDED email account via the backend (mirrors global-setup.provisionInBackend
 * + sms-signin-linked; TM-880 rule: PATCH /me {phone} BEFORE onboarding-complete). No first/last name is
 * set here — the account onboards NAMELESS (phone is the only mandatory profile field), so the spec can
 * then set a name from EMPTY while unlocked (exercising the carve-out) before inducing the lock.
 */
async function provisionOnboardedAccount(auth, { email, password, phone }) {
  await auth.createUser({ email, password, emailVerified: true });
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
  if (!onboard.ok) throw new Error(`onboarding-complete failed for ${email}: ${onboard.status} ${await onboard.text()}`);

  if (me.currentTermsVersion) {
    const terms = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version: me.currentTermsVersion }),
    });
    if (!terms.ok) throw new Error(`accept-terms failed for ${email}: ${terms.status} ${await terms.text()}`);
  }
}

/** Peek the emulator-delivered email code for a fresh address (same seam golden-path uses). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

// Per-test phone in the +447700900xxx range, distinct per call within a run (monotonic counter off a
// run-base) so no two provisioned accounts collide on a number.
const PHONE_RUN_BASE = Date.now();
let phoneSeq = 0;
function uniqueTestPhone() {
  const suffix = (PHONE_RUN_BASE + phoneSeq++) % 1000;
  return `+447700900${String(suffix).padStart(3, "0")}`;
}

/** Provision an ONBOARDED throwaway account, then cold email-code sign-in via the UI → lands in the app
 *  directly (no onboarding gate, since already onboarded). */
async function provisionAndSignIn(page, auth, email) {
  await provisionOnboardedAccount(auth, { email, password: "e2e-namelock-pw-123456", phone: uniqueTestPhone() });
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  const code = await peekCode(email);
  expect(code).toMatch(/^\d{6}$/);
  await page.fill("#emailcode-code", code); // TM-867: filling box 1 with the whole code auto-submits
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expectSignedIn(page);
}

/** Open #/profile and wait for the mount GET /api/v1/me to settle so fillForm has run. */
async function openProfileForm(page) {
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;
}

/** Set the caller's first/last name via the Profile form and save (run while still UNLOCKED). */
async function saveName(page, first, last) {
  await page.fill("#profile-firstName", first);
  await page.fill("#profile-lastName", last);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");
}

/** Force the account name-locked by giving it one reliability strike (a real lock trigger). */
async function strike(email) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rowCount } = await client.query(
      "UPDATE users SET late_cancel_count = 1 WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

test("@profile a name-locked user sees read-only name fields with an explanation", async ({ page }) => {
  const auth = emulatorAuth();
  const email = `e2e-namelock-${Date.now()}@teammarhaba.test`;
  const first = `Aisha${lettersOnlyStamp()}`;
  const last = `Khan${lettersOnlyStamp()}`;

  await provisionAndSignIn(page, auth, email);
  await openProfileForm(page);

  // Fail-before intent: while UNLOCKED the (currently empty) name is fully editable — set a real
  // first/last so there is a NON-EMPTY name for the lock to freeze (the carve-out only freezes set names).
  await expect(page.locator("#profile-firstName")).not.toHaveAttribute("aria-readonly", "true");
  await saveName(page, first, last);

  // Now induce the lock (one reliability strike) and re-open the profile → fresh /me reports nameLocked.
  await strike(email);
  await page.reload();
  await expectSignedIn(page);
  await openProfileForm(page);

  // Pass-after: the SET name fields are read-only (real readOnly property + aria-readonly for a11y),
  // the lock explanation is visible and announced, and the values are unchanged (not wiped).
  const firstInput = page.locator("#profile-firstName");
  const lastInput = page.locator("#profile-lastName");
  await expect(firstInput).toHaveAttribute("aria-readonly", "true");
  await expect(lastInput).toHaveAttribute("aria-readonly", "true");
  await expect(firstInput).toHaveJSProperty("readOnly", true);
  await expect(lastInput).toHaveJSProperty("readOnly", true);
  await expect(firstInput).toHaveValue(first);
  await expect(page.locator("#profile-namelock-note")).toBeVisible();
  await expect(page.locator("#profile-namelock-note")).toContainText("Names are locked after your first event");

  // The lock is name-scoped, not a whole-form freeze — a non-name field (age) stays editable.
  await expect(page.locator("#profile-age")).toHaveJSProperty("readOnly", false);
});

test("@profile an unlocked user (no event history) can edit their name freely", async ({ page }) => {
  const auth = emulatorAuth();
  const email = `e2e-nolock-${Date.now()}@teammarhaba.test`;
  const first = `Sara${lettersOnlyStamp()}`;

  await provisionAndSignIn(page, auth, email);
  await openProfileForm(page);

  // No history ⇒ not locked: the name fields carry no read-only semantics and no lock note shows.
  await expect(page.locator("#profile-firstName")).not.toHaveAttribute("aria-readonly", "true");
  await expect(page.locator("#profile-firstName")).toHaveJSProperty("readOnly", false);
  await expect(page.locator("#profile-namelock-note")).toBeHidden();

  // And an actual rename saves + persists — the current behaviour, preserved.
  await page.fill("#profile-firstName", first);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT first_name FROM users WHERE lower(email) = lower($1)", [email]);
    expect(rows[0].first_name).toBe(first);
  } finally {
    await client.end();
  }
});
