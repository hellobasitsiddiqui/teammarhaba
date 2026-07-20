import { test, expect } from "@playwright/test";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { ADMIN } from "../fixtures.mjs";

// Profile refresh (TM-514): the Profile screen was brought in line with the approved paper wireframes
// (paper-profile hub + paper-edit-profile form inline on #/profile, and the additive paper-public-
// profile preview at #/profile/public). This spec proves the refreshed hub renders alongside the
// existing edit form (so the shipped self-service edit flow is preserved), the account-state badges +
// completeness prompt are present, and the public-profile preview route works.
//
// Sign in as the seeded ADMIN purely because it's a real, provisioned account (the role is irrelevant
// — the profile is the caller's OWN record). Mirrors profile-edit.spec's proven sign-in path: email is
// the default front door (TM-234); the email+password form lives under "Try another way".
async function signIn(page) {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expectSignedIn(page);
}

test("@profile the refreshed Profile hub shows the completeness bar, badges and the edit form", async ({ page }) => {
  await signIn(page);

  // Enter the Profile screen the real way (the nav link → #/profile). Wait for the mount GET /me to
  // settle so the hub + form have populated.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");

  // The refreshed hub container + the paper-profile cards render.
  await expect(page.locator(".tm-pf")).toBeVisible();
  await expect(page.getByText("Profile strength")).toBeVisible();
  // The shipped account-state badges (TM-168) are preserved in the hub.
  await expect(page.locator("#profile-badges")).toBeVisible();
  // The self-service edit form is inline on the SAME screen (preserved behaviour).
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;

  // The paper-profile menu is present with a real "My events" destination and a public-profile entry.
  await expect(page.getByRole("link", { name: /My events/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Public profile/ })).toBeVisible();
});

test("@profile the public-profile preview (#/profile/public) renders the paper-public-profile layout", async ({ page }) => {
  await signIn(page);

  // De-flake (TM-590): don't deep-link straight after sign-in. The router navigates off #/login on the
  // auth change using fail-safe cached values, THEN resolves /me + the first-run gates and re-guards; a
  // hash set into that window is clobbered by the router's own post-sign-in navigation, so we never land
  // on #/profile/public (fails, then passes on retry once the session is warm). #nav-profile is un-hidden
  // only once signed-in AND un-gated AND role-resolved (router.js render()), so it's the "app-ready"
  // signal — the same gate the hub test above and profile-edit's openProfile wait on before navigating.
  await expect(page.locator("#nav-profile")).toBeVisible();

  // Navigate to the additive public-profile preview route. Arm the mount GET /me (the preview shell
  // fills from it) BEFORE navigating — the TM-198 populate-timing pattern.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await page.evaluate(() => (window.location.hash = "#/profile/public"));

  await expect(page.locator(".tm-pf-public")).toBeVisible();
  await meLoaded;

  // The preview offers the wireframe's Message + Block actions (inert in a self-preview) and a link
  // back to the Profile hub.
  await expect(page.getByRole("button", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block or report" })).toBeVisible();
  await expect(page.getByLabel("Back to profile")).toBeVisible();

  // Back to the hub — the edit form is there again.
  await page.getByLabel("Back to profile").click();
  await expect(page.locator("#profile-form")).toBeVisible();
});
