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
      return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) };
    };

    // .app's CONTENT box (inside its padding) — the region a child may actually occupy. Overflow is when
    // a child's right edge exceeds appContent.right (clipped by overflow-x:hidden, so scrollWidth alone
    // misses it). We compute the content box from the border-box rect minus the resolved padding.
    const app = document.querySelector("main.app");
    let appContent = null;
    if (app) {
      const b = app.getBoundingClientRect();
      const cs = getComputedStyle(app);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      appContent = { left: Math.round(b.left + pl), right: Math.round(b.right - pr), width: Math.round(b.width - pl - pr), padLeft: Math.round(pl), padRight: Math.round(pr) };
    }

    // The visible admin console + the RIGHTMOST edge reached by ANY of its descendants (a wide child
    // like the ~680px .tm-table would leak past the console even if the console box itself fit). This is
    // the element-level overflow check the body-scrollWidth check can't see under overflow-x:hidden.
    const console = document.querySelector(".admin-console:not([hidden])");
    let adminConsole = null;
    let maxChildRight = null;
    if (console) {
      const b = console.getBoundingClientRect();
      adminConsole = { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) };
      let mx = b.right;
      for (const el of console.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.right > mx) mx = r.right;
      }
      maxChildRight = Math.round(mx);
    }

    return {
      app: rect("main.app"),
      appContent,
      adminConsole,
      maxChildRight,
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

// TM-1074: the admin surface must sit WITHIN `.app`'s content box with a symmetric gutter — NOT flush to
// / past the column edge. The `.admin-console` (and its widest descendant, e.g. the ~680px `.tm-table`)
// right edge must be ≤ `.app` content-box right (`.app.right − paddingRight`), and there must be a real
// left gutter too. This catches the element-level overflow that `overflow-x:hidden` clips (so
// document.scrollWidth misses it). Run at 1440 AND 1920, on the hub AND a POPULATED events console.
for (const width of [1440, 1920]) {
  test(`@app-shell the admin surface fits WITHIN the column content box with symmetric gutters at ${width}px, hub + populated console (TM-1074)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await signIn(page, ADMIN);
    await expect(page.locator("#tab-admin")).toBeVisible();

    for (const route of ADMIN_ROUTES) {
      await goToRoute(page, route);
      await expect(page.locator(".admin-console:not([hidden])").first()).toBeVisible();
      // For the events console, wait until rows have rendered so the wide `.tm-table` is actually laid
      // out (a populated console is the real overflow risk — the ~680px table must also fit).
      if (route === "#/admin/events") {
        // TM-1096: the list defaults to the "Happening now" lifecycle chip, and the seeded events start
        // +7 days ("Visible"), so the default view is EMPTY and the wide `.tm-table` never renders. Click
        // "All" to show every bucket, so the populated console (the real overflow risk) is actually laid out.
        await page.locator("#admin-events-lifecycle-all").click().catch(() => {});
        await page.locator(".admin-console:not([hidden]) .tm-table").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      }

      const g = await readGeo(page);
      expect(g.app, `main.app must exist on ${route}@${width}`).toBeTruthy();
      expect(g.appContent, `.app content box must resolve on ${route}@${width}`).toBeTruthy();
      expect(g.adminConsole, `.admin-console must be visible on ${route}@${width}`).toBeTruthy();

      // WIDE: the admin shell is materially wider than the ≤480px phone band.
      expect(g.app.width, `admin column on ${route}@${width} must be WIDE (widened past the phone band)`).toBeGreaterThan(600);

      // CENTRED column: equal gutters left/right against the viewport.
      const colGutter = (g.viewportW - g.app.width) / 2;
      expect(Math.abs(g.app.left - colGutter), `admin column must be centred on ${route}@${width} (left ${g.app.left} vs expected ${Math.round(colGutter)})`).toBeLessThanOrEqual(2);

      // ELEMENT-LEVEL CONTAINMENT (the guard that bites under overflow-x:hidden):
      // (a) the console's right edge must not exceed .app's content-box right edge.
      expect(g.adminConsole.right, `.admin-console right (${g.adminConsole.right}) must stay within .app content-box right (${g.appContent.right}) on ${route}@${width} — no right leak past the column`).toBeLessThanOrEqual(g.appContent.right + 1);
      // (b) NO descendant (e.g. the wide .tm-table) may leak past the content box right either.
      expect(g.maxChildRight, `widest admin descendant right (${g.maxChildRight}) must stay within .app content-box right (${g.appContent.right}) on ${route}@${width} — no child leaks past the column`).toBeLessThanOrEqual(g.appContent.right + 1);
      // (c) SYMMETRIC left gutter: the console's left must sit at/after .app's content-box left (a real
      //     gutter on the left too, not left-shifted to hide the right overflow).
      expect(g.adminConsole.left, `.admin-console left (${g.adminConsole.left}) must sit at/after .app content-box left (${g.appContent.left}) on ${route}@${width}`).toBeGreaterThanOrEqual(g.appContent.left - 1);
      // (d) gutters on BOTH sides of the console within the content box are within 2px of each other
      //     (centred, symmetric — not flush to one edge).
      const leftGap = g.adminConsole.left - g.appContent.left;
      const rightGap = g.appContent.right - g.adminConsole.right;
      expect(Math.abs(leftGap - rightGap), `console gutters must be symmetric on ${route}@${width} (left gap ${leftGap} vs right gap ${rightGap})`).toBeLessThanOrEqual(2);

      // And still no document-level horizontal scroll.
      expect(g.scrollW, `NO horizontal page scroll on ${route}@${width} (scrollWidth ${g.scrollW} vs clientWidth ${g.clientW})`).toBeLessThanOrEqual(g.clientW + 1);
    }
  });
}
