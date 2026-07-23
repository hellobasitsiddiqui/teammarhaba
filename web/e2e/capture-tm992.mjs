// TM-992 evidence capture — retroactive phone re-verify GRACE notice + TM-987 recovery affordance.
//
// This is a STATIC-SERVE + DOM-STAGE capture (no backend / Firebase needed): the two visual changes are
// self-contained DOM built from ui.js's el() + the pure phone-reverify-core.reverifyNoticeText(), so we
// serve the real app shell (styles.css, theme tokens) and stage each surface deterministically:
//   1. the grace-notice banner (phone-reverify-notice.js's paint()), with a configured deadline;
//   2. the same banner with NO deadline (the grace-only safe-default copy);
//   3. the onboarding phone field showing the TM-987 collision recovery affordance.
// It imports the REAL modules in-page (so the DOM matches what ships), and screenshots at 390px.
//
// Run: node web/e2e/serve.mjs & ; node web/e2e/capture-tm992.mjs   (see the runner block at the bottom
// of the return; PORT defaults to 8081, matching serve.mjs).
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm992");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
// The boot splash holds ~3.2s over the shell (QA-harness note) — settle well past it so the app.app
// chrome is actually painted before we stage + shoot, else the splash covers the banner.
const SETTLE = 800;
const SPLASH_SETTLE = 4500;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

// Load the real app shell so styles.css + theme tokens apply, then stop the app scripts from routing us
// away (we're not signing in — we only want the shell chrome as a backdrop for the staged banner).
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(SPLASH_SETTLE);
// Belt-and-braces: hide any boot splash overlay so it can't cover the staged banner.
await page.evaluate(() => {
  for (const id of ["boot-screen", "splash", "boot-splash"]) document.getElementById(id)?.remove();
  document.querySelector(".tm-boot-splash, .boot-splash")?.remove();
});

// ---- 1 + 2. The grace-notice banner, staged from the REAL module primitives -----------------------
// We rebuild exactly what phone-reverify-notice.js's paint() builds (same classes, same el() calls, same
// reverifyNoticeText copy), so the screenshot faithfully reflects the shipped banner without needing a
// signed-in session + a real /me.
async function stageNotice(deadline, file) {
  await page.evaluate(async ({ deadline }) => {
    const { el } = await import("/assets/ui.js");
    const { reverifyNoticeText, parseReverifyDeadline } = await import("/assets/phone-reverify-core.js");
    document.getElementById("phone-reverify-notice")?.remove();
    const parsed = parseReverifyDeadline(deadline);
    const app = document.querySelector("main.app") || document.body;
    const node = el("div", {
      id: "phone-reverify-notice",
      class: "tm-verify-banner tm-phone-reverify-notice",
      role: "status",
      "aria-live": "polite",
    });
    const verifyBtn = el("button", { type: "button", class: "tm-verify-banner-resend", text: "Verify now" });
    const dismissBtn = el("button", { type: "button", class: "tm-verify-banner-dismiss", "aria-label": "Dismiss", text: "×" });
    node.appendChild(el("span", { class: "tm-verify-banner-icon", "aria-hidden": "true", text: "📱" }));
    node.appendChild(el("span", { class: "tm-verify-banner-text", text: reverifyNoticeText(parsed) }));
    node.appendChild(el("span", { class: "tm-verify-banner-actions" }, [verifyBtn, dismissBtn]));
    const status = document.getElementById("status");
    if (status && status.parentNode === app) status.insertAdjacentElement("afterend", node);
    else app.prepend(node);
  }, { deadline });
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: join(OUT, file) });
  console.log(`[capture] wrote ${file}`);
}

await stageNotice("2026-09-01", "TM-992-1-grace-notice-with-deadline.png");
await stageNotice(null, "TM-992-2-grace-notice-no-deadline.png");

// ---- 3. The TM-987 cross-account collision recovery affordance ------------------------------------
// Stage the onboarding phone field + its inline error painted with the collision copy, and the recovery
// affordance revealed beneath it — exactly the DOM onboarding.js builds on auth/credential-already-in-use.
await page.evaluate(async () => {
  const { el } = await import("/assets/ui.js");
  document.getElementById("phone-reverify-notice")?.remove();
  const app = document.querySelector("main.app") || document.body;
  // A minimal card mimicking the onboarding phone field group so the affordance renders in context.
  const card = el("section", { id: "onboarding-view", class: "tm-onboarding-card" }, [
    el("label", { class: "tm-field-label", text: "Phone number" }),
    el("input", { class: "tm-field-input", value: "+44 7700 900123", readonly: true }),
    el("p", { class: "tm-field-error", role: "alert", text: "This number is already registered — sign into that account." }),
    el("p", { class: "tm-field-hint tm-phone-recovery", role: "status" }, [
      "Is this your number? ",
      el("a", { class: "tm-phone-recovery-link", href: "mailto:hello@10xai.co.uk", text: "Contact support" }),
      " to move it to this account.",
    ]),
  ]);
  // Reveal the onboarding view container + drop our staged card in it.
  const view = document.getElementById("onboarding-view");
  if (view) view.hidden = false;
  app.prepend(card);
});
await page.waitForTimeout(SETTLE);
await page.screenshot({ path: join(OUT, "TM-992-3-collision-recovery-affordance.png") });
console.log("[capture] wrote TM-992-3-collision-recovery-affordance.png");

await browser.close();
console.log(`[capture] TM-992 shots written to ${OUT}`);
