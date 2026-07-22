// TM-969 — before/after visual evidence for the attending-first personalized Home FEED, at an
// Android-phone viewport (390×844).
//
// THE CHANGE: Home was a single flat "Events near you" list under a generic "Home" page title. TM-969
// reworks it into up to THREE priority sections rendered top→bottom, each shown ONLY when it has events,
// AND drops the generic "Home" page title so the FIRST PRESENT SECTION'S HEADER is the first content
// (product decision):
//   1. "Happening now"  — my attending events (GOING or WAITLISTED) that are live now.
//   2. "Your events"    — my upcoming attending events (GOING/WAITLISTED, not yet live).
//   3. "Events near you" — nearby events I'm NOT attending, BOOKABLE ONLY, a short teaser followed by
//                          a "See all events →" hand-off to #/events; it also carries the "near <city>"
//                          discovery-context sub-line (relocated from the removed page subtitle).
// Empty sections collapse entirely, so the highest non-empty SECTION HEADER is always the first content
// — never a "Home" page title. The `firstContentTitle` probe below pins that.
//
// To make the three sections all appear we seed, as ADMIN, four visible events and RSVP the capture
// USER into two of them:
//   • a LIVE event (started 30 min ago, ends in 2h) the user RSVPs GOING → feeds section 1.
//   • an UPCOMING event (starts in 7 days) the user RSVPs GOING → feeds section 2.
//   • two other UPCOMING, bookable events the user does NOT join → feed the section-3 teaser.
// The user's city is set to London to match the seeded events (section 3 is city-scoped).
//
// FULL-STACK mode (like capture-tm910): drives the REAL login flow against the running e2e stack
// (Postgres + Auth emulator + backend + a serve.mjs the harness starts). Seeds its OWN per-label
// accounts. Run once from `main` (label=before) and once from the branch (label=after); dev CORS only
// allows :8081, so serve each side on 8081 in turn.
//
// Probes (printed as JSON so the verdict is grounded, not eyeballed):
//   • sectionCount / sectionTitles — the number + headers of the rendered `home-section` blocks
//     (before: 0 sections — the old flat list has none; after: 3 sections, "Happening now" /
//     "Your events" / "Events near you").
//   • seeAllPresent               — the near-you teaser's "See all events →" hand-off is present
//     (after only).
//   • cardCount                   — total event cards on Home (both shapes render cards).
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir node capture-tm969.mjs
//   CAPTURE_LABEL=after  CAPTURE_OUT=/abs/dir node capture-tm969.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp } from "./events-api.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm969");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)
const START_SERVE = process.env.CAPTURE_NO_SERVE !== "1"; // start our own serve.mjs unless told not to

const BOOT_SPLASH_SETTLE_MS = 4500; // the boot splash holds ~3.2s — settle ≥4s before capturing
const VIEWPORT = { width: 390, height: 844 };

// The capture user + the admin that seeds the events. Per-label so before/after start identical.
// Passwords meet the emulator's ≥6-char rule. City=London so the section-3 near-you scope matches.
const USER = { email: `capture-969-user-${LABEL}@teammarhaba.test`, password: "capture-969-pw-123456", admin: false };
const ADMIN = { email: `capture-969-admin-${LABEL}@teammarhaba.test`, password: "capture-969-pw-123456", admin: true };

const shotPath = (name) => join(OUT, `${name}.png`);
const iso = (ms) => new Date(ms).toISOString();

/** Seed one account: create in the Auth emulator (+ role=ADMIN claim for the admin), then provision
 *  + un-gate it in the backend (phone PATCH before onboarding-complete — mandatory since TM-880). */
async function seed(account) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  let uid;
  try {
    const existing = await auth.getUserByEmail(account.email);
    uid = existing.uid;
    await auth.updateUser(uid, { password: account.password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      uid = (await auth.createUser({ email: account.email, password: account.password, emailVerified: true })).uid;
    } else {
      throw err;
    }
  }
  // Grant the ADMIN role BEFORE minting the provisioning token so it already carries role=ADMIN (TM-110).
  await auth.setCustomUserClaims(uid, account.admin ? { role: "ADMIN" } : {});

  const signInUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }),
  });
  if (!signInRes.ok) throw new Error(`emulator sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  const { idToken } = await signInRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed: ${meRes.status} ${await meRes.text()}`);
  const me = await meRes.json();

  const patchRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: account.admin ? "Ada" : "Sam", lastName: account.admin ? "Admin" : "User",
      city: "London", age: 30, phone: "+447700900123" }),
  });
  if (!patchRes.ok) throw new Error(`seed profile failed: ${patchRes.status} ${await patchRes.text()}`);

  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (!onboardRes.ok) throw new Error(`onboarding-complete failed: ${onboardRes.status} ${await onboardRes.text()}`);

  if (me.currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: me.currentTermsVersion }),
    });
    if (!termsRes.ok) throw new Error(`accept-terms failed: ${termsRes.status} ${await termsRes.text()}`);
  }
}

/**
 * Seed the four events (as ADMIN) and RSVP the USER into two of them, so all three Home sections have
 * content: a LIVE + an UPCOMING event the user joins (sections 1 & 2), and two other bookable upcoming
 * events left un-joined (the section-3 near-you teaser). Events are free (createEvent defaults
 * pricePence=0) so the RSVPs free-join under MEMBERSHIP_ENABLED. City=London matches the user.
 */
async function seedEventsAndRsvp() {
  const adminHeaders = await authHeadersFor(ADMIN);
  const userHeaders = await authHeadersFor(USER);
  const now = Date.now();

  // A LIVE event: started 30 min ago, ends in 2h → events-core isHappeningNow() true. The user joins it,
  // so it lands in section 1 "Happening now". (Booking cutoff is moot — the user RSVPs directly here.)
  const live = await createEvent(adminHeaders, {
    heading: "Live coffee & code meetup",
    startAt: iso(now - 30 * 60e3),
    endAt: iso(now + 2 * 36e5),
    city: "London",
    capacity: 20,
  });
  await apiRsvp(userHeaders, live.id);

  // An UPCOMING event the user joins → section 2 "Your events".
  const mineUpcoming = await createEvent(adminHeaders, {
    heading: "Sunday lakeside walk",
    startAt: iso(now + 7 * 864e5),
    endAt: iso(now + 7 * 864e5 + 2 * 36e5),
    city: "London",
    capacity: 20,
  });
  await apiRsvp(userHeaders, mineUpcoming.id);

  // Two other UPCOMING, bookable events the user does NOT join → the section-3 near-you teaser.
  await createEvent(adminHeaders, {
    heading: "Board games night",
    startAt: iso(now + 5 * 864e5),
    endAt: iso(now + 5 * 864e5 + 3 * 36e5),
    city: "London",
    capacity: 20,
  });
  await createEvent(adminHeaders, {
    heading: "Morning bouldering session",
    startAt: iso(now + 9 * 864e5),
    endAt: iso(now + 9 * 864e5 + 2 * 36e5),
    city: "London",
    capacity: 20,
  });
}

/** True when `el` exists, isn't display:none/visibility:hidden, and has a visible box. */
async function isShown(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, selector);
}

/** Probe the Home feed shape for the signed-in capture user. */
async function probe(page, name) {
  const shape = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('[data-testid="home-section"]'));
    const homePanel = document.querySelector("#auth-signed-in");
    // TM-969 product decision: the FIRST heading in the signed-in Home panel must be the first present
    // SECTION header, not a generic "Home" page title. Probe the first h2/h3 heading text + whether any
    // legacy generic-title node survives, so the verdict is grounded, not eyeballed.
    const firstHeading = homePanel?.querySelector("h2, h3");
    return {
      sectionCount: sections.length,
      sectionTitles: sections.map(
        (s) => (s.querySelector('[data-testid="home-section-title"]')?.textContent || "").trim(),
      ),
      firstContentTitle: (firstHeading?.textContent || "").trim(),
      hasGenericHomeTitle: Boolean(homePanel?.querySelector(".tm-home-title")),
      nearYouSubtitle: (document.querySelector('[data-testid="home-section-sub"]')?.textContent || "").trim(),
      seeAllPresent: Boolean(document.querySelector('[data-testid="home-see-all"]')),
      cardCount: document.querySelectorAll('[data-testid="home-event-card"]').length,
    };
  });

  const result = {
    name,
    hash: await page.evaluate(() => window.location.hash),
    feedVisible: await isShown(page, '[data-testid="home-feed"]'),
    ...shape,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Sign an account in via the email+password "Try another way" path (same as the specs). */
async function signIn(page, account) {
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
}

/** Optionally start serve.mjs from THIS worktree's web/src, on :8081. Returns the child (or null). */
function startServe() {
  if (!START_SERVE) return null;
  const child = spawn("node", [join(HERE, "serve.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PORT: "8081" },
  });
  return child;
}

const serve = startServe();
if (serve) await new Promise((r) => setTimeout(r, 1200)); // let the static server bind

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
await seed(USER);
await seed(ADMIN);
await seedEventsAndRsvp();

const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
await signIn(page, USER);
await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(2000); // role/onboarding resolve + tabbar settle

// Onto #/home via the bottom Home tab (the everyday path), then let the feed fetch + paint.
await page.click("#tab-home");
await page.waitForTimeout(2500); // mount + GET /events + GET /me for the feed
await page.screenshot({ path: shotPath(`TM-969-${LABEL}-home`), fullPage: true });
const p = await probe(page, "home");

await context.close();
await browser.close();
if (serve) serve.kill("SIGTERM");

// ── Verdict ────────────────────────────────────────────────────────────────────────────────────
console.log(`\n[capture] ${LABEL}: Home feed probed`);
const notes = [];
if (p.sectionCount > 0) notes.push(`sections=${p.sectionCount} [${p.sectionTitles.join(" · ")}]`);
else notes.push("no sections (flat feed — before-state)");
// TM-969 product decision: the first content heading is a section header, and no generic "Home" title.
notes.push(`firstContentTitle="${p.firstContentTitle}"${p.hasGenericHomeTitle ? " (⚠ generic 'Home' title still present)" : " (no generic page title)"}`);
if (p.nearYouSubtitle) notes.push(`near-you sub-line="${p.nearYouSubtitle}"`);
if (p.seeAllPresent) notes.push("'See all events →' teaser hand-off present");
notes.push(`cards=${p.cardCount}`);
console.log(`  - ${p.name}: ${notes.join("; ")}`);
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
