import { test, expect } from "@playwright/test";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Profile phone-number validation (TM-752): the phone field's character pattern
// (^\+?[0-9 ()./-]{3,32}$) validated the allowed CHARACTERS but not the digit COUNT, so a
// too-short number like "12" passed as "valid" and was saved. The fix (profile-core.js
// phoneFormatError, later folded into TM-781's phonePartsError) requires a real 7–15-digit
// number, wired into profile.js's validateField → validateAll so an out-of-range number is
// rejected inline and the save is BLOCKED.
//
// This mirrors profile-edit.spec.mjs: same per-spec sign-in-then-open-#/profile helper, same
// ADMIN seeded account (the profile page edits the caller's OWN record, so the role is
// irrelevant — we just need a real provisioned account), same UI-assertion + DB-persistence
// shape. The behaviour proven here is the one that would FAIL before TM-752 (a 2-digit phone
// saved) and PASS after (rejected inline, DB untouched).

// Sign in and open #/profile, WAITING for the mount-time GET /api/v1/me to land before returning
// (the form mounts empty and populates asynchronously; typing before the response arrives lets the
// populate clobber the input — TM-198). Copied verbatim from profile-edit.spec.mjs so the two
// specs share the exact same, proven front-door timing.
async function openProfile(page) {
  await page.goto("/#/login");
  // Email-code is the default front door (TM-234); the email+password form is under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expectSignedIn(page);

  // Arm the wait BEFORE the click that triggers the profile-mount GET /me.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded; // populate has run — the form won't clobber what we type next
}

// Read the stored phone straight from Postgres — the DB seam the sibling specs use for their
// persistence assertions.
async function readPhone(email) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT phone FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    return rows[0].phone;
  } finally {
    await client.end();
  }
}

test("@profile a too-short phone number is rejected inline and NOT saved (TM-752)", async ({ page }) => {
  await openProfile(page);

  // The phone field is a (country picker, national-number input) PAIR since TM-781. The picker
  // (#profile-phone-country) soft-defaults to GB (+44) and #profile-phone holds the NATIONAL part.
  const country = page.locator("#profile-phone-country");
  const phone = page.locator("#profile-phone");
  await expect(country).toBeVisible();
  await expect(phone).toBeVisible();

  // ── Baseline: save a VALID GB national number so the DB holds a known, correct value we can
  // later prove was NOT overwritten by the rejected save. 7700900123 is 10 digits → composes to
  // the E.164 +447700900123. This also exercises the accepting side of the 7–15-digit rule.
  await country.selectOption("GB");
  await phone.fill("7700900123");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");
  expect(await readPhone(ADMIN.email)).toBe("+447700900123");

  // Let the baseline success toast auto-dismiss (default 5s) so the assertions below can key on a
  // FRESH toast without racing the previous one — the toast host is shared and cards stack.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toHaveCount(0);

  // ── The TM-752 behaviour: a too-short national number ("12", 2 digits) with a confirmed country
  // must be REJECTED. Before the fix this passed the character pattern and saved (composing to
  // +4412); after the fix validateAll() blocks it.
  await phone.fill("12");
  await page.getByRole("button", { name: "Save changes" }).click();

  // Inline error on the phone field, carrying the exact 7–15-digit copy the fix introduced.
  const phoneError = page.locator("#profile-phone-error");
  await expect(phoneError).toBeVisible();
  await expect(phoneError).toContainText("Enter a valid phone number (7 to 15 digits).");
  // The national input is flagged invalid for AT (the country is fine — the number is the defect).
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  // A fresh error toast fires (the fix-required blocked-save signal) and NO success toast appears.
  await expect(page.locator("#tm-toasts .tm-toast-error")).toContainText("Please fix the highlighted fields.");
  await expect(page.locator("#tm-toasts .tm-toast-success")).toHaveCount(0);

  // The blocked save left the DB untouched: the stored phone is STILL the valid baseline, NOT
  // the rejected "12". This is the concrete before/after: pre-fix the row would have flipped.
  expect(await readPhone(ADMIN.email)).toBe("+447700900123");
});
