// TM-1090: the standalone notification bell must sit at the top-right corner of the APP COLUMN/PANEL on
// EVERY signed-in surface (Home, Events, Chat, Profile, Admin) at EVERY screen size — i.e. its right edge
// hugs `main.app`'s right edge (the content panel's edge, level with the header's action button), NOT:
//   • floating mid-panel on the WIDENED admin column (the old bug: bell used the narrow ≤480px band while
//     the admin panel is ~72rem, so it sat ~300px inside the panel), and NOT
//   • flung out to the far viewport edge on wide desktops.
//
// The bell rides the same --app-max clamp band as `.app` (and widens with it on admin), so this holds across
// the full widths×routes matrix. Sign in as ADMIN so #/admin (the wide panel) is reachable. The bell's
// `hidden` attribute (reveal logic) is owned elsewhere (corner-bell-core / notification-center-bell-gate
// unit tests); here we force it measurable and assert GEOMETRY relative to the column.

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
// The bell's right edge sits inside the column's right edge by .app's content rail (2rem desktop / 0.85rem
// phone ≈ ≤32px). Allow up to 40px inside; it must never sit further in (mid-panel) or beyond the column.
const RAIL_MAX = 40;

test("@app-shell notification bell hugs the app-column right edge on every route at every width (TM-1090)", async ({ page }) => {
  await signIn(page, ADMIN);
  // ADMIN role resolves → tabbar.js injects the fifth Admin tab; wait so #/admin (the wide panel) is reachable.
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
        if (bell) bell.hidden = false; // geometry is CSS — measure regardless of notif data
        const app = document.querySelector("main.app");
        const b = bell ? bell.getBoundingClientRect() : null;
        const a = app ? app.getBoundingClientRect() : null;
        return {
          bellRight: b ? Math.round(b.right) : null,
          bellTop: b ? Math.round(b.top) : null,
          colRight: a ? Math.round(a.right) : null,
        };
      });
      samples.push({ width, route, ...g });
    }
  }

  // On EVERY combination the bell hugs the app column's right edge: at/just inside it, never mid-panel.
  for (const s of samples) {
    expect(s.bellRight, `bell not found at ${s.width}px ${s.route}`).not.toBeNull();
    expect(s.colRight, `main.app not found at ${s.width}px ${s.route}`).not.toBeNull();
    const inset = s.colRight - s.bellRight; // >0 = bell inside the column edge
    expect(
      inset,
      `bell floats mid-panel at ${s.width}px ${s.route} — ${inset}px inside the column edge (should be ≤${RAIL_MAX})`,
    ).toBeLessThanOrEqual(RAIL_MAX);
    expect(
      inset,
      `bell sits BEYOND the app column at ${s.width}px ${s.route} — bellRight ${s.bellRight} > colRight ${s.colRight}`,
    ).toBeGreaterThanOrEqual(-4);
  }

  // The bell's TOP offset is identical across all samples — no per-route / per-width vertical term.
  const tops = [...new Set(samples.map((s) => s.bellTop))];
  expect(tops.length, `bell top drifts across routes/widths: ${JSON.stringify(tops)}`).toBe(1);
});
