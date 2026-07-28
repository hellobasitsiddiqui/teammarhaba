// TM-373 (Sent-notification HISTORY) + TM-1098 (audience-targeting CHIPS) — before/after visual evidence
// for the Send-notification screen (#/admin/notifications), at an Android-phone viewport (390×844).
//
// STATIC-RENDER harness (NOT the full e2e stack). It serves web/src over a tiny local http server, mounts
// the REAL admin-notifications.js view with the REAL styles.css, and redirects ./api.js to an in-page
// STUB (via an import map) so no Firebase / backend / network is touched — the view renders against fixed
// fake data. This is the "static-serve + real-styles.css harness" the ticket allows when the SPA can't be
// booted locally (no emulator). A FULL e2e run (dispatch e2e.yml on the branch) is the belt-and-braces path.
//
// Shots (390×844):
//   • TM373-1098-<label>-compose          — Compose tab: targeting chips (City/Age/Gender/Active-24h) above
//                                           the recipient roster (AFTER); BEFORE has no chips + no tabs.
//   • TM373-1098-<label>-compose-filtered — AFTER: after picking City=London + Age 25–34, the roster is
//                                           narrowed and the active chips read pressed.
//   • TM373-1098-<label>-history          — AFTER: the History tab listing past sends (title / reach / time).
//
// Usage:  CAPTURE_LABEL=after CAPTURE_OUT=/abs/dir node capture-tm373-1098.mjs

import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "..", "src");
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm373-1098");
const LABEL = process.env.CAPTURE_LABEL || "after";
const VIEWPORT = { width: 390, height: 844 };
const PORT = Number(process.env.CAPTURE_PORT || 8144);

const PW = process.env.PLAYWRIGHT_MODULE
  || "/Users/basitsiddiqui/Projects/TeamMarhaba/teammarhaba/web/e2e/node_modules/playwright/index.js";
const pwMod = await import(PW);
const chromium = pwMod.chromium || pwMod.default?.chromium;

const shotPath = (name) => join(OUT, `${name}.png`);

const MIME = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html", ".svg": "image/svg+xml", ".mjs": "text/javascript" };

// The in-page ./api.js stub source — exports exactly what admin-notifications.js imports, backed by fixed
// data (no network). A spread of users across cities / ages / genders / recency so the chips can narrow.
function apiStubSource() {
  const users = [
    { id: 1, email: "aisha@example.com", displayName: "Aisha Khan", city: "London", age: 30, gender: "FEMALE", pushEligible: true, __act: 1 },
    { id: 2, email: "ben@example.com", displayName: "Ben Carter", city: "London", age: 41, gender: "MALE", pushEligible: true, __act: 50 },
    { id: 3, email: "chloe@example.com", displayName: "Chloe Davies", city: "Milton Keynes", age: 27, gender: "FEMALE", pushEligible: true, __act: 2 },
    { id: 4, email: "dan@example.com", displayName: "Dan Evans", city: "Karachi", age: 55, gender: "MALE", pushEligible: true, __act: 3 },
    { id: 5, email: "erin@example.com", displayName: "Erin Foster", city: "London", age: 22, gender: "FEMALE", pushEligible: true, __act: 80 },
    { id: 6, email: "sam@example.com", displayName: "Sam Green", city: "Sharjah", age: 33, gender: "MALE", pushEligible: false, __act: 1 },
  ];
  const broadcasts = [
    { id: 30, title: "Doors open at 7 tonight", body: "See you at the venue — grab a seat early!", route: "#/events", recipientCount: 42, delivered: 38, skipped: 4, __act: 1 },
    { id: 29, title: "New events this weekend", body: "Three meetups just landed near you. Take a look.", route: "#/home", recipientCount: 120, delivered: 110, skipped: 10, __act: 26 },
    { id: 28, title: "Welcome to Circle", body: "Thanks for joining — complete your profile to get matched.", route: "#/profile", recipientCount: 15, delivered: 15, skipped: 0, __act: 72 },
  ];
  return `
    const h = (n) => new Date(Date.now() - n * 3600e3).toISOString();
    const USERS = ${JSON.stringify(users)}.map(u => ({ ...u, lastActiveAt: h(u.__act) }));
    const BROADCASTS = ${JSON.stringify(broadcasts)}.map(b => ({ ...b, sentAt: h(b.__act) }));
    export class ApiError extends Error { constructor(status, message){ super(message); this.status = status; } }
    export async function apiFetch(path) {
      if (path.startsWith("/api/v1/admin/users")) {
        return { ok: true, status: 200, json: async () => ({ items: USERS, page: 0, size: 100, totalElements: USERS.length, totalPages: 1 }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    export async function getPushRoutes() { return { routes: ["#/home", "#/events", "#/profile"] }; }
    export async function adminBroadcastPush() { return { sent: 1, delivered: 1, skipped: 0 }; }
    export async function listBroadcastHistory({ page = 0, size = 20 } = {}) {
      const start = page * size;
      return { items: BROADCASTS.slice(start, start + size), page, size, totalElements: BROADCASTS.length, totalPages: Math.ceil(BROADCASTS.length / size) };
    }
  `;
}

const BASE = `http://127.0.0.1:${PORT}`;

/** The standalone capture page: real styles.css + an import map redirecting the http api.js to the stub. */
function pageHtml(styles) {
  const importMap = { imports: { [`${BASE}/assets/api.js`]: `${BASE}/__api_stub.js` } };
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styles}</style>
<style>body{margin:0;background:var(--bg,#fff);} main{padding:12px;}</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head><body data-theme="paper">
<main class="app">
  <section id="admin-notifications-view" class="admin-console" aria-label="Send notification"></section>
</main>
<script type="module">
  import { enterAdminNotifications } from "${BASE}/assets/admin-notifications.js";
  window.__enter = enterAdminNotifications;
  window.__ready = true;
</script>
</body></html>`;
}

async function startServer() {
  const styles = await readFile(join(WEB_SRC, "assets", "styles.css"), "utf8");
  const stub = apiStubSource();
  const html = pageHtml(styles);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/" || req.url.startsWith("/capture.html")) {
        res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return;
      }
      if (req.url === "/__api_stub.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(stub); return;
      }
      // Serve everything under /assets and /api-docs from web/src.
      const rel = decodeURIComponent(req.url.split("?")[0]);
      const file = join(WEB_SRC, rel.replace(/^\//, ""));
      const buf = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  return server;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERROR:", m.text()); });
  page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", e.message));

  await page.goto(`${BASE}/capture.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
  await page.evaluate(() => window.__enter());
  await page.waitForSelector("#admin-notifications-chips, #admin-notifications-roster", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(700);

  await page.screenshot({ path: shotPath(`TM373-1098-${LABEL}-compose`), fullPage: true });
  console.log("shot: compose");

  const london = page.locator(".tm-chip", { hasText: "London" }).first();
  const age = page.locator(".tm-chip", { hasText: "25–34" }).first();
  if ((await london.count()) && (await age.count())) {
    await london.click();
    await age.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(`TM373-1098-${LABEL}-compose-filtered`), fullPage: true });
    console.log("shot: compose-filtered");
    const clear = page.locator(".tm-chip-clear");
    if (await clear.count()) await clear.click();
  } else {
    console.log("no chips present (BEFORE tree) — skipping filtered shot");
  }

  const historyTab = page.locator("#admin-notifications-tab-history");
  if (await historyTab.count()) {
    await historyTab.click();
    await page.waitForSelector(".tm-sent-list, .tm-empty", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath(`TM373-1098-${LABEL}-history`), fullPage: true });
    console.log("shot: history");
  } else {
    console.log("no History tab (BEFORE tree) — skipping history shot");
  }

  await browser.close();
  server.close();
  console.log(`done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
