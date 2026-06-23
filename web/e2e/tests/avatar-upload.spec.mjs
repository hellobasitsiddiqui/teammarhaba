import { test, expect } from "@playwright/test";
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
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();
}

test("a user uploads an avatar; photoURL is set and shown, and survives a reload", async ({ page }) => {
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
  await expect(page.locator("#signout-btn")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator(".tm-profile-avatar .tm-avatar-img")).toBeVisible();
  const afterReload = await page.evaluate(() => window.tmAuth.currentUser()?.photoURL || null);
  expect(afterReload).toBe(photoURL);
});

test("a non-image file is rejected client-side before any upload", async ({ page }) => {
  await signIn(page);
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();

  // A text file isn't image/* — the control rejects it inline (mirrors the Storage rules) and never
  // uploads. No success toast appears; an error message + error toast do.
  await page.locator("#profile-avatar-file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image", "utf8"),
  });

  await expect(page.locator("#profile-avatar-error")).toBeVisible();
  await expect(page.locator("#tm-toasts .tm-toast-error")).toBeVisible();
  await expect(page.locator(".tm-profile-avatar .tm-avatar-img")).toBeHidden();
});
