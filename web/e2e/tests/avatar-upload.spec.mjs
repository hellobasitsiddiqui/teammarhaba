import { test, expect } from "@playwright/test";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { ADMIN } from "../fixtures.mjs";

// Avatar upload round-trip (TM-166): sign in → open #/profile → pick an image for the avatar control →
// the bytes upload to the Firebase Storage EMULATOR and the Firebase user's `photoURL` is set to the
// returned download URL (the single source of truth) → the preview + nav avatar render that URL →
// after a reload the photoURL is still there (read back off the persisted Firebase user).
//
// Hermetic: Auth + Storage both run against local emulators (see web/e2e/firebase.json + serve.mjs's
// injected config). No real Firebase project is touched. We sign in as the seeded ADMIN purely
// because it's a real, provisioned account; the avatar control is available to any signed-in user.

// A tiny but valid 1x1 PNG (transparent), base64. Used as the uploaded avatar bytes.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

async function signIn(page) {
  await page.goto("/#/login");
  // Email-code is the default front door (TM-234); email+password lives under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expectSignedIn(page);
}

test("@avatar a user uploads an avatar; photoURL is set and shown, and survives a reload", async ({ page }) => {
  await signIn(page);

  // Open the self-service profile page; its avatar control is enabled (Storage emulator configured).
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  const fileInput = page.locator("#profile-avatar-file");
  await expect(fileInput).toBeEnabled();

  // Pick an image — drives the change handler → uploadAvatar() → Storage emulator → updateProfile.
  await fileInput.setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });

  // Success toast, and the preview now shows a download URL (not the fallback glyph).
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Avatar updated");
  const previewImg = page.locator(".tm-profile-avatar .tm-avatar-img");
  await expect(previewImg).toBeVisible();
  const previewSrc = await previewImg.getAttribute("src");
  expect(previewSrc).toBeTruthy();
  // The Storage emulator serves download URLs from its own host (127.0.0.1:9199) via the v0 API.
  expect(previewSrc).toContain("/v0/b/");
  expect(previewSrc).toContain("avatars%2F"); // the per-uid object path, URL-encoded.

  // The nav avatar reflects the same photoURL.
  await expect(page.locator("#nav-avatar img")).toHaveAttribute("src", previewSrc);

  // It's the user's photoURL now — assert directly on the live Firebase user.
  const photoURL = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(photoURL).toBe(previewSrc);

  // Persistence: reload, re-enter the profile page, and the avatar still renders from the stored
  // photoURL (Firebase persists the user across reloads — browserLocalPersistence).
  await page.reload();
  await expectSignedIn(page);
  await page.click("#nav-profile");
  await expect(page.locator(".tm-profile-avatar .tm-avatar-img")).toBeVisible();
  const afterReload = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(afterReload).toBe(photoURL);
});

test("@avatar re-uploading a second avatar keeps the image loading (TM-335 self-delete regression)", async ({ page }) => {
  // TM-335: the object path is fixed per-uid, so a re-upload overwrites `avatars/{uid}`. The previous
  // cleanup compared the token'd download URLs (which differ every getDownloadURL() call) and deleted
  // the object it had just uploaded — so the SECOND avatar 404'd. This exercises two consecutive
  // uploads and asserts the final avatar's bytes are actually fetchable (not a dangling 404).
  await signIn(page);
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  const fileInput = page.locator("#profile-avatar-file");
  await expect(fileInput).toBeEnabled();

  // A second, distinct-but-valid 1x1 PNG (red pixel) so this upload's bytes differ from the first.
  const RED_PNG_1x1_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  // First upload.
  await fileInput.setInputFiles({
    name: "avatar-1.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
  });
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Avatar updated");

  // Second upload (the re-upload that used to self-delete). Wait for the photoURL to actually change
  // so we know the second upload's updateProfile has landed before asserting.
  const firstURL = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  await fileInput.setInputFiles({
    name: "avatar-2.png",
    mimeType: "image/png",
    buffer: Buffer.from(RED_PNG_1x1_BASE64, "base64"),
  });
  await expect
    .poll(async () => page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null))
    .not.toBe(firstURL);

  const finalURL = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(finalURL).toBeTruthy();
  expect(finalURL).toContain("avatars%2F");

  // The crux: the object the final photoURL points at must still EXIST (HTTP 200, not 404). Before the
  // fix, the cleanup deleted this very object, so this fetch would 404.
  const status = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.status;
  }, finalURL);
  expect(status).toBe(200);

  // And it renders in the UI (preview + nav) rather than showing the fallback glyph.
  const previewImg = page.locator(".tm-profile-avatar .tm-avatar-img");
  await expect(previewImg).toBeVisible();
  await expect(previewImg).toHaveAttribute("src", finalURL);
});

test("@avatar a non-image file is rejected client-side before any upload", async ({ page }) => {
  await signIn(page);
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();

  // The avatar preview reflects the user's current photoURL. The first test in this file uploaded an
  // avatar for this same ADMIN account (persisted on the Firebase user in the emulator), so the
  // preview img is already showing. Capture its state up-front so we can prove the rejected pick
  // leaves the EXISTING avatar untouched.
  const previewImg = page.locator(".tm-profile-avatar .tm-avatar-img");
  const photoURLBefore = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);

  // A text file isn't image/* — the control rejects it inline (mirrors the Storage rules) and never
  // uploads. No success toast appears; an error message + error toast do.
  await page.locator("#profile-avatar-file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image", "utf8"),
  });

  await expect(page.locator("#profile-avatar-error")).toBeVisible();
  await expect(page.locator("#tm-toasts .tm-toast-error")).toBeVisible();
  // Never a success toast — the bytes were never uploaded.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toHaveCount(0);

  // The rejection does NOT touch the existing avatar: photoURL is unchanged and the preview shows
  // exactly what it did before (visible if the user already had one — which they do here). Rejecting
  // a NEW file must never wipe the user's current avatar.
  const photoURLAfter = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(photoURLAfter).toBe(photoURLBefore);
  if (photoURLBefore) {
    await expect(previewImg).toBeVisible();
    await expect(previewImg).toHaveAttribute("src", photoURLBefore);
  } else {
    await expect(previewImg).toBeHidden();
  }
});
