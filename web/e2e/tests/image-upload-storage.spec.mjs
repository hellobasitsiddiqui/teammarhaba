import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";

// Event image upload round-trip through the ADMIN form — the BROWSER-level guard TM-704 needed.
//
// The prod outage (TM-704): admin event-image (TM-392) and venue-photo (TM-519) uploads were denied
// because the *released* Firebase Storage ruleset was frozen at the avatars-only TM-184 deploy — the
// CD `--only storage` step 403'd on the serviceusage pre-check and was silently skipped behind a green
// hosting deploy, so `event-images/` and `venue-images/` never reached prod. Those paths hit
// default-deny, and every admin event/venue image upload failed with `storage/unauthorized` — the
// event row was created but the image never persisted, and the form toasted "…created, but the image
// didn't upload".
//
// WHY THE EXISTING SPECS DIDN'T CATCH IT:
//   • events.spec.mjs sets `imagePath` as a STRING via the admin API (TM-392 is API-only) — no bytes
//     ever hit Storage, so the `event-images/` rule is never exercised.
//   • admin-events.spec.mjs drives the create/edit/cancel lifecycle but explicitly uploads NO image
//     ("the image path is a separate Storage-emulator concern").
//   • storage-rules.mjs (TM-704) verifies the rules at the rules layer (rules-unit-testing), but not
//     the real browser → form → Storage → PATCH round-trip the admin actually performs.
//
// DISTINCT FROM the committed RENDER specs (event-image-render.spec.mjs / venue-photo-render.spec.mjs,
// TM-708): those upload real bytes then assert the resolved <img> src + HTTP 200 — the RENDER half.
// NEITHER asserts the exact TM-704 user-facing symptom: the form's TOAST. Under the stale avatars-only
// rules the upload is default-denied (`storage/unauthorized`) and the create path toasts
// "Event created, but the image didn't upload …" with NO imagePath persisted; under the fixed rules it
// toasts a plain "Event created." and PATCHes `event-images/{id}`. This spec's headline is that
// inverted toast + persisted-path signal — the "uploads must work" AC at the layer the outage
// manifested — with a light resolved+fetchable render check to also cover "must render".
//
// It picks a REAL image file in the admin New-event form and drives the full upload through the Storage
// EMULATOR — loaded with the committed repo-root storage.rules (the fixed ruleset that HAS the
// `event-images/` block; see e2e.yml). Fail-before / pass-after: on the stale rules the write is denied,
// the "didn't upload" error toast fires, the success toast never appears and no path is PATCHed — every
// assertion below goes RED. After the fix the write is allowed and they go GREEN.
//
// Hermetic (mirrors avatar-upload.spec.mjs): Auth + Storage both run against local emulators. No real
// Firebase project is touched. Signs in as the seeded ADMIN (global-setup grants it the role=ADMIN
// custom claim — the exact gate `event-images/` writes require).

// A tiny but valid 1x1 PNG (transparent), base64 — the uploaded event-image bytes (as in avatar-upload).
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// A unique heading per run so the list row + edit route are unambiguous across shared-DB CI runs.
const HEADING = `E2E Storage Upload ${Date.now()}`;

// Suppress the first-run product tour so its dimmed backdrop can't cover the controls under test — the
// identical localStorage init-script every other spec uses (TM-147).
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

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop
 *  width. Copied from admin-events/golden-path so the spec is project-agnostic across projects. */
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

/** Click a nav link/button by id, opening the hamburger first when needed. */
async function clickNav(page, selector) {
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

/** A `<input type="datetime-local">` value ("YYYY-MM-DDTHH:mm") from a Date's UTC parts — paired with
 *  the UTC timezone on the event so wall-clock entered == UTC instant stored (predictable status). */
function localValue(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

/** Sign in as the seeded ADMIN (email+password under "Try another way"), mirroring admin-events.spec. */
async function signInAsAdmin(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page); // phone: the admin nav link lives behind the hamburger — open it before asserting
  await expect(page.locator("#nav-admin")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

test("@admin @admin-events @image-upload admin uploads an event image; it stores (rules allow it) and renders", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`image-upload-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // Dates relative to now so the derived status is stable: visibility window already open, start in the
  // future ⇒ the list shows "Visible". Event timezone = UTC so wall-clock == instant (admin-events.spec).
  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const end = new Date(now + 30 * 864e5 + 2 * 36e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 60 * 864e5);

  // ── STEP 1: sign in as the seeded ADMIN. ──────────────────────────────────────────────────────────
  await signInAsAdmin(page);

  // ── STEP 2: open the events console via the hub (TM-937), then the New-event form (TM-426). ──────
  await clickNav(page, "#nav-admin");
  await page.click('.admin-hub-row[href="#/admin/events"]');
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await page.click("#admin-events-new");
  await expect(page).toHaveURL(/#\/admin\/events\/new$/);
  await expect(page.locator("#event-form")).toBeVisible();

  // The event-image control must be ENABLED — Storage is configured (the emulator bucket is injected by
  // serve.mjs). If Storage were unconfigured the control disables + hints "…aren't available", so this
  // also proves the harness is exercising the real upload path, not the graceful-degradation stub.
  const imageInput = page.locator("#event-image-file");
  await expect(imageInput).toBeEnabled();

  // ── STEP 3: fill the required fields (heading/description/location/timezone/start/visibility). ─────
  await page.fill("#event-heading", HEADING);
  await page.fill("#event-description", "An event WITH an uploaded image — proves the Storage rules allow event-images/.");
  await page.fill("#event-location", "Marhaba Community Hall, 1 Test Street");
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-end", localValue(end));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));

  // ── STEP 4: PICK an image — held pending, uploaded on save against the (now-existing) event id. ────
  // A local object-URL preview appears immediately (no upload yet); the bytes go up when we save.
  await imageInput.setInputFiles({
    name: "event.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });
  // No inline validation error (a valid image), and the preview is now shown (object-URL, pre-upload).
  await expect(page.locator("#event-image-error")).toBeHidden();
  await expect(page.locator(".tm-event-image-img")).toBeVisible();
  await shot("form-with-image");

  // ── STEP 5: save → POST create, then the REAL upload to event-images/{id}, then the imagePath PATCH.
  // The Storage upload (uploadBytesResumable) targets the Storage EMULATOR loaded with the committed
  // storage.rules. Under the STALE avatars-only rules this write is default-denied (storage/unauthorized)
  // and the form toasts "Event created, but the image didn't upload …" with NO imagePath persisted.
  // Under the fix the write is allowed, the path is PATCHed, and the success toast is "Event created.".
  const createResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const created = await (await createResponse).json();
  expect(created.heading).toBe(HEADING);
  expect(created.id).toBeTruthy();

  // The imagePath-PATCH that only fires AFTER a SUCCESSFUL upload (a denied upload skips it entirely).
  const patchResponse = await page.waitForResponse(
    (r) => r.url().includes(`/api/v1/admin/events/${created.id}`) && r.request().method() === "PATCH",
  );
  const patched = await patchResponse.json();
  // The persisted pointer is the per-event Storage object PATH (not a URL) — the write landed.
  expect(patched.imagePath).toBe(`event-images/${created.id}`);

  // ── STEP 6: the SUCCESS toast (the exact signal the outage inverted). ─────────────────────────────
  // Before the fix this was the ERROR toast "Event created, but the image didn't upload"; after the fix
  // it's the plain success. Assert success shows AND the "didn't upload" error never appears.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Event created.");
  await expect(page.locator("#tm-toasts")).not.toContainText("didn't upload");
  // Saving navigates back to the list; the event lands there with its derived "Visible" status.
  await expect(page).toHaveURL(/#\/admin\/events$/);
  const row = page.locator(`tr[data-event-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(HEADING);
  await shot("created");

  // ── STEP 7: it RENDERS — re-open the event; the edit form resolves the persisted event-images/{id}
  // path to a fresh Storage download URL (downloadUrlForPath, TM-708) and shows it in the preview. A
  // stale ruleset that denied the write would have persisted NO path, so nothing would resolve here. ─
  await row.getByRole("button", { name: `Edit ${HEADING}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/admin/events/${created.id}/edit$`));
  await expect(page.locator("#event-heading")).toHaveValue(HEADING);

  const preview = page.locator(".tm-event-image-img");
  await expect(preview).toBeVisible();
  // The resolved src is a REAL Storage-emulator download URL for THIS event's object — not the local
  // object-URL preview, not a placeholder. The emulator serves download URLs from its own host via the
  // v0 API (same shape avatar-upload.spec asserts), carrying the url-encoded `event-images/{id}` path.
  await expect
    .poll(async () => preview.getAttribute("src"))
    .toContain("/v0/b/");
  const src = await preview.getAttribute("src");
  expect(src).toContain(`event-images%2F${created.id}`);

  // The crux of "uploads must work + render": the object the preview points at must actually EXIST —
  // fetch it and assert HTTP 200 (the bytes are there), not a 403/404 the stale rules would have caused.
  const status = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.status;
  }, src);
  expect(status).toBe(200);
  await shot("renders");
});
