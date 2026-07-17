// Shared e2e helper for walking a BRAND-NEW user through the first-login onboarding flow (TM-851).
//
// WHY THIS EXISTS
// ---------------
// Onboarding is now a TWO-step flow inside the single `#onboarding-view` (TM-776 / TM-804):
//
//     profile gate  →  interests picker  →  (router hands off to the terms gate)
//
//   1. PROFILE gate (TM-250): the atomic Name/Location/Age form (`#onboarding-form`). Submitting it
//      POSTs `/api/v1/me/onboarding` and lifts the all-or-nothing onboarding-complete gate. The view
//      does NOT close yet — instead onboarding.js swaps the SAME `#onboarding-view` to the interests step.
//   2. INTERESTS picker (TM-776/TM-804): "What are you into?" — a category-grouped set of toggle chips
//      (`.tm-interests-chip`, each with a `data-label`). A hard min-1 gate (seed config min 1 / max 3,
//      migration V45) keeps the full-width "Continue" CTA (`.tm-interests-continue`) DISABLED until at
//      least the minimum are selected. Continue PATCHes `/api/v1/me` with `{ interests: [...] }`, then
//      calls onComplete() → the router re-guards → the TERMS gate (or the app if terms already accepted).
//
// The specs that walk a fresh user onboarding→terms used to submit the profile and immediately expect
// `#terms-view`. Since the interests step landed they strand on it and time out. This helper centralises
// the whole profile→interests walk so the four onboarding specs share ONE definition — a future
// onboarding change is a one-file edit here, not four.
//
// GROUNDING (all selectors verified against web/src/assets/onboarding.js):
//   • `#onboarding-view`                 the single onboarding container (both steps render into it).
//   • `#onboarding-form`                 the profile-gate form (step 1).
//   • `#onboarding-name/-location/-age`  the three required profile inputs (buildField: id `onboarding-<field>`).
//   • `#onboarding-form button[type=submit]`  the profile "Continue" submit (buildShell: type:"submit").
//   • `.tm-interests-chip[data-label]`   a toggle chip in the interests step (buildChip).
//   • `.tm-interests-continue`           the interests "Continue" CTA (buildInterestsStep; disabled until canFinish).
//   • PATCH /api/v1/me                   the interests save (submitInterests → updateMe({interests})).
//
// ROBUSTNESS: the interests step SELF-SKIPS if the catalogue/config fetch fails (onboarding.js
// enterInterestsStep, ~line 239-245) — the gate has already lifted so a fetch failure hands straight to
// the router (→ terms) rather than trapping the user. In the hermetic e2e the catalogue IS seeded (V45),
// so the step WILL appear; but we still complete it defensively: if the interests step is present we
// finish it, and if `#terms-view` (or the app) is already showing we simply return.

import { expect } from "@playwright/test";

/**
 * Complete the interests PICK step of onboarding, if it is present.
 *
 * The profile submit has already lifted the onboarding gate; onboarding.js has swapped `#onboarding-view`
 * to the interests picker (unless the catalogue fetch failed, in which case the step self-skipped and the
 * router has already moved us on). This:
 *   1. waits briefly for EITHER the interests step to render OR the onboarding view to have already closed
 *      (the self-skip / already-past case);
 *   2. if the interests picker is showing, clicks enough enabled chips to satisfy the minimum (the seed
 *      config is min 1 / max 3, so a single selectable chip is enough — we click up to the max as a safe
 *      cushion but stop as soon as Continue is enabled), then clicks the "Continue" CTA and awaits the
 *      interests PATCH /api/v1/me before returning;
 *   3. if the interests step never appears (self-skip, or already past it), it returns without error.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function completeInterestsStep(page) {
  const view = page.locator("#onboarding-view");
  const continueBtn = page.locator(".tm-interests-continue");

  // Wait until the picture is settled: either the interests Continue CTA is on screen (the step rendered)
  // or the whole onboarding view has closed (the step self-skipped / we're already past it). Polling both
  // avoids racing the async catalogue fetch that builds the step.
  await expect
    .poll(
      async () => {
        if (await continueBtn.count()) return "interests";
        if (await view.isHidden().catch(() => true)) return "gone";
        return "waiting";
      },
      { timeout: 15_000, message: "waiting for the interests step to render or onboarding to close" },
    )
    .not.toBe("waiting");

  // If the onboarding view has already closed, the interests step was skipped or already completed —
  // nothing to do here; the caller's terms assertion takes over.
  if (!(await continueBtn.count())) return;

  await expect(continueBtn).toBeVisible();

  // Select enabled chips until "Continue" is enabled (the min-1 gate is satisfied). We click at most the
  // max (3) as a cushion, but stop the moment Continue enables so we never blow the hard max cap (which
  // would dim the remaining chips). Chips are `.tm-interests-chip` and Playwright's click auto-scrolls
  // the chip into view (matters at the Pixel-5 mobile viewport golden-path also runs under).
  const chips = page.locator(".tm-interests-chip:not([disabled])");
  const MAX_TO_CLICK = 3;
  for (let clicked = 0; clicked < MAX_TO_CLICK; clicked++) {
    if (await continueBtn.isEnabled()) break;
    const next = chips.first();
    // Once every remaining enabled chip has been exhausted (shouldn't happen with the seeded catalogue),
    // stop rather than hang — Continue's state assertion below will surface any real problem.
    if (!(await next.count())) break;
    await next.scrollIntoViewIfNeeded();
    await next.click();
  }

  // The min is now met, so the CTA must be enabled before we click it.
  await expect(continueBtn).toBeEnabled();

  // Continue saves the picks via PATCH /api/v1/me { interests: [...] } (onboarding.js submitInterests →
  // updateMe). Await that PATCH so the router hand-off (→ terms) has actually fired before we return.
  const savedInterests = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH",
  );
  await continueBtn.click();
  await savedInterests;
}

/**
 * Walk a brand-new user through the WHOLE first-login onboarding flow: the profile gate THEN the
 * interests picker, leaving the app on the terms gate (or in the app if terms are already accepted).
 *
 * Robust against the onboarding gate's async prefill (TM-590): onboarding.js `load()` fires a mount
 * GET /api/v1/me and pre-fills the form from it. For a brand-new user that prefill is BLANK, so a value
 * typed BEFORE the response lands is clobbered back to empty — the submit then no-ops on empty-field
 * validation and NO POST fires. We defend against that by retrying the fill+submit until the profile step
 * is actually left (the view swaps to the interests step, or — on a catalogue-fetch skip — closes).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{name?: string, location?: string, age?: (string|number)}} [profile] the three required
 *   fields (name / location / age). Sensible defaults are used for any omitted field.
 */
export async function completeOnboarding(page, profile = {}) {
  const { name = "E2E Tester", location = `Testville-${Date.now()}`, age = 30 } = profile;

  await expect(page.locator("#onboarding-form")).toBeVisible();

  // Fill + submit the profile gate, retrying if a late blank prefill clobbers the fields. We consider the
  // profile step "left" once the profile FORM is gone from the view — that happens whether the view swaps
  // to the interests step (the normal path) or closes outright (the interests self-skip path).
  await expect(async () => {
    // Already left the profile step (a prior iteration's submit landed)? Nothing more to fill.
    if ((await page.locator("#onboarding-form").count()) === 0) return;
    if (await page.locator("#onboarding-form").isHidden()) return;
    await page.fill("#onboarding-name", name);
    await page.fill("#onboarding-location", location);
    await page.fill("#onboarding-age", String(age));
    await page.click("#onboarding-form button[type=submit]");
    // The profile form is replaced once the POST succeeds (→ interests step) — or the whole view closes on
    // a catalogue-fetch skip. If a late prefill wiped the fields the submit no-ops and the form stays, so
    // this times out and the outer retry re-fills (the prefill has since landed, so the values now stick).
    await expect(page.locator("#onboarding-form")).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  // Then walk the interests picker (a no-op if it self-skipped / we're already past it).
  await completeInterestsStep(page);
}
