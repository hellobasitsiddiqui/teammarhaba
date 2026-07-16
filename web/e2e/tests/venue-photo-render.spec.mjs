import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ADMIN } from "../fixtures.mjs";

// ── Venue photos actually RENDER in the admin console (TM-711) — e2e against the REAL browser + full
// stack (backend + Firebase Auth + Storage emulators + Postgres, per web/e2e/README.md), signed in as
// the seeded ADMIN.
//
// THE BUG (TM-711): a venue's photo was uploaded to Firebase Storage at `venue-images/{id}` and its
// object PATH persisted as `photoPath`, but that field was WRITE-ONLY — nothing ever consumed it, so an
// uploaded venue photo showed up NOWHERE. The confirmed twin of the TM-708 event-image bug.
//
// THE FIX (e8da926): resolve `photoPath` to a fresh download URL (storage.js `downloadUrlForPath`) at
// render time in TWO places, via a new pure `venueImageRef` classifier:
//   • venues LIST — a small square thumbnail per row (`img.tm-venue-thumb-img`), placeholder box when
//     absent, never a broken <img>.
//   • edit FORM  — seed the photo preview (`.tm-event-image-img`) from the existing photo when no new
//     file has been picked.
//
// These two specs drive the FULL round-trip through the UI (no API short-cut for the photo — the photo
// is uploaded through the create form so `photoPath` is set the way production sets it), then assert the
// SPECIFIC fixed behaviour:
//   SPEC 1 — after creating a venue WITH a photo, the list row shows an <img> whose src is a RESOLVED
//            Storage download URL for `venue-images/{id}` (the thing that rendered NOWHERE before).
//   SPEC 2 — opening that venue's Edit form seeds the photo preview <img> from the stored path (hidden
//            before the fix), and the "A photo is already set" hint appears.
//
// FAIL-BEFORE / PASS-AFTER: on `main` (fixed) these pass. Revert e8da926 (drop `venueThumb` from
// renderTable + the buildPhotoControl preview seed) and no `<img>` is emitted for the venue photo in
// either place — every image assertion below fails. That is the honest before/after evidence.
//
// Both reuse the harness's seeded ADMIN (global-setup.mjs grants the role=ADMIN custom claim so
// #nav-admin-venues appears, the /api/v1/admin/venues routes authorize, AND `venue-images/{id}` is an
// allowed Storage write per storage.rules). The Storage emulator (127.0.0.1:9199) is started by the e2e
// workflow / `npm run emulator` (--only auth,storage) — the same seam avatar-upload.spec.mjs relies on.

// A tiny but valid 1x1 PNG (transparent), base64 — the uploaded venue-photo bytes (mirrors
// avatar-upload.spec.mjs; validateVenueImageFile accepts any image/* under 5 MB).
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// Suppress the first-run product tour so its dimmed overlay/backdrop can't cover the controls under
// test — the identical localStorage init-script every other admin spec uses (TM-147).
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

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop. */
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

/** Sign in as the seeded ADMIN via the email+password path under "Try another way" (the flow every
 *  admin spec uses), then wait until the admin nav resolves. Leaves the browser on the home view. */
async function signInAsAdmin(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page); // phone: the admin nav link lives behind the hamburger — open it before asserting
  await expect(page.locator("#nav-admin-venues")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

/** Open the venues console from the nav and wait for the list panel to render. */
async function openVenuesConsole(page) {
  await openNav(page);
  await page.locator("#nav-admin-venues").click();
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  await expect(page.locator("#admin-venues-view")).toBeVisible();
}

/**
 * Create a venue THROUGH the console UI, picking a photo in the form so the full production path runs:
 * POST /admin/venues → upload bytes to `venue-images/{id}` (Storage emulator) → PATCH photoPath. Returns
 * the created VenueResponse (its `id` is used to anchor the list row). Drives the same form the admin
 * uses; the only non-UI step is the emulator sign-in the caller does first.
 */
async function createVenueWithPhotoViaUi(page, name, city) {
  await page.click("#admin-venues-new");
  await expect(page).toHaveURL(/#\/admin\/venues\/new$/);
  await expect(page.locator("#venue-form")).toBeVisible();

  await page.fill("#venue-name", name);
  await page.fill("#venue-address", `${name}, 1 Test Street`);
  await page.fill("#venue-city", city);

  // Pick the photo — the file control must be enabled, i.e. Storage is configured in this environment.
  const fileInput = page.locator("#venue-image-file");
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({
    name: "venue.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });

  // The create response tells us the venue id (used to target its list row / edit route). The photo is
  // uploaded + PATCHed by the app AFTER this 201, so we still wait to be back on the list before asserting.
  const createResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/admin/venues") && r.request().method() === "POST",
  );
  await page.click("#venue-save");
  const createRes = await createResponse;
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  expect(created.name).toBe(name);

  // Saving returns to the list (TM-519). Wait for it before reading the row.
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  await expect(page.locator("#admin-venues-view")).toBeVisible();
  return created;
}

// ────────────────────────────────────────────────────────────────────────
// SPEC 1 — TM-711 (the AC): an uploaded venue photo RENDERS as a thumbnail in the list row.
// ────────────────────────────────────────────────────────────────────────
test("@admin @venues an uploaded venue photo renders as a list thumbnail (TM-711)", async ({ page }, testInfo) => {
  const NAME = `E2E Venue TM711 ${randomUUID().slice(0, 8)}`;
  const CITY = "London";

  await signInAsAdmin(page);
  await openVenuesConsole(page);

  // Create the venue WITH a photo, through the form — this uploads to `venue-images/{id}` and PATCHes
  // photoPath, exactly as production does. `created.id` anchors the row we assert on.
  const created = await createVenueWithPhotoViaUi(page, NAME, CITY);

  const row = page.locator(`tr[data-venue-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(NAME);

  // THE FIX: the row's Venue cell now renders a resolved thumbnail <img>. Before e8da926 the cell held
  // only the name/address text — NO <img> — so this locator matched nothing. Wait for the async
  // downloadUrlForPath(photoPath) resolution to swap the src in.
  const thumb = row.locator("img.tm-venue-thumb-img");
  await expect(thumb).toBeVisible();

  // The src is a RESOLVED Firebase Storage download URL for the venue's object path — NOT the raw
  // `venue-images/7` string, and not empty. The Storage emulator serves download URLs from its own host
  // via the v0 API, with the object path URL-encoded (`venue-images%2F…`) — the same shape avatar-upload
  // asserts for `avatars%2F`. This proves photoPath was actually resolved & rendered, the crux of TM-711.
  await expect
    .poll(async () => (await thumb.getAttribute("src")) || "")
    .toContain("/v0/b/");
  const src = (await thumb.getAttribute("src")) || "";
  expect(src).toContain("venue-images%2F");
  expect(src).not.toBe(created.photoPath); // resolved to a URL, not the raw stored path

  // And the bytes are actually fetchable (HTTP 200) — a rendered, non-broken image, not a dangling ref.
  const status = await page.evaluate(async (url) => (await fetch(url)).status, src);
  expect(status).toBe(200);

  await page.screenshot({
    path: testInfo.outputPath("venue-list-thumbnail.png"),
    fullPage: true,
  });
});

// ────────────────────────────────────────────────────────────────────────
// SPEC 2 — TM-711 (edit form): the existing photo seeds the Edit form's preview.
// ────────────────────────────────────────────────────────────────────────
test("@admin @venues editing a venue seeds its photo preview from the stored path (TM-711)", async ({ page }, testInfo) => {
  const NAME = `E2E Venue TM711edit ${randomUUID().slice(0, 8)}`;
  const CITY = "London";

  await signInAsAdmin(page);
  await openVenuesConsole(page);

  const created = await createVenueWithPhotoViaUi(page, NAME, CITY);

  // Open the row's Edit → the full-page edit form, prefilled from the venue.
  const row = page.locator(`tr[data-venue-id="${created.id}"]`);
  await row.getByRole("button", { name: `Edit ${NAME}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/admin/venues/${created.id}/edit$`));
  await expect(page.locator("#venue-form")).toBeVisible();
  await expect(page.locator("#venue-name")).toHaveValue(NAME); // prefilled — right venue

  // THE FIX: with a stored photoPath and NO new file picked, buildPhotoControl seeds the preview from the
  // existing photo — resolving photoPath to a download URL and unhiding the preview <img>. Before e8da926
  // the preview stayed `hidden` (the field was write-only), so an admin editing a venue never saw its
  // current photo.
  const preview = page.locator(".tm-event-image-frame .tm-event-image-img");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => (await preview.getAttribute("src")) || "")
    .toContain("/v0/b/");
  const src = (await preview.getAttribute("src")) || "";
  expect(src).toContain("venue-images%2F");

  // The "a photo is already set" affordance also confirms the form knows this venue has a photo — the
  // hint copy the fix's `hasExisting` branch renders.
  await expect(page.locator("#venue-image-hint")).toContainText("A photo is already set");

  await page.screenshot({
    path: testInfo.outputPath("venue-edit-preview.png"),
    fullPage: true,
  });
});
