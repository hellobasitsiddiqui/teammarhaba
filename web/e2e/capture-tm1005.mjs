// TM-1005 evidence capture — the "verify your number" dead-end, before vs after.
//
// STATIC-SERVE + DOM-STAGE at 390px (the accepted TM-992 pattern: no backend / Firebase needed): serve
// the real app shell (styles.css, theme tokens) and stage the two states of the profile phone field
// with the TM-992 grace banner above it, using the REAL in-page modules (ui.js el(), countries.js,
// phone-reverify-core.reverifyNoticeText, and — for the AFTER shot — the REAL TM-1005 rule
// profile-core.phoneCurrentNeedsVerify deciding the affordance's visibility):
//
//   1. BEFORE (the dead-end, = prod/main): the banner nags "Please verify your phone number…", but the
//      profile phone field offers NOTHING for the unchanged stored number — the TM-982 "Send code"
//      only reveals on a phone CHANGE, and the banner CTA bounced off #/onboarding. No way forward.
//   2. AFTER (this branch): the same scene now shows the "Verify this number" affordance under the
//      phone field — visibility computed by the SHIPPED phoneCurrentNeedsVerify(stored, composed,
//      verifiedPhone) over the staged account state (stored=+44 7700 900123, nothing linked).
//
// Run: node web/e2e/serve.mjs &  then  node web/e2e/capture-tm1005.mjs  (PORT defaults to 8081).
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1005");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
// The boot splash holds ~3.2s over the shell — settle well past it (QA-harness note) before staging.
const SETTLE = 800;
const SPLASH_SETTLE = 4500;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(SPLASH_SETTLE);
// Clear the boot splash + the signed-out login card so the staged profile scene is the only content —
// we're not signing in (static serve, no backend); the shell chrome + tokens are the real ones.
await page.evaluate(() => {
  for (const id of ["boot-screen", "splash", "boot-splash"]) document.getElementById(id)?.remove();
  document.querySelector(".tm-boot-splash, .boot-splash")?.remove();
  document.getElementById("auth-signed-out")?.remove();
  document.getElementById("login-view")?.remove();
});

/**
 * Stage the whole scene: the TM-992 grace banner (real copy) + an "Edit profile" card holding the
 * phone field with the stored number prefilled, and — when `withAffordance` — the TM-1005 "Verify this
 * number" button, its visibility decided by the REAL phoneCurrentNeedsVerify over the staged state.
 */
async function stageScene(withAffordance, file) {
  const result = await page.evaluate(async ({ withAffordance }) => {
    const { el } = await import("/assets/ui.js");
    const { reverifyNoticeText } = await import("/assets/phone-reverify-core.js");
    const { COUNTRIES, flagOf } = await import("/assets/countries.js");

    // Reset any previous stage.
    document.getElementById("phone-reverify-notice")?.remove();
    document.getElementById("tm1005-stage")?.remove();
    const app = document.querySelector("main.app") || document.body;

    // ── The TM-992 grace banner, exactly as phone-reverify-notice.js paints it (no deadline → the
    // safe-default copy). Present in BOTH shots: the nag is the same; what changes is the way out.
    const banner = el("div", {
      id: "phone-reverify-notice",
      class: "tm-verify-banner tm-phone-reverify-notice",
      role: "status",
      "aria-live": "polite",
    });
    banner.appendChild(el("span", { class: "tm-verify-banner-icon", "aria-hidden": "true", text: "📱" }));
    banner.appendChild(el("span", { class: "tm-verify-banner-text", text: reverifyNoticeText(null) }));
    banner.appendChild(
      el("span", { class: "tm-verify-banner-actions" }, [
        el("button", { type: "button", class: "tm-verify-banner-resend", text: "Verify now" }),
        el("button", { type: "button", class: "tm-verify-banner-dismiss", "aria-label": "Dismiss", text: "×" }),
      ]),
    );
    app.prepend(banner);

    // ── The profile "Edit profile" card's phone field (buildField's phone shape: country picker +
    // national input in the committed tm-phone-row, hint below), prefilled with the STORED number.
    const gb = COUNTRIES.find((c) => c.iso2 === "GB");
    const picker = el(
      "select",
      { id: "profile-phone-country", class: "tm-input tm-phone-country", "aria-label": "Phone country" },
      [el("option", { value: "GB", text: `${flagOf("GB")} ${gb.name} +${gb.dial}` })],
    );
    const input = el("input", { id: "profile-phone", class: "tm-input", type: "tel", value: "7700 900123" });

    // ── The TM-1005 affordance (profile.js's buildPhoneVerify send button, current-number label).
    // AFTER only — and even then its visibility is not hardcoded: the REAL shipped rule decides it
    // from the staged account state (stored number unchanged in the form, nothing Firebase-linked).
    let shown = false;
    const verifyBtn = el("button", {
      id: "profile-phone-send",
      type: "button",
      class: "tm-btn tm-phone-send",
      text: "Verify this number",
      hidden: true,
    });
    if (withAffordance) {
      const { phoneCurrentNeedsVerify } = await import("/assets/profile-core.js");
      shown = phoneCurrentNeedsVerify("+447700900123", "+447700900123", null);
      verifyBtn.hidden = !shown;
    }

    const card = el("section", { id: "tm1005-stage", class: "tm-pf-card tm-pf-edit" }, [
      el("h3", { class: "tm-pf-ctitle", text: "Edit profile" }),
      el("div", { class: "tm-form-field" }, [
        el("label", { class: "tm-field-label", for: "profile-phone", text: "Phone" }),
        el("div", { class: "tm-field-fill tm-phone-row" }, [picker, input]),
        el("p", {
          class: "tm-muted tm-field-hint",
          text: "Pick a country, then the national number — digits, spaces and ( ) . / - only.",
        }),
        verifyBtn,
      ]),
    ]);
    banner.insertAdjacentElement("afterend", card);
    return { shown };
  }, { withAffordance });

  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: join(OUT, file) });
  console.log(`[capture] wrote ${file} (affordance shown: ${result.shown})`);
  return result;
}

const before = await stageScene(false, "TM-1005-1-before-dead-end.png");
const after = await stageScene(true, "TM-1005-2-after-verify-affordance.png");
if (before.shown || !after.shown) {
  throw new Error(`unexpected affordance state: before=${before.shown} after=${after.shown}`);
}

await browser.close();
console.log(`[capture] TM-1005 shots written to ${OUT}`);
