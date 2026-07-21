import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Admin interests console "Selected by" column e2e (TM-832) — the automated gate for the per-interest
// selection analytics (selector count + percent). Drives the whole flow through the real browser + full
// stack + Postgres:
//
//   seed a user_interest selection of the "Yoga" catalogue label (tied to the signed-in ADMIN's own
//   account, via the DB seam) → sign in as ADMIN → open the interests console from the admin hub →
//   assert the "Selected by" COLUMN header renders → assert the "Yoga" row's cell is populated as
//   "<count> (<pct>%)" with a NON-ZERO count (the seeded selection is tallied), proving the column joins
//   the /stats endpoint to the catalogue rows by label end-to-end.
//
// Scope: count + percent only — the gender split is deferred (TM-955), so nothing gender is asserted.
//
// The selection is seeded directly into user_interest (a free-text SNAPSHOT, TM-773) rather than driven
// through the picker UI, so this spec stays focused on the admin analytics column, not the onboarding
// flow. It is cleaned up in an afterEach so the shared DB isn't polluted. "Yoga" is a V45 seed label.

const SEED_LABEL = "Yoga";
const SEED_CATEGORY = "Sport & Fitness";

// Suppress the first-run product tour so its dimmed backdrop can't cover the console (TM-147 pattern).
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

/** Open the account nav if collapsed behind the hamburger (phone width); a no-op at desktop width. */
async function openNav(page) {
  const toggle = page.locator("#nav-toggle");
  if (await toggle.isVisible()) {
    const nav = page.locator(".app-nav");
    if ((await nav.getAttribute("data-nav-open")) !== "true") {
      await toggle.click();
      await expect(nav).toHaveAttribute("data-nav-open", "true");
    }
  }
}

async function clickNav(page, selector) {
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

/** Remove the throwaway selection this spec seeds (keyed on the ADMIN account + the seed label). */
async function cleanUpSeededSelection() {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    await client.query(
      `delete from user_interest
         where label = $1
           and user_id in (select id from users where email = $2)`,
      [SEED_LABEL, ADMIN.email],
    );
  } finally {
    await client.end();
  }
}

test.afterEach(async () => {
  await cleanUpSeededSelection();
});

test("@admin @admin-interests the console shows a 'Selected by' count+percent for a selected interest", async ({
  page,
}, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`admin-interests-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // ── STEP 1: sign in as the seeded ADMIN (email+password under "Try another way"). ──────────────
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page);
  await expect(page.locator("#nav-admin")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── STEP 2: seed a selection of the "Yoga" catalogue label for the ADMIN's own account (DB seam).
  //    Sign-in has now provisioned the ADMIN's users row, so its id resolves; the selection is a
  //    free-text snapshot (TM-773) carrying the label the "Selected by" column joins on. ──────────
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    await client.query(
      `insert into user_interest (user_id, label, category, source_interest_id)
         select u.id, $1, $2, (select id from interest_catalogue where label = $1 limit 1)
           from users u
          where u.email = $3`,
      [SEED_LABEL, SEED_CATEGORY, ADMIN.email],
    );
  } finally {
    await client.end();
  }

  // ── STEP 3: open the interests console via the admin hub. ──────────────────────────────────────
  await clickNav(page, "#nav-admin");
  await page.click('.admin-hub-row[href="#/admin/interests"]');
  await expect(page.locator("#admin-interests-view")).toBeVisible();
  await expect(page.locator("#admin-interests-table")).toBeVisible();

  // ── STEP 4: the "Selected by" column header renders. ───────────────────────────────────────────
  const header = page.locator("#admin-interests-table thead th", { hasText: "Selected by" });
  await expect(header).toBeVisible();
  await shot("console");

  // ── STEP 5: the "Yoga" row's "Selected by" cell is populated as "<count> (<pct>%)" with a non-zero
  //    count — the seeded selection is tallied and joined by label. Search narrows to the row first. ─
  await page.fill("#admin-interests-search", SEED_LABEL);
  const yogaRow = page
    .locator("#admin-interests-table tbody tr")
    .filter({ has: page.locator("td", { hasText: SEED_LABEL }) })
    .first();
  await expect(yogaRow).toBeVisible();
  const selectedByCell = yogaRow.locator('td[data-label="Selected by"]');
  await expect(selectedByCell).toBeVisible();
  // Format "<count> (<pct>%)" with a count of at least 1 (the seeded selection).
  await expect(selectedByCell).toHaveText(/^\d+ \(\d+%\)$/);
  await expect(selectedByCell).not.toHaveText("0 (0%)");
  await shot("selected-by-populated");
});
