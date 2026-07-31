import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";
import { openAllEventFormSections } from "../helpers/event-form.mjs";

// Admin event CLONE/DUPLICATE e2e (TM-1061, absorbing TM-796) — the automated-test gate for the clone
// flow. Drives the whole path through the real browser + full stack:
//
//   sign in as ADMIN → open the events console → CREATE a source event (with a distinctive heading +
//   opening message) → CLONE it from its row (Clone action) → pick the "+7 days" offset preset → assert
//   the CREATE route with a PRE-FILLED draft: heading copied, START shifted +7 days, OPENING MESSAGE
//   BLANK, and the Clone control was present on the row.
//
// Nothing is persisted by the clone until Save — this spec asserts the pre-filled DRAFT (the review step),
// which is exactly the TM-1061 behaviour that does not exist on main (the Clone control + clone-mode
// prefill are absent), so it fails-before on a pristine tree.
//
// Timezone note: like admin-events.spec.mjs this uses "UTC" on the event so the wall-clock entered equals
// the stored instant and the +7d shift is exact/predictable. This host's local Chromium has no plain "UTC"
// zone (see blackboard) so this spec is a CI-gate spec (dispatch e2e.yml on the branch), matching the other
// admin-events specs it sits beside.

test.beforeEach(async ({ page }) => {
  // Suppress the first-run product tour so its backdrop can't cover the controls under test (TM-147).
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

async function openAdminHub(page) {
  await page.goto("/#/admin");
  await expect(page).toHaveURL(/#\/admin$/);
}

/** A datetime-local value ("YYYY-MM-DDTHH:mm") from a Date's UTC parts — paired with the UTC event zone. */
function localValue(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

/** Add whole days to a "YYYY-MM-DDTHH:mm" wall-clock value, keeping the time of day (the +7d shift). */
function addDaysLocal(local, days) {
  const [d, t] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, mo - 1, da + days));
  const p = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}T${t}`;
}

const HEADING = `E2E Clone Source ${Date.now()}`;
const OPENING = "Welcome! Say hi in the chat when you arrive.";

test("@admin @admin-events admin clones an event into a pre-filled draft with a +7d offset (TM-1061)", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`clone-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 60 * 864e5);
  const startLocal = localValue(start);

  // ── Sign in as the seeded ADMIN + open the events console. ───────────────────────────────────────
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await openAdminHub(page);
  await page.click('.admin-hub-row[href="#/admin/events"]');
  await expect(page.locator("#admin-events-view")).toBeVisible();

  // ── Create the SOURCE event (heading + an opening message we'll assert is blanked on clone). ─────
  await page.click("#admin-events-new");
  await expect(page.locator("#event-form")).toBeVisible();
  await openAllEventFormSections(page);
  await page.fill("#event-heading", HEADING);
  await page.fill("#event-description", "Source event for the TM-1061 clone e2e.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", startLocal);
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));
  await page.fill("#event-opening-message", OPENING);
  const createResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const created = await (await createResponse).json();
  expect(created.heading).toBe(HEADING);

  // ── Back on the list — show all lifecycle buckets so the future-start source row is visible. ─────
  await expect(page).toHaveURL(/#\/admin\/events$/);
  await page.locator("#admin-events-lifecycle-all").click();
  const row = page.locator(`tr[data-event-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await shot("list");

  // ── CLONE: the row carries a Clone control (the TM-1061 seam absent on main). ────────────────────
  const cloneBtn = row.getByRole("button", { name: `Clone ${HEADING}` });
  await expect(cloneBtn).toBeVisible();
  await cloneBtn.click();

  // ── The offset-preset picker: LOCKED to +7 days / +7 hours. Pick +7 days. ────────────────────────
  const picker = page.locator(".tm-dialog");
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("Clone");
  await expect(picker.locator('.tm-clone-offset-btn[data-offset="+7 days"]')).toBeVisible();
  await expect(picker.locator('.tm-clone-offset-btn[data-offset="+7 hours"]')).toBeVisible();
  await shot("offset-picker");
  await picker.locator('.tm-clone-offset-btn[data-offset="+7 days"]').click();

  // ── The pre-filled CREATE draft: create route, heading copied, start shifted +7d, opening BLANK. ─
  await expect(page).toHaveURL(/#\/admin\/events\/new$/);
  await expect(page.locator("#event-form")).toBeVisible();
  await openAllEventFormSections(page);
  await expect(page.locator("#event-heading")).toHaveValue(HEADING);
  // Opening message blanked (LOCKED decision) — never carry stale text.
  await expect(page.locator("#event-opening-message")).toHaveValue("");
  // Start shifted +7 days at the same wall clock (UTC event zone → predictable).
  await expect(page.locator("#event-start")).toHaveValue(addDaysLocal(startLocal, 7));
  // The description carried over (everything-else-copied).
  await expect(page.locator("#event-description")).toHaveValue("Source event for the TM-1061 clone e2e.");
  await shot("clone-draft");

  // ── Nothing was persisted by the clone: no NEW event with the source heading exists yet (only the
  //    source, id=created.id). The clone is a draft until Save — leaving the form creates nothing. ──
  await page.locator("#admin-event-form-back").click();
  // A pre-filled clone is "dirty" (a pending cloned draft), so the back link confirms — discard it.
  const exitDialog = page.locator(".tm-dialog");
  if (await exitDialog.isVisible().catch(() => false)) {
    await exitDialog.getByRole("button", { name: "Discard changes" }).click();
  }
  await expect(page).toHaveURL(/#\/admin\/events$/);
});
