// TM-885 investigation — path 5: the post-#587 phone completion re-gate.
// Precondition: the capture-885-<label> account exists, is onboarded, but has phone = NULL in the DB
// (simulating an account provisioned before the TM-880 mandatory-phone rule).
// Walk: sign in → observe where the router lands → try to reach #/profile → probe + screenshot.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm885-886");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "before";
const USER = { email: `capture-885-${LABEL}@teammarhaba.test`, password: "capture-885-pw-123456" };
const SETTLE = 4500;

async function isShown(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, selector);
}

async function probe(page, name) {
  const result = {
    name,
    hash: await page.evaluate(() => window.location.hash),
    tabbarVisible: await isShown(page, "#app-tabbar"),
    loginCardVisible: await isShown(page, "#auth-signed-out"),
    shellH1Visible: await isShown(page, "main.app > h1"),
    taglineVisible: await isShown(page, "main.app > .tagline"),
    statusVisible: await isShown(page, "#status"),
    statusText: await page.evaluate(() => document.getElementById("status")?.textContent ?? null),
    onboardingViewVisible: await isShown(page, "#onboarding-view"),
    onboardingHeading: await page.evaluate(
      () => document.querySelector("#onboarding-view h2, #onboarding-view h1")?.textContent ?? null),
    profileViewVisible: await isShown(page, "#profile-view"),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

// Sign in fresh (cold), landing wherever the router sends a phone-less onboarded account.
await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(SETTLE);
await page.fill("#email", USER.email);
await page.click("#try-another-btn");
await page.fill("#password", USER.password);
await page.click("#signin-btn");
await page.waitForTimeout(5000); // navigate + role/me resolve + re-gate
await page.screenshot({ path: join(OUT, `TM-885-${LABEL}-5-regate-after-login.png`) });
await probe(page, "5-regate-after-login");

// Now explicitly try to reach the profile (the tab bar may be hidden — use the hash directly, as a
// user following a bookmark / deep link would).
await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(SETTLE);
await page.waitForTimeout(2000);
await page.screenshot({ path: join(OUT, `TM-885-${LABEL}-6-regate-profile-deeplink.png`) });
await probe(page, "6-regate-profile-deeplink");

await browser.close();
console.log(`[capture] re-gate shots written to ${OUT}`);
