import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Event-image RENDER round-trip (TM-708) — the behavioural gate for the "uploaded event images never
// showed" bug. The defect: the admin upload persists a Firebase Storage OBJECT PATH as the event's
// `imagePath` (e.g. `event-images/{id}`), but the detail-hero renderer only accepted an `^https?://`
// URL and never resolved a storage path via getDownloadURL() — so an uploaded image silently never
// rendered (just the plain placeholder box). The fix (events-core.eventImageRef +
// storage.downloadUrlForPath, wired into events.js `detailHero`) classifies the path and resolves it
// to a fresh download URL at render time.
//
// This proves the WHOLE path honestly, no invented seed endpoint:
//   sign in as ADMIN → create an event through the console form AND upload a real PNG through the image
//   control (the bytes land in the Firebase Storage EMULATOR at `event-images/{id}`, and the follow-up
//   PATCH persists that STORAGE PATH as imagePath — exactly the shape that used to break) → open that
//   event's detail page → the hero <img> gets a RESOLVED src pointing at the Storage emulator, and those
//   bytes are actually fetchable (HTTP 200) → and the persisted DB row holds a storage PATH (not a URL),
//   confirming render had to resolve a path, which is the thing that regressed.
//
// Fail-before / pass-after: on the pre-fix renderer no <img> is ever created for a storage-path
// imagePath (only `^https?://` rendered), so `.tm-event-hero-img` never appears / never gets a src —
// this spec's hero-image assertions go RED. After the fix the path resolves and the <img> shows — GREEN.
//
// Hermetic: Auth + Storage both run against local emulators (web/e2e/firebase.json + serve.mjs's
// injected config, exactly as avatar-upload.spec.mjs relies on). No real Firebase project is touched.
// event-images/{id} is public-read + ADMIN-write in storage.rules, so the ADMIN uploads it and the
// download URL resolves for the reader.

// A tiny but valid 1x1 PNG (transparent), base64 — the uploaded event-image bytes (same fixture the
// avatar-upload walkthrough uses). Real bytes matter here: getDownloadURL() only resolves for an object
// that actually EXISTS, so seeding a bare path with no bytes would (correctly, post-fix) fall back to
// the placeholder and prove nothing. Uploading real bytes is what makes the resolved-src assertion mean
// "the fix works" rather than "the object was missing".
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// Suppress the first-run product tour so its dimmed overlay/backdrop can't cover the controls under
// test — the identical localStorage init-script every other spec uses (TM-147).
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
 *  width. Copied from admin-events/golden-path so the spec is project-agnostic. */
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
 *  the UTC timezone on the event, so the wall-clock entered equals the UTC instant stored. Copied from
 *  admin-events.spec.mjs. */
function localValue(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

// A unique heading per run so the row + DB row are unambiguous across shared-DB runs / retries.
const HEADING = `E2E Image Event ${Date.now()}`;

test("@events @event-image an uploaded event image renders on the detail page (TM-708 path→URL)", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`event-image-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // Dates relative to now so the event is visible-now (window already open, start in the future) — the
  // creator (ADMIN) can browse to it straight after creating. Event timezone = UTC so wall-clock ==
  // instant (predictable, like admin-events.spec.mjs).
  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const end = new Date(now + 30 * 864e5 + 2 * 36e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 60 * 864e5);

  // ── STEP 1: sign in as the seeded ADMIN (email+password under "Try another way"). ────────────────
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page); // phone: the admin nav link lives behind the hamburger — open it before asserting
  await expect(page.locator("#nav-admin-events")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── STEP 2: open the events console → New event form. ────────────────────────────────────────────
  await clickNav(page, "#nav-admin-events");
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await page.click("#admin-events-new");
  await expect(page).toHaveURL(/#\/admin\/events\/new$/);
  await expect(page.locator("#event-form")).toBeVisible();

  // ── STEP 3: fill the form (a minimal visible-now event) AND pick an image. ───────────────────────
  await page.fill("#event-heading", HEADING);
  await page.fill("#event-description", "An event whose uploaded image must actually render.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.fill("#event-city", "London");
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-end", localValue(end));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));
  await page.fill("#event-capacity", "20");

  // Pick a real image — the change handler stashes the File; on save the admin flow uploads it to the
  // Storage EMULATOR at `event-images/{id}` and PATCHes imagePath to that STORAGE PATH (admin-events.js).
  const imageInput = page.locator("#event-image-file");
  await expect(imageInput).toBeEnabled(); // Storage emulator is configured in e2e, so the control is live
  await imageInput.setInputFiles({
    name: "event.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });
  await shot("form-with-image");

  // ── STEP 4: save → assert the 201 (heading round-trips) AND the imagePath-PATCH lands as a STORAGE
  // PATH. Two responses fire: POST create, then PATCH imagePath = `event-images/{id}` (never an http URL). ─
  const createResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const created = await (await createResponse).json();
  expect(created.heading).toBe(HEADING);

  // The follow-up PATCH persists the storage PATH the upload returned — the exact shape the old renderer
  // dropped. Assert it's a path (event-images/{id}), NOT an http(s) URL.
  const patch = await page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v1/admin/events/${created.id}`) && r.request().method() === "PATCH",
  );
  const patched = await patch.json();
  expect(patched.imagePath).toBe(`event-images/${created.id}`);
  expect(patched.imagePath).not.toMatch(/^https?:\/\//i);

  // Saving navigated back to the list (TM-426).
  await expect(page).toHaveURL(/#\/admin\/events$/);
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await shot("created");

  // ── STEP 5: open the event's PUBLIC detail page — the hero must render the uploaded image. This is
  // the TM-708 crux. Navigate via the hash router (no reload), the same no-reload nav events.spec uses. ─
  await page.evaluate((id) => {
    window.location.hash = `#/events/${id}`;
  }, created.id);
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(created.id));

  // The hero <img> exists AND gets a RESOLVED src pointing at the Storage emulator. Pre-fix, NO <img>
  // was ever created for a storage-path imagePath, so this locator would never appear / never get a src
  // → the assertion goes red. Post-fix, downloadUrlForPath() resolves the path and sets the src.
  const heroImg = page.locator('[data-testid="event-hero"] img.tm-event-hero-img');
  await expect(heroImg).toBeVisible();
  // The Storage emulator serves download URLs from its own host via the v0 API; the object path is
  // `event-images/{id}`, URL-encoded in the download URL (same shape avatar-upload asserts for avatars).
  await expect(heroImg).toHaveAttribute("src", /\/v0\/b\//);
  await expect(heroImg).toHaveAttribute("src", /event-images%2F/);
  await shot("detail-with-image");

  // ── STEP 6: the resolved image bytes are actually FETCHABLE (HTTP 200) — a real object, not a
  // dangling/broken URL. This is what separates "the fix resolved a real upload" from "resolved a
  // path with no bytes" (which would 404 / fall back to the placeholder). ─────────────────────────
  const heroSrc = await heroImg.getAttribute("src");
  expect(heroSrc).toBeTruthy();
  const status = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.status;
  }, heroSrc);
  expect(status).toBe(200);

  // ── STEP 7: it PERSISTED as a STORAGE PATH — the events row holds `event-images/{id}`, not an http
  // URL. This nails the ticket's root cause (upload persists a PATH; render must resolve it): if the row
  // stored a URL, the render would be trivial and wouldn't exercise the fix. ─────────────────────────
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT image_path FROM events WHERE id = $1", [created.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].image_path).toBe(`event-images/${created.id}`);
    expect(rows[0].image_path).not.toMatch(/^https?:\/\//i);
  } finally {
    await client.end();
  }
});
