// TM-1090: the standalone notification bell must sit at the TRUE VIEWPORT top-right corner on EVERY
// signed-in surface (Home, Events, Chat, Profile, Admin) at EVERY screen size — not drift inward with
// the centred clamp band (the old bug: bell rode the column edge, so it was ~188/316/494px off the
// corner at 768/1024/1440px, and floated mid-column on the widened Admin surface).
//
// The invariant is pure route-independent CSS on `.app-topbar` (position:fixed; top:0; right:0; no width /
// margin / --app-max), so this spec proves it holds across the full widths×routes matrix. Sign in as an
// ADMIN so #/admin is reachable. The bell's `hidden` attribute (reveal logic) is owned elsewhere
// (corner-bell-core / notification-center-bell-gate unit tests); here we force it measurable and assert
// GEOMETRY only.

import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";

/** Email+password sign-in (mirrors app-shell-cross-route.spec.mjs). */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();
}

const WIDTHS = [320, 390, 768, 1024, 1440];
const ROUTES = ["#/home", "#/events", "#/chat", "#/profile", "#/admin"];
const CORNER_TOLERANCE = 24; // same bar profile-shell.spec.mjs applies at phone width — now universal

test("@app-shell notification bell hugs the true top-right corner on every route at every width (TM-1090)", async ({ page }) => {
  await signIn(page, ADMIN);
  // ADMIN role resolves → tabbar.js injects the fifth Admin tab; wait so #/admin is reachable.
  await expect(page.locator("#tab-admin")).toBeVisible();

  const samples = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 880 });
    for (const route of ROUTES) {
      await page.evaluate((r) => (window.location.hash = r), route);
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(route);
      await expect(page.locator("#app-tabbar")).toBeVisible(); // render() settled the chrome
      const g = await page.evaluate(() => {
        const bell = document.getElementById("nav-notif-bell");
        if (bell) bell.hidden = false; // geometry is route-independent CSS — measure regardless of notif data
        const b = bell ? bell.getBoundingClientRect() : null;
        return {
          vpW: document.documentElement.clientWidth,
          right: b ? Math.round(b.right) : null,
          top: b ? Math.round(b.top) : null,
        };
      });
      samples.push({ width, route, ...g });
    }
  }

  // (1) On EVERY combination the bell's right edge is within 24px of the viewport's right edge.
  for (const s of samples) {
    expect(s.right, `bell not found at ${s.width}px ${s.route}`).not.toBeNull();
    expect(
      s.vpW - s.right,
      `bell not in the top-right corner at ${s.width}px ${s.route} — gap ${s.vpW - s.right}px (should be ≤${CORNER_TOLERANCE})`,
    ).toBeLessThanOrEqual(CORNER_TOLERANCE);
  }

  // (2) The bell's TOP offset is identical across all samples — no per-route / per-width vertical term.
  const tops = [...new Set(samples.map((s) => s.top))];
  expect(tops.length, `bell top drifts across routes/widths: ${JSON.stringify(tops)}`).toBe(1);

  // (3) The horizontal gap from the corner is identical too — a pure constant, nothing width/route can move.
  const gaps = [...new Set(samples.map((s) => s.vpW - s.right))];
  expect(gaps.length, `bell corner gap drifts across routes/widths: ${JSON.stringify(gaps)}`).toBe(1);
});
