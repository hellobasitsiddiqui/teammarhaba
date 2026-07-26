// TM-1044 (ticket D): cross-route shell geometry. The app-shell contract (TM-1041/1042/1043) is that
// EVERY route sits inside the SAME clamp-band column with the bottom tab bar pinned in an IDENTICAL
// position. This spec proves it at a DESKTOP viewport, where the clamp band is actually visible (on a
// phone every route is trivially full-width). Sign in as an ADMIN (so #/admin is reachable) and assert
// the `main.app` column width + `#app-tabbar` geometry are the same across #/home, #/events, #/chat,
// #/profile and #/admin — no per-route drift.

import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";

test.use({ viewport: { width: 1440, height: 900 } });

/** Email+password sign-in (mirrors admin-hub.spec.mjs — email-code is the default front door). */
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

const ROUTES = ["#/home", "#/events", "#/chat", "#/profile", "#/admin"];

test("@app-shell every route renders the SAME clamp-band column + identically-pinned tab bar at 1440px (TM-1044)", async ({ page }) => {
  await signIn(page, ADMIN);
  // The ADMIN role resolves → tabbar.js injects the fifth Admin tab; wait so #/admin is reachable.
  await expect(page.locator("#tab-admin")).toBeVisible();

  const geos = [];
  for (const route of ROUTES) {
    await page.evaluate((r) => (window.location.hash = r), route);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(route);
    await expect(page.locator("#app-tabbar")).toBeVisible(); // render() settled the chrome
    const g = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), width: Math.round(b.width), bottom: Math.round(b.bottom) };
      };
      return { app: r("main.app"), bar: r("#app-tabbar") };
    });
    geos.push({ route, ...g });
  }

  // Each route is inside the ≤480px clamp band, and the tab bar exists on each.
  for (const g of geos) {
    expect(g.app, `main.app must exist on ${g.route}`).toBeTruthy();
    expect(g.bar, `#app-tabbar must exist on ${g.route}`).toBeTruthy();
    expect(g.app.width, `column width on ${g.route} must be within the 420–480px clamp band`).toBeLessThanOrEqual(480);
    expect(g.app.width, `column width on ${g.route}`).toBeGreaterThanOrEqual(400);
  }

  // And IDENTICAL across every route — the whole point of the single shell: no per-route width drift, and
  // the fixed tab bar pinned in a pixel-identical position (same left, width, bottom) on all five.
  const base = geos[0];
  for (const g of geos.slice(1)) {
    expect(Math.abs(g.app.width - base.app.width), `column width drifts: ${g.route} ${g.app.width} vs ${base.route} ${base.app.width}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.left - base.bar.left), `tab-bar left drifts on ${g.route}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.width - base.bar.width), `tab-bar width drifts on ${g.route}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.bottom - base.bar.bottom), `tab-bar bottom drifts on ${g.route}`).toBeLessThanOrEqual(1);
  }
});
