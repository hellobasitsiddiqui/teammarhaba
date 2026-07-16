import { test, expect } from "@playwright/test";

// Papercut copy/formatting polish backfill (TM-689) — behavioural coverage for the merged fix
// (commit bec843c). The papercut batch corrected 14 copy/formatting rough edges in web/src; this
// spec locks the ONE that is a deterministic, no-auth, no-seed DOM assertion: finding #4 —
//
//   index.html:305 — the SMS phone-entry placeholder was a US number "+15555550123" in a GBP/en-GB
//   app; the fix changed it to a UK number "+447700900123".
//
// This is the strongest anchor for the batch because it lives in static markup on the PUBLIC login
// page (no sign-in, no backend seeding, no emulator round-trip), so it's fully deterministic and
// FAILS before the fix (placeholder starts "+1…") / PASSES after (placeholder starts "+44…"). It's
// reached exactly like email-code-login.spec.mjs reaches the SMS step: open #/login, click "Try
// another way" to reveal #/auth-alternatives, then read the #phone field. We assert the concrete
// fixed string AND that the OLD US number is gone, so the test can't pass on the pre-fix DOM.
//
// The other 13 papercuts (empty-state wording, plural day/days, friendly checkout errors, etc.)
// are copy strings on auth-gated / seeded surfaces; this spec deliberately covers the one that is
// verifiable at the login door without inventing seed state. It runs under the default desktop
// `chromium` project (not in playwright.config's mobile testMatch), no shared file touched.

// Suppress the first-run product tour (TM-147) — the identical localStorage init-script every other
// spec uses — so its dimmed backdrop/modal can't overlay the login controls under test. Seeded/fresh
// accounts look "first-run" each run because the emulator wipes their localStorage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

test("@papercuts the SMS phone placeholder is the en-GB UK number, not the old US one (TM-689 #4)", async ({
  page,
}) => {
  // The public login door — no sign-in needed; the SMS fieldset is static markup in index.html.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // Reveal the SMS + email/password alternatives, exactly as email-code-login.spec.mjs does.
  await expect(page.locator("#auth-alternatives")).toBeHidden();
  await page.click("#try-another-btn");
  await expect(page.locator("#auth-alternatives")).toBeVisible();

  const phone = page.locator("#phone");
  await expect(phone).toBeVisible();

  // The load-bearing assertion: the placeholder is the corrected UK/en-GB example number. This is the
  // exact string the fix introduced (index.html:305) and would FAIL on the pre-fix DOM.
  await expect(phone).toHaveAttribute("placeholder", "+447700900123");

  // And prove the papercut is actually gone, not merely that a UK number is also present: the OLD US
  // placeholder ("+15555550123", and any "+1…" example) must NOT be what's shown. Guards against a
  // regression that reintroduces the US number.
  const placeholder = await phone.getAttribute("placeholder");
  expect(placeholder).not.toBe("+15555550123");
  expect(placeholder?.startsWith("+44")).toBe(true);
  expect(placeholder?.startsWith("+1")).toBe(false);
});
