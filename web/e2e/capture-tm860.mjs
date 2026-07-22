// TM-934 (migrated): seeds its account with uniqueTestPhone() (a per-run-unique Ofcom-fictional GB
//   number), not the old shared +447700900123 — under TM-923 strict 1:1 phone uniqueness the shared
//   literal 409s the V48 users_phone_normalized_uq index on any account after the first. Not a CI path.
// TM-860 — before/after visual evidence capture for the interests-picker scroll-preservation fix:
// open the Profile "+ add" interests picker at a phone viewport, scroll the modal body DOWN, tap a
// chip near the bottom, and capture the picker before + after the tap.
//
// ⚠️ HONESTY NOTE (per the TM-865 grounding): the scroll-reset itself does NOT reproduce in desktop
// headless Chromium — desktop preserves scrollTop across the synchronous clear+rebuild; only real
// mobile engines clamp to 0 when the container is wiped mid-frame. So the screenshots document the
// intact UX (scrolled picker, lower chip selected, position + selection kept), while the printed
// MEASUREMENTS carry the mechanism proof this harness CAN see: whether the tapped chip and the
// picker's child nodes survive the tap as the SAME DOM objects (in place = fixed) or are replaced
// (rebuild = the bug). The DOM-identity unit test (web/tools/profile-interest-picker-inplace.test.mjs)
// is the gating regression proof; this script is the visual + full-stack side.
//
// FULL-STACK mode (like the capture-tm881-846 sibling): drives the REAL login + picker + save flows
// against the running e2e stack (Postgres + Auth emulator + backend + serve.mjs). Seeds its OWN
// per-label account (phone PATCH before onboarding-complete — mandatory since TM-880). Run once
// serving main's web/src on :8081 (label=before) and once serving the branch's (label=after) — one
// backend serves both (this PR is web-only); dev CORS only allows :8081, so the sides run in turn.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir node capture-tm860.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID, uniqueTestPhone } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm860");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

// A per-label account so before/after each start identically: onboarded, terms accepted, NO saved
// interests (the "+ add" chip shows while under the max). Emulator-only throwaway credentials.
const USER = { email: `capture-860-${LABEL}@teammarhaba.test`, password: "capture-860-pw-123456" };

const shotPath = (screen) => join(OUT, `TM-860-${LABEL}-${screen}.png`);

/** Seed USER in the Auth emulator + provision it in the backend (phone PATCH before
 *  onboarding-complete — the TM-880 mandatory-phone gate refuses completion without an E.164 phone). */
async function seedUser() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();
  try {
    const existing = await auth.getUserByEmail(USER.email);
    await auth.updateUser(existing.uid, { password: USER.password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      await auth.createUser({ email: USER.email, password: USER.password, emailVerified: true });
    } else {
      throw err;
    }
  }

  // Mint an emulator ID token and walk the backend provisioning path as the user itself.
  const signInUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: USER.email, password: USER.password, returnSecureToken: true }),
  });
  if (!signInRes.ok) throw new Error(`emulator sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  const { idToken } = await signInRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed: ${meRes.status} ${await meRes.text()}`);
  const me = await meRes.json();

  // Name + city (TM-877 allowed list) + phone (TM-880 mandatory) so the account lands in the app.
  const patchRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Cap", lastName: "Ture", city: "London", phone: uniqueTestPhone() }),
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

/** Load a hash route and let the boot splash + fonts settle before anything is captured. */
async function settleGoto(page, hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
}

/** Sign USER in via the email+password "Try another way" path (same as the specs). */
async function signIn(page) {
  await settleGoto(page, "#/login");
  await page.fill("#email", USER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", USER.password);
  await page.click("#signin-btn");
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

// Suppress the first-run product tour — its dimmed overlay would sit over the picker under test.
// Same approach as the tm830 spec: any `tm.tour.*` key reads as done.
await page.addInitScript(() => {
  const orig = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) {
    return typeof k === "string" && k.startsWith("tm.tour.")
      ? JSON.stringify({ done: true })
      : orig.call(this, k);
  };
});

await seedUser();
await signIn(page);

// Navigate to the profile hub with the interests-catalogue wait ARMED first (tm830 pattern), so the
// "+ add" click can never race an unloaded catalogue (which would open the honest "not available yet"
// modal instead of the tall picker under test).
const catalogueLoaded = page.waitForResponse(
  (r) => r.url().includes("/api/v1/interests/catalogue") && r.request().method() === "GET",
);
await page.evaluate(() => (window.location.hash = "#/profile"));
await page.waitForSelector("#profile-view", { state: "visible", timeout: 20_000 });
await catalogueLoaded;

// Open the picker and scroll its body DOWN — the bug's setup: the user is deep in the list.
await page.locator(".tm-pf-chip-add", { hasText: "add" }).click();
await page.waitForSelector(".tm-dialog.tm-modal .tm-pf-picker-count", { state: "visible", timeout: 10_000 });
await page.evaluate(() => {
  const body = document.querySelector(".tm-dialog.tm-modal .tm-modal-body");
  body.scrollTop = body.scrollHeight; // jump to the very bottom of the catalogue
});
await page.waitForTimeout(400); // let the scroll + any lazy paint settle

// Freeze the pre-tap truth: the scroll position, the picker's child nodes, and the LAST fully
// visible chip (the "chip near the bottom" from the bug report) — all held as live references so
// the post-tap measurement can tell "same nodes repainted" from "rebuilt copies".
const target = await page.evaluate(() => {
  const body = document.querySelector(".tm-dialog.tm-modal .tm-modal-body");
  const picker = body.querySelector(".tm-pf-picker");
  const chips = [...picker.querySelectorAll(".tm-pf-picker-opt")];
  const inView = chips.filter((c) => {
    const r = c.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return r.top >= b.top && r.bottom <= b.bottom;
  });
  const chip = inView[inView.length - 1] || chips[chips.length - 1];
  window.__tm860 = { body, picker, chip, children: [...picker.children], scrollTop: body.scrollTop };
  return { label: chip.textContent.trim(), index: chips.indexOf(chip), scrollTop: body.scrollTop };
});
console.log(`[capture] tapping chip #${target.index} ("${target.label}") at scrollTop=${target.scrollTop}`);

await page.screenshot({ path: shotPath("picker-scrolled") });

// The bug's gesture: a real coordinate click on that lower chip.
await page.locator(".tm-pf-picker-opt").nth(target.index).click();
await page.waitForTimeout(400); // let any (before-side) rebuild + reflow land

// Post-tap measurement: scroll position + DOM identity + the visible selection state.
const result = await page.evaluate(() => {
  const { body, picker, chip, children, scrollTop } = window.__tm860;
  const now = [...picker.children];
  const currentChips = [...picker.querySelectorAll(".tm-pf-picker-opt")];
  const byLabel = currentChips.find((c) => c.textContent.trim() === chip.textContent.trim());
  return {
    scrollTopBefore: scrollTop,
    scrollTopAfter: body.scrollTop,
    // The mechanism this desktop harness CAN discriminate: in-place repaint keeps the same nodes.
    samePickerChildren: now.length === children.length && now.every((n, i) => n === children[i]),
    tappedChipStillInDocument: document.contains(chip),
    // The user-visible outcome (true on both sides — selection always persisted; only scroll broke).
    chipShowsSelected: Boolean(byLabel && byLabel.classList.contains("tm-pf-chip-on") &&
      byLabel.getAttribute("aria-pressed") === "true"),
    countText: picker.querySelector(".tm-pf-picker-count")?.textContent ?? null,
  };
});
console.log(`[capture] ${LABEL} measurements: ${JSON.stringify(result, null, 2)}`);

await page.screenshot({ path: shotPath("after-select") });

// Prove the picker's existing save path is intact end-to-end: Save PATCHes /me and toasts.
await page.locator(".tm-pf-picker-actions .tm-btn-primary", { hasText: "Save" }).click();
await page.getByText("Interests updated.").waitFor({ timeout: 20_000 });
await page.screenshot({ path: shotPath("saved-toast") });

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
