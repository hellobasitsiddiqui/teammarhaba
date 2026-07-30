// TM-684 — before/after evidence for the onboarding gate AVATAR: a disabled "Soon" stub (dashed circle,
// non-interactive) → a REAL, optional uploader ("Add a photo", clickable, reuses the profile upload
// path). Mock-mode (pattern: capture-tm1154.mjs / capture-tm1096.mjs): boots serve.mjs, mocks /me so the
// completion gate is the target, reveals #onboarding-view via window.tmOnboarding.enterOnboarding.
//
// BEFORE renders main's stub (point SERVE_SCRIPT at an origin/main worktree's serve.mjs — it serves that
// tree's ../src). AFTER renders this branch's uploader (default serve.mjs). Run the browser from the
// branch's web/e2e either way (it owns node_modules). 390px Android-phone width.
//
// Usage:
//   CAPTURE_LABEL=after  CAPTURE_PORT=8361 CAPTURE_OUT=/abs/dir node capture-tm684.mjs
//   CAPTURE_LABEL=before CAPTURE_PORT=8362 CAPTURE_OUT=/abs/dir \
//     SERVE_SCRIPT=/tmp/tm684-main-wt/web/e2e/serve.mjs node capture-tm684.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm684");
const PORT = Number(process.env.CAPTURE_PORT || 8361);
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main stub) | "after" (branch uploader)
const SERVE = process.env.SERVE_SCRIPT || join(HERE, "serve.mjs");
const BASE = `http://127.0.0.1:${PORT}`;

// A tiny 1x1-ish sample image (data URI) to demonstrate the AFTER filled state without a real upload.
const SAMPLE =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#7ba7c4"/><circle cx="60" cy="46" r="24" fill="#f4ead9"/><rect x="26" y="74" width="68" height="44" rx="22" fill="#f4ead9"/></svg>',
  ).toString("base64");

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // A signed-in-but-not-onboarded user → the completion gate is what renders.
  const me = {
    uid: "capture-user", email: "sam@example.com", displayName: "", firstName: "", lastName: "",
    role: "USER", enabled: true, onboardingCompleted: false, notificationPref: "EMAIL",
    timezone: "Europe/London", locale: "en-GB", phone: "",
    accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
  };
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmOnboarding, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  });
}

async function reveal(page) {
  await page.evaluate(() => {
    const view = document.getElementById("onboarding-view");
    if (view) view.hidden = false;
    window.tmOnboarding.enterOnboarding(() => {});
  });
  await page.waitForSelector("#onboarding-form", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  const stop = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stop);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await reveal(page);
    await settle(page);

    // Tight crop of the avatar control (top of the gate card) — the BEFORE/AFTER contrast lives here.
    const avatar = page.locator(".tm-avatar-uploader").first();
    await avatar.screenshot({ path: join(OUT, `01-${LABEL}-avatar-control.png`) });
    console.log(`  ✓ 01-${LABEL}-avatar-control.png`);

    // Full gate card for context.
    await page.locator(".tm-onboarding-card").first().screenshot({ path: join(OUT, `02-${LABEL}-gate-card.png`) });
    console.log(`  ✓ 02-${LABEL}-gate-card.png`);

    // AFTER only: demonstrate the filled ("Change photo") state by injecting a sample image into the
    // preview (no real Storage upload in mock mode). Proves the picked-photo render path.
    if (LABEL !== "before") {
      await page.evaluate((src) => {
        const ring = document.querySelector(".tm-avatar-uploader .tm-avatar-stub");
        if (!ring) return;
        const img = ring.querySelector(".tm-avatar-img");
        const glyph = ring.querySelector(".tm-avatar-cam");
        if (img) { img.src = src; img.hidden = false; }
        if (glyph) glyph.style.display = "none";
        ring.classList.add("tm-avatar-has-photo");
        const label = document.querySelector(".tm-avatar-uploader .tm-avatar-uploader-label");
        if (label) label.textContent = "Change photo";
      }, SAMPLE);
      await page.waitForTimeout(300);
      await avatar.screenshot({ path: join(OUT, `03-${LABEL}-avatar-with-photo.png`) });
      console.log(`  ✓ 03-${LABEL}-avatar-with-photo.png`);
    }
    await page.close();
  } finally {
    await browser.close();
    stop();
  }
  console.log(`\n[${LABEL}] shots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
