// TM-1044 (ticket D): cross-route shell geometry. The app-shell contract (TM-1041/1042/1043) is that
// EVERY route sits inside the SAME clamp-band column with the bottom tab bar pinned in an IDENTICAL
// position. This spec proves it at a DESKTOP viewport, where the clamp band is actually visible (on a
// phone every route is trivially full-width). Sign in as an ADMIN (so #/admin is reachable) and assert
// the `main.app` column width + `#app-tabbar` geometry across the phone-band routes.
//
// TM-1075 extends this: the column is TOP-aligned (content pinned to the top) and FILLS the viewport
// height on every route (short content still spans a full-height column, so the paper surface never
// shrinks to a mid-floating box). TM-1074 extends this: the ADMIN surface is a WIDE column (the shell
// widens to fit `.admin-console` = min(72rem, 96vw)) that stays CENTRED with NO horizontal overflow —
// so the admin routes are asserted separately from the ≤480px phone band.

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

// The phone-band routes: every non-admin route inherits the ≤480px clamp column.
const PHONE_BAND_ROUTES = ["#/home", "#/events", "#/chat", "#/profile"];
// The admin surface routes: a WIDE column (TM-1074). #/admin = hub, #/admin/events = a console.
const ADMIN_ROUTES = ["#/admin", "#/admin/events"];

/** Read the geometry of the shell column + tab bar + document overflow at the current route. */
async function readGeo(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), width: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) };
    };
    return {
      app: rect("main.app"),
      bar: rect("#app-tabbar"),
      viewportH: window.innerHeight,
      viewportW: window.innerWidth,
      // Horizontal overflow: the document must not scroll sideways.
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
}

async function goToRoute(page, route) {
  await page.evaluate((r) => (window.location.hash = r), route);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(route);
  await expect(page.locator("#app-tabbar")).toBeVisible(); // render() settled the chrome
}

test("@app-shell every phone-band route renders the SAME clamp-band column + identically-pinned tab bar at 1440px (TM-1044)", async ({ page }) => {
  await signIn(page, ADMIN);
  // The ADMIN role resolves → tabbar.js injects the fifth Admin tab; wait so #/admin is reachable.
  await expect(page.locator("#tab-admin")).toBeVisible();

  const geos = [];
  for (const route of PHONE_BAND_ROUTES) {
    await goToRoute(page, route);
    geos.push({ route, ...(await readGeo(page)) });
  }

  // Each non-admin route is inside the ≤480px clamp band, and the tab bar exists on each.
  for (const g of geos) {
    expect(g.app, `main.app must exist on ${g.route}`).toBeTruthy();
    expect(g.bar, `#app-tabbar must exist on ${g.route}`).toBeTruthy();
    expect(g.app.width, `column width on ${g.route} must be within the 420–480px clamp band`).toBeLessThanOrEqual(480);
    expect(g.app.width, `column width on ${g.route}`).toBeGreaterThanOrEqual(400);
  }

  // And IDENTICAL across every non-admin route — the whole point of the single shell: no per-route width
  // drift, and the fixed tab bar pinned in a pixel-identical position (same left, width, bottom) on all.
  const base = geos[0];
  for (const g of geos.slice(1)) {
    expect(Math.abs(g.app.width - base.app.width), `column width drifts: ${g.route} ${g.app.width} vs ${base.route} ${base.app.width}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.left - base.bar.left), `tab-bar left drifts on ${g.route}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.width - base.bar.width), `tab-bar width drifts on ${g.route}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bar.bottom - base.bar.bottom), `tab-bar bottom drifts on ${g.route}`).toBeLessThanOrEqual(1);
  }
});

test("@app-shell content is TOP-aligned and the column FILLS the viewport height on every route (TM-1075)", async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.locator("#tab-admin")).toBeVisible();

  for (const route of [...PHONE_BAND_ROUTES, ...ADMIN_ROUTES]) {
    await goToRoute(page, route);
    const g = await readGeo(page);
    expect(g.app, `main.app must exist on ${route}`).toBeTruthy();
    // TOP-aligned: the column starts at (or above, if it scrolls) the top of the viewport — NOT floated
    // to the middle by the old place-items:center. `top` <= a small tolerance for any body margin.
    expect(g.app.top, `column must be top-aligned on ${route} (was mid-floated under place-items:center)`).toBeLessThanOrEqual(2);
    // FULL height: the column background spans the whole viewport regardless of content — its height is
    // at least the viewport height (min-height: 100dvh), so a short screen's paper surface never shrinks
    // to a content-height box floating mid-viewport.
    expect(g.app.height, `column must fill the viewport height on ${route} (${g.app.height} < ${g.viewportH})`).toBeGreaterThanOrEqual(g.viewportH - 1);
  }
});

test("@app-shell the admin surface is a WIDE centred column with NO horizontal overflow (TM-1074)", async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.locator("#tab-admin")).toBeVisible();

  for (const route of ADMIN_ROUTES) {
    await goToRoute(page, route);
    // The active admin console is visible inside the shell.
    await expect(page.locator(".admin-console:not([hidden])").first()).toBeVisible();
    const g = await readGeo(page);
    expect(g.app, `main.app must exist on ${route}`).toBeTruthy();

    // WIDE: the admin shell is materially wider than the ≤480px phone band (it widened to fit
    // .admin-console = min(72rem, 96vw)). At 1440px that's ~1152px (72rem), well over 480.
    expect(g.app.width, `admin column on ${route} must be WIDE (widened past the phone band)`).toBeGreaterThan(600);

    // CENTRED: equal gutters left and right — the wide column sits centred in the viewport, not
    // left-shifted. left margin ≈ (viewportW - width) / 2.
    const expectedGutter = (g.viewportW - g.app.width) / 2;
    expect(Math.abs(g.app.left - expectedGutter), `admin column must be centred on ${route} (left ${g.app.left} vs expected gutter ${Math.round(expectedGutter)})`).toBeLessThanOrEqual(2);

    // NO horizontal overflow: the document must not scroll sideways — the whole TM-1074 bug was the
    // wide console overflowing the clamped column to the RIGHT (html{overflow-x:hidden} hid it, so it
    // read as a misaligned/clipped surface). scrollWidth must not exceed clientWidth.
    expect(g.scrollW, `NO horizontal overflow on ${route} (scrollWidth ${g.scrollW} must not exceed clientWidth ${g.clientW})`).toBeLessThanOrEqual(g.clientW + 1);
    // And the column itself must not spill past the right viewport edge.
    expect(g.app.left + g.app.width, `admin column right edge must stay within the viewport on ${route}`).toBeLessThanOrEqual(g.viewportW + 1);
  }
});
