import { test, expect } from "@playwright/test";
import pg from "pg";
import { API_BASE_URL, dbConfig } from "../fixtures.mjs";

// Golden-path end-to-end journey (TM-341) — ONE long happy-path run that walks the whole core
// experience in a single test, as living evidence the product works front-to-back:
//
//   sign in (email-code) → first-login ONBOARDING gate (TM-250) → TERMS gate (TM-170) →
//   edit PROFILE (save + DB persist, TM-167) → AVATAR upload (TM-166) → RE-UPLOAD a second avatar
//   and assert it still loads (TM-335 regression) → browse HOME (+ ADMIN console if the account is
//   admin) → open HELP + the annotated VISUAL guide (TM-255/TM-178) → SIGN OUT.
//
// Deterministic against the seeded Firebase emulator: we sign in a BRAND-NEW email-code address
// (never seen ⇒ always un-onboarded ⇒ always hits both first-run gates), so the journey exercises
// onboarding + terms every run rather than depending on seeded-account state. The account is a
// normal (non-admin) user, so the admin step is conditionally skipped ("+ admin console IF admin")
// — the shared seeded ADMIN already has dedicated admin coverage (admin-walkthrough.spec.mjs).
//
// Project-agnostic (TM-341 requirement): runs under BOTH the desktop `chromium` and the phone
// `mobile-chromium` Playwright projects (see playwright.config.mjs). Every nav interaction goes
// through openNav()/clickNav() helpers that open the hamburger first when it's collapsed (mobile
// width) and no-op on desktop — so the same spec proves the happy path on desktop AND mobile web.
//
// Reuses the exact helpers/selectors of its siblings so it stays in sync:
//   • the tour-suppression init-script (email-code / onboarding / terms / responsive specs),
//   • the /auth/email-code/peek code-read + fresh-user sign-in (onboarding / terms specs),
//   • the #profile-form / #profile-avatar-file / photoURL assertions (profile-edit / avatar specs),
//   • the #help-view / .tm-guide-* visual-guide assertions (help-and-byline spec),
//   • the DB persistence check via `pg` + dbConfig (onboarding / terms / profile specs).
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we ALSO take an explicit screenshot at
// each major step so the run yields a step-by-step visual trail of the journey (TM-341 requirement).

// A tiny but valid 1x1 PNG (transparent), base64 — the first uploaded avatar's bytes. Matches the
// avatar-upload spec's fixture so both exercise the same Storage-emulator path.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
// A second, distinct-but-valid 1x1 PNG (red pixel) — the re-upload's bytes must differ so the
// TM-335 self-delete regression is actually exercised (same fixture as avatar-upload.spec.mjs).
const RED_PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Suppress the first-run product tour (TM-147) so its dimmed overlay/backdrop can't cover the
// controls under test — the identical localStorage init-script every other spec uses.
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

/** Sign in a fresh email-code user (a never-seen address ⇒ a brand-new, un-onboarded account).
 *  Same flow as the onboarding-gate / terms-gate specs. Waits only for the viewport-independent
 *  "signed in" signal: the signed-OUT login panel disappearing (#signout-btn lives inside the
 *  collapsed hamburger at a phone width, so its visibility can't be the gate — see the mobile spec). */
async function signInFreshUser(page, email) {
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
  await page.fill("#emailcode-code", code);
  await page.click("#emailcode-verify-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

/** Open the account nav if it's currently collapsed behind the hamburger (phone width); a no-op at a
 *  desktop width where the links are always laid out. Project-agnostic: at a phone viewport the nav
 *  carries data-nav-open="false" until the toggle is clicked (TM-229 nav-toggle.js); on desktop the
 *  toggle is display:none, so we simply skip it. */
async function openNav(page) {
  const toggle = page.locator("#nav-toggle");
  if (await toggle.isVisible()) {
    const nav = page.locator(".app-nav");
    if ((await nav.getAttribute("data-nav-open")) !== "true") {
      await toggle.click();
      await expect(nav).toHaveAttribute("data-nav-open", "true");
    }
  }
}

/** Click a nav link/button by id, opening the hamburger first when needed. Works under both projects:
 *  clicking a nav item closes the mobile menu automatically (nav-toggle.js) and is a plain click on
 *  desktop. Waits for the target to be visible after opening so the click can't race the CSS reveal. */
async function clickNav(page, selector) {
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

test("@golden the whole happy path: sign in → onboarding → terms → profile → avatar → home → help → sign out", async ({
  page,
}, testInfo) => {
  // Unique per run so a stale peek code / DB row from a prior run can't bleed in, and so the address
  // is guaranteed never-seen (⇒ un-onboarded ⇒ both first-run gates fire).
  const stamp = Date.now();
  const email = `e2e-golden-${stamp}@teammarhaba.test`;
  const location = `Goldenville-${stamp}`;
  const city = `Golden-City-${stamp}`;

  // A step screenshot helper: an explicit, named shot per major step (on top of the global
  // screenshot:"on"), so the run's artifacts read as a step-by-step trail of the journey.
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`golden-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // ── STEP 1: sign in via the email-code default front door (TM-234). ──────────────────────────
  await signInFreshUser(page, email);
  await shot("signed-in");

  // ── STEP 2: first-login ONBOARDING gate (TM-250) — complete the profile gate to pass it. ─────
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-form")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  await shot("onboarding-gate");
  await page.fill("#onboarding-name", "Golden Tester");
  await page.fill("#onboarding-location", location);
  await page.fill("#onboarding-age", "29");
  const onboarded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await onboarded;

  // ── STEP 3: TERMS gate (TM-170) — the second gate; accept the current version to enter. ──────
  await expect(page.locator("#terms-view")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  await expect(page.locator("#terms-version")).toBeVisible();
  await shot("terms-gate");
  const acceptedTerms = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/accept-terms") && r.request().method() === "POST",
  );
  await page.click("#terms-accept");
  await acceptedTerms;

  // Both gates cleared → the app home view shows and the nav links return.
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#terms-view")).toBeHidden();
  await shot("entered-app");

  // ── STEP 4: edit PROFILE (TM-167) — change a couple of fields, save, and assert DB persistence. ─
  // Arm the profile-mount GET /me wait BEFORE navigating (TM-198 lesson — the form populates async
  // from that GET and would otherwise clobber what we type). Nav via the project-agnostic helper.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await clickNav(page, "#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;

  await page.fill("#profile-city", city);
  await page.selectOption("#profile-notificationPref", "BOTH");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");
  await shot("profile-saved");

  // It persisted: the users row carries the new city + preference.
  {
    const client = new pg.Client(dbConfig);
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT city, notification_pref FROM users WHERE lower(email) = lower($1)",
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].city).toBe(city);
      expect(rows[0].notification_pref).toBe("BOTH");
    } finally {
      await client.end();
    }
  }

  // ── STEP 5: AVATAR upload (TM-166) — pick an image; photoURL is set + shown. ──────────────────
  const fileInput = page.locator("#profile-avatar-file");
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({
    name: "avatar-1.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Avatar updated");
  const previewImg = page.locator(".tm-profile-avatar .tm-avatar-img");
  await expect(previewImg).toBeVisible();
  const firstURL = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(firstURL).toBeTruthy();
  expect(firstURL).toContain("avatars%2F"); // the per-uid object path, URL-encoded.
  await shot("avatar-first");

  // ── STEP 6: RE-UPLOAD a second, distinct avatar and assert it STILL loads (TM-335 regression). ─
  // The object path is fixed per-uid, so this overwrites `avatars/{uid}`. The old cleanup deleted
  // the object it had just uploaded, so the second avatar 404'd — this proves it doesn't anymore.
  await fileInput.setInputFiles({
    name: "avatar-2.png",
    mimeType: "image/png",
    buffer: Buffer.from(RED_PNG_1x1_BASE64, "base64"),
  });
  // Wait for the second upload's updateProfile to actually land (photoURL changes).
  await expect
    .poll(async () => page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null))
    .not.toBe(firstURL);
  const finalURL = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(finalURL).toBeTruthy();
  expect(finalURL).toContain("avatars%2F");
  // The crux: the object the final photoURL points at must still EXIST (HTTP 200, not 404).
  const status = await page.evaluate(async (url) => (await fetch(url)).status, finalURL);
  expect(status).toBe(200);
  // ...and it renders in the UI (preview reflects the new URL) rather than the fallback glyph.
  await expect(previewImg).toHaveAttribute("src", finalURL);
  await shot("avatar-reuploaded");

  // ── STEP 7: browse HOME (+ ADMIN console IF this account is admin). ───────────────────────────
  // There's no dedicated "Home" nav link — home is #/home (the signed-in landing, #auth-signed-in).
  // Navigate by hash without a full reload (same approach as the responsive-mobile spec) to avoid the
  // guard's sign-in bounce, then assert the home view is shown.
  await page.evaluate(() => (window.location.hash = "#/home"));
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await shot("home");

  // Conditionally exercise the admin console — only shown for a ROLE_ADMIN (the router removes the
  // link's `hidden` attribute). This journey's fresh user is a normal user, so this branch is
  // skipped here; the seeded ADMIN's console has dedicated coverage in admin-walkthrough.spec.mjs.
  const navAdmin = page.locator("#nav-admin");
  const adminHidden = await navAdmin.getAttribute("hidden");
  if (adminHidden === null) {
    await clickNav(page, "#nav-admin");
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();
    await shot("admin-console");
  }

  // ── STEP 8: open HELP + the annotated VISUAL guide (TM-255 / TM-178). ─────────────────────────
  await clickNav(page, "#nav-help-link");
  const help = page.locator("#help-view");
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "Help" })).toBeVisible();
  // The annotated visual guide: the "Visual guide" heading, the drawn mock stage with accessible alt
  // text, at least one positioned callout, and the linear notes restatement (mirrors help spec).
  await expect(help.getByRole("heading", { name: "Visual guide" })).toBeVisible();
  const stage = help.locator(".tm-guide-stage").first();
  await expect(stage).toBeVisible();
  await expect(stage).toHaveAttribute("aria-label", /mock of the TeamMarhaba home screen/i);
  await expect(help.locator(".tm-guide-callout").first()).toBeVisible();
  await expect(help.locator(".tm-guide-notes li").first()).toBeVisible();
  await shot("help-visual-guide");

  // ── STEP 9: SIGN OUT → back to the login view. ───────────────────────────────────────────────
  await clickNav(page, "#signout-btn");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await shot("signed-out");
});
