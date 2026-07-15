import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ADMIN, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor } from "../events-api.mjs";

// Site-wide alert banner e2e — the @alerts P0 (TM-738, feature TM-243, surface = theme/shell/alerts).
// Drives the site-wide WARNING banner through the real browser + full stack against the shell module
// merged in TM-243 (alerts.js + alerts-core.js), proving the ONE journey that matters most:
//
//   seed an ACTIVE, global WARNING alert via the admin API → load the app SIGNED-OUT (the #/login
//   screen) → the banner appears PRE-LOGIN (the public /alerts/active read shows a notice even before
//   you sign in) → click its "OK" (a sticky ACKNOWLEDGE dismissal) → the banner disappears → RELOAD →
//   it STAYS hidden, because the acknowledge persisted in localStorage (TM-243's sticky-across-reload
//   contract, the core of AlertDismissal.ACKNOWLEDGE).
//
// WHY PRE-LOGIN / NO SIGN-IN. The banner host mounts in the app SHELL (main.app) and the fetch behind
// it (getActiveAlerts → GET /api/v1/alerts/active) is UNAUTHENTICATED by design — a global operator
// notice (e.g. a heatwave "events temporarily cancelled" warning) must render on the landing/login
// screen too, not only once you're in. So this spec never signs a user in: it seeds the notice as an
// admin over the API and then drives the SIGNED-OUT browser. The alerts.js `<script type="module">` in
// index.html boots on every route (login included), polls once on load, and paints the banner.
//
// ADMIN-CREATE IS AN API CALL (no admin alert web form is merged — the compose console is an explicit
// TM-243 follow-up): "an operator sends a global WARNING" is POST /api/v1/admin/alerts (AlertAdminController),
// exactly like the events spec (TM-400) creates events over the admin API. We mint the seeded ADMIN's
// emulator token (authHeadersFor, reused from events-api.mjs — the account carries the role=ADMIN claim
// global-setup grants it) and POST the alert; the BROWSER only drives the public read + acknowledge.
//
// DETERMINISTIC + ISOLATED. The notice message carries a per-run UUID, so this run's alert is unique:
// the sticky-dismissal localStorage key is `tm.alert.ack.<id>.<contentHash>` (alerts-core.ackKey), and
// both the id (returned by the create call) and the content hash (derived from level|dismissal|message)
// are specific to THIS alert — no other run's or spec's alert can collide with, satisfy, or be
// satisfied by, our acknowledge. We do NOT use Date.now() for uniqueness (unavailable per the harness
// convention); the UUID is the seed. `afterAll` expires the alert (POST …/{id}/expire) so a shared-DB
// re-run (CI `retries: 1`) starts clean and no stale banner leaks into a later spec.
//
// This spec is desktop-only (default `chromium` project) — the banner is shell-level and viewport-
// agnostic, and the login screen it renders on has no hamburger nav to negotiate, so there's nothing
// mobile-specific to prove here. `screenshot: "on"` is global (playwright.config.mjs); we also take an
// explicit named shot at each major step so the run yields a step-by-step visual trail.

/** The active WARNING alert this run seeds. A per-run UUID makes the message — and therefore the
 *  content hash the sticky-dismissal key is built from — unique to this run, so the acknowledge is
 *  isolated from every other run/spec (see the header note). */
const RUN_ID = randomUUID();
const MESSAGE = `Events temporarily paused during the heatwave — please check back soon. [e2e ${RUN_ID}]`;

/** Create a global WARNING / sticky-ACKNOWLEDGE alert that is active NOW via the admin API
 *  (POST /api/v1/admin/alerts → 201). `headers` MUST be an ADMIN's authed headers (role=ADMIN claim).
 *  `expiresAt` is set well in the future so it stays active for the whole test; `startsAt` is omitted
 *  so the service defaults it to "now" (visible immediately). Returns the created AlertAdminResponse
 *  JSON (id, message, level, dismissal, status, …). */
async function seedWarningAlert(headers) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // +24h — safely active
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/alerts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: MESSAGE,
      level: "WARNING", // amber heads-up — the "events temporarily cancelled" case (AlertLevel.WARNING)
      dismissal: "ACKNOWLEDGE", // sticky "OK" persisted in localStorage (AlertDismissal.ACKNOWLEDGE)
      expiresAt, // required; startsAt omitted ⇒ the service starts it now (visible immediately)
    }),
  });
  if (res.status !== 201) {
    throw new Error(`seed alert failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Expire the seeded alert now (POST /api/v1/admin/alerts/{id}/expire) so a shared-DB re-run starts
 *  clean and no stale banner leaks into a later spec. Best-effort — a failed cleanup must not fail the
 *  suite (the fresh-CI-DB case is already clean). */
async function expireAlert(headers, id) {
  try {
    await fetch(`${API_BASE_URL}/api/v1/admin/alerts/${id}/expire`, { method: "POST", headers });
  } catch {
    /* best-effort cleanup — ignore (e.g. a fresh CI DB that's already clean) */
  }
}

// The alert seeded for this file, and the admin headers used to seed + later expire it.
let alert;
let adminHeaders;

test.beforeAll(async () => {
  adminHeaders = await authHeadersFor(ADMIN);
  alert = await seedWarningAlert(adminHeaders);
});

test.afterAll(async () => {
  if (alert && adminHeaders) await expireAlert(adminHeaders, alert.id);
});

test("@alerts a pre-login WARNING banner shows, is acknowledged with OK, and STAYS hidden across reload", async ({
  page,
}, testInfo) => {
  // A step screenshot helper — an explicit, named shot per major step on top of the global
  // screenshot:"on", so the run's artifacts read as a step-by-step trail of the banner journey.
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`alert-banner-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // Locators for this run's banner. We scope by the WARNING modifier class the level maps to
  // (alerts-core.levelClass('WARNING') → 'tm-alert--warning') AND by the unique message, so we assert
  // OUR notice — never some other run's leftover banner.
  const banner = page.locator(".tm-alert.tm-alert--warning", { hasText: MESSAGE });
  // The sticky-acknowledge control: dismissControl('ACKNOWLEDGE') renders a button labelled "OK" whose
  // accessible name is "Acknowledge and dismiss" (the visible glyph and the a11y name differ by design).
  const okButton = banner.getByRole("button", { name: "Acknowledge and dismiss" });

  // ── STEP 1: load the app SIGNED-OUT — the #/login front door, no sign-in. ───────────────────────
  // The banner host mounts in the shell and its read is public, so the notice must appear here, before
  // any authentication. We assert the signed-out login form is up to prove we really are pre-login.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  // The on-load poll (alerts.js runs refresh() at DOMContentLoaded) fetches the active set and paints
  // the banner; nudge it once via the exposed hook so we never race the ~5-min interval's first tick.
  await page.evaluate(() => window.tmAlerts && window.tmAlerts.refresh());

  // ── STEP 2: the WARNING banner appears PRE-LOGIN with our message + the sticky "OK". ────────────
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(MESSAGE);
  // It's a WARNING (announced politely — role="status", aria-live="polite"), and it carries the sticky
  // acknowledge control (label "OK", accessible name "Acknowledge and dismiss").
  await expect(banner).toHaveAttribute("role", "status");
  await expect(okButton).toBeVisible();
  await expect(okButton).toHaveText("OK");
  await shot("banner-pre-login");

  // ── STEP 3: acknowledge it — click "OK". The sticky dismissal persists to localStorage and the
  // banner drops immediately (alerts.js re-renders from the cached active set on dismiss). ──────────
  await okButton.click();
  await expect(banner).toBeHidden();
  await shot("acknowledged");

  // The acknowledge is recorded under the exact sticky key alerts-core builds — id + content hash
  // (tm.alert.ack.<id>.<contentHash>). We recompute the hash in-page from the SAME inputs the module
  // uses (level|dismissal|message via FNV-1a base36 — contentHash in alerts-core.js) so this asserts
  // the real persisted key, not a guessed one. This is what makes the dismissal survive a reload.
  const ackValue = await page.evaluate(
    ({ id, level, dismissal, message }) => {
      const src = `${level}|${dismissal}|${message}`;
      let h = 0x811c9dc5; // FNV offset basis
      for (let i = 0; i < src.length; i++) {
        h ^= src.charCodeAt(i);
        h = Math.imul(h, 0x01000193); // FNV prime
      }
      const contentHash = (h >>> 0).toString(36);
      return localStorage.getItem(`tm.alert.ack.${id}.${contentHash}`);
    },
    { id: alert.id, level: "WARNING", dismissal: "ACKNOWLEDGE", message: MESSAGE },
  );
  expect(ackValue).toBe("1"); // recordDismissal writes "1" for a sticky acknowledge

  // ── STEP 4: RELOAD — the P0. The alert is STILL active server-side, but the persisted acknowledge
  // filters it out (alerts-core.isDismissed reads the localStorage key), so the banner STAYS hidden. ─
  await page.reload();
  await expect(page.locator("#auth-signed-out")).toBeVisible(); // back on the signed-out front door
  // Nudge the post-reload poll too, so we prove the banner stays down even AFTER a fresh fetch of the
  // (still-active) alert — not merely that it hasn't repainted yet.
  await page.evaluate(() => window.tmAlerts && window.tmAlerts.refresh());
  // Give the poll a beat to resolve, then assert the banner is still absent — the acknowledge held.
  await expect(banner).toBeHidden();
  // And the host itself is hidden (no other banners crept in for this run) — the shell is clean.
  await expect(page.locator("#tm-alerts .tm-alert--warning", { hasText: MESSAGE })).toHaveCount(0);
  await shot("stays-hidden-after-reload");
});
