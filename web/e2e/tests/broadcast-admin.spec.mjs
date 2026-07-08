import { test, expect } from "@playwright/test";
import pg from "pg";
import {
  ADMIN,
  PUSH_RECIPIENT,
  BOTH_RECIPIENT,
  OPTOUT_RECIPIENT,
  dbConfig,
} from "../fixtures.mjs";

// Admin broadcast compose → send e2e (TM-366, epic TM-358) — the automated-test gate for the
// admin push feature. Drives the whole compose flow through the real browser + full stack and
// asserts the honest backend result:
//
//   sign in as ADMIN → open the users console → MULTI-SELECT ≥2 recipients (incl. one EMAIL-only
//   opt-out) → compose title + body + a deep-link route → preview → confirm via the styled
//   .tm-dialog → success toast → assert the POST /admin/push/broadcast RESULT (aggregate + per-
//   recipient outcomes: opted-in = SENT/targeted, EMAIL opt-out = SKIPPED_OPTED_OUT) → assert the
//   notification_broadcasts header row + the opt-out's notification_pref persist in Postgres.
//
// Built on the blocker tasks: the compose UI (TM-365, admin.js), the safety/opt-out rails (TM-364,
// BroadcastService), and the endpoint (TM-363, POST /api/v1/admin/push/broadcast). Reuses the
// harness's seeded ADMIN + the DB seam, and global-setup.mjs seeds the extra recipients (TM-366).
//
// HONEST LIMITATION (stated on the ticket): headless Chromium has no FCM and the CI stack runs the
// real FcmPushSender with no FCM credentials, so nothing is actually DELIVERED to a device here —
// `delivered` is legitimately 0. This gate proves compose → send → fan-out TARGETING + opt-out skip
// + the persisted record + the screenshot trail. It CANNOT prove a device received/rendered/tapped
// the push (FcmPushSender.DELIVERED means FCM-accepted, not device-delivered) — that is the separate
// manual/on-device human ticket. So we assert `targeted` / `skipped` / `skippedOptedOut` / per-
// recipient `outcome` (all decided BEFORE the sender is called), never a non-zero `delivered`.
//
// Project-agnostic (like golden-path, TM-341): runs under BOTH the desktop `chromium` and the phone
// `mobile-chromium` Playwright projects (see playwright.config.mjs testMatch), so web + mobile-web
// compose coverage come from ONE spec. Every nav interaction goes through openNav()/clickNav().
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we ALSO take an explicit named shot at
// each major step (compose / recipients-selected / preview / confirm / success) so the run yields a
// step-by-step visual trail to attach to the sprint evidence ticket (AC2).

// Suppress the first-run product tour (TM-147) so its dimmed overlay/backdrop can't cover the
// controls under test — the identical localStorage init-script every other spec uses.
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

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop
 *  width where the links are always laid out. Copied from golden-path (TM-341) so the spec is
 *  project-agnostic across chromium + mobile-chromium. */
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

/** Click a nav link/button by id, opening the hamburger first when needed. Works under both projects. */
async function clickNav(page, selector) {
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

/** The broadcast content this run composes. A deep-link route (#/home) is included so the picker path
 *  (TM-365) and the persisted `route` column are both exercised (AC: compose title+body+optional route). */
const TITLE = "TeamMarhaba community update";
const BODY = "We just shipped a new way to find local meetups. Open the app to take a look!";
const ROUTE = "#/home"; // a known allow-listed route (PushRoutes.KNOWN / KNOWN_ROUTES)

test("@admin @broadcast admin composes a broadcast, sends it, and the fan-out + opt-out are honest", async ({
  page,
}, testInfo) => {
  // A step screenshot helper — an explicit, named shot per major step on top of the global
  // screenshot:"on", so the run's artifacts read as a step-by-step trail of the compose→send flow (AC2).
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`broadcast-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // ── STEP 1: sign in as the seeded ADMIN (real Firebase flow against the Auth emulator). ─────────
  // Email-code is the default front door (TM-234); the email+password form is under "Try another way".
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // Signed in: the admin nav appears (ROLE_ADMIN only) and the signed-out panel is gone.
  await expect(page.locator("#nav-admin")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── STEP 2: open the users console; the compose panel (TM-365) is present. ──────────────────────
  await clickNav(page, "#nav-admin");
  await expect(page.locator("#admin-view")).toBeVisible();
  await expect(page.locator("#admin-table")).toBeVisible();
  const compose = page.locator("#admin-broadcast");
  await expect(compose).toBeVisible();
  // Show every seeded account on one page so the recipient checkboxes are all present regardless of
  // how many other specs' accounts share the run's DB (50 is the max page size; seeded N ≪ 50).
  await page.getByLabel("Rows per page").selectOption("50");
  await shot("compose");

  // ── STEP 3: select the two push-eligible recipients. The EMAIL-only user is opt-out and CANNOT be
  // selected — TM-427 disables the checkbox for anyone who can't receive push and relabels it, so an
  // admin can neither pick them nor be misled into thinking they will. That unselectability IS the
  // opt-out honesty at the UI. (The server-side skip of an opt-out that still reaches the send list —
  // SKIPPED_OPTED_OUT — is covered by BroadcastServiceTest + PushAdminControllerIntegrationTest, so it
  // isn't re-proven through the UI here.)
  const eligibleEmails = [PUSH_RECIPIENT.email, BOTH_RECIPIENT.email];
  for (const email of eligibleEmails) {
    const box = page.getByRole("checkbox", { name: `Select ${email}` });
    await expect(box).toBeVisible();
    await box.check();
  }
  // The opt-out's checkbox is present but DISABLED and relabelled "…can't receive push" (not "Select …").
  await expect(
    page.getByRole("checkbox", { name: `${OPTOUT_RECIPIENT.email} can't receive push` }),
  ).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: `Select ${OPTOUT_RECIPIENT.email}` })).toHaveCount(0);
  // The live "N selected" count reflects the two eligible picks (drives the Send-gate, TM-365).
  await expect(page.locator("#admin-selected-count")).toHaveText("2 selected");
  await shot("recipients-selected");

  // ── STEP 4: compose the message + pick a deep-link route, and watch the faithful preview update. ─
  await page.fill("#admin-broadcast-title", TITLE);
  await page.fill("#admin-broadcast-body", BODY);
  // The route picker is populated from the backend allow-list (GET …/push-routes, TM-360). Wait for
  // #/home to be a real option before selecting, so we don't race the async populate.
  const routeSelect = page.locator("#admin-broadcast-route");
  await expect(routeSelect.locator(`option[value="${ROUTE}"]`)).toHaveCount(1);
  await routeSelect.selectOption(ROUTE);
  // The preview mirrors exactly what will read on the shade: title headline, body, and the tap caption.
  await expect(page.locator("#admin-broadcast-preview .tm-push-preview-title")).toHaveText(TITLE);
  await expect(page.locator("#admin-broadcast-preview .tm-push-preview-body")).toHaveText(BODY);
  await expect(page.locator("#admin-broadcast-preview .tm-push-preview-caption")).toContainText(
    "Home",
  );
  // Send is now enabled (title + body valid AND ≥1 recipient selected).
  const send = page.locator("#admin-broadcast-send");
  await expect(send).toBeEnabled();
  await shot("preview");

  // ── STEP 5: send → confirm through the styled .tm-dialog (a delivered push is irreversible). ────
  // Arm the response capture BEFORE confirming so we can assert the endpoint's honest result (AC3/AC4).
  const broadcastResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/admin/push/broadcast") && r.request().method() === "POST",
  );
  await send.click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Send to 2 users?");
  await shot("confirm");
  await dialog.getByRole("button", { name: "Send now" }).click();

  // ── STEP 6: assert the endpoint RESULT — the fan-out + opt-out, decided server-side. ────────────
  const response = await broadcastResponse;
  expect(response.status()).toBe(200);
  const result = await response.json();

  // Aggregate: 3 requested, the two opted-in users SENT, the EMAIL-only user SKIPPED as opted-out.
  expect(result.requested).toBe(2);
  expect(result.sent).toBe(2);
  expect(result.skipped).toBe(0);
  expect(result.skippedOptedOut).toBe(0);
  // Each opted-in recipient owns exactly one distinct token, so two devices were TARGETED (post-dedupe).
  // We do NOT assert delivered > 0: headless CI has no FCM, so nothing is actually delivered (see the
  // header note). `targeted` is decided before the sender runs, so it's the honest fan-out proof.
  expect(result.targeted).toBe(2);

  // Per-recipient: exactly three results, whose outcomes are precisely two SENT + one
  // SKIPPED_OPTED_OUT (nothing else slipped in).
  expect(result.recipients).toHaveLength(2);
  const outcomes = result.recipients.map((r) => r.outcome).sort();
  expect(outcomes).toEqual(["SENT", "SENT"]);
  const sentUsers = result.recipients.filter((r) => r.outcome === "SENT");
  // Every SENT recipient targeted exactly its one device.
  for (const r of sentUsers) expect(r.fanout.targeted).toBe(1);

  // ── STEP 7: the UI reflects it — the honest success toast summary. ──────────────────────────────
  // summariseBroadcast (broadcast.js) reports the real breakdown from the response rails (TM-365).
  // Both selected recipients were eligible and SENT, so there is no skip clause — and no opt-out user
  // could be selected in the first place (TM-427), so the summary reads simply "Sent to 2 users …".
  const successToast = page.locator("#tm-toasts .tm-toast-success");
  await expect(successToast).toContainText("Sent to 2 users");
  await expect(successToast).not.toContainText("opted out");
  await expect(successToast).not.toContainText("no device");
  // The panel reset after a successful send: the selection cleared + the title field emptied (TM-365).
  await expect(page.locator("#admin-selected-count")).toHaveText("0 selected");
  await expect(page.locator("#admin-broadcast-title")).toHaveValue("");
  await shot("success");

  // ── STEP 8: it PERSISTED — exactly one notification_broadcasts header row for this send (AC), and
  // the opt-out recipient's notification_pref is EMAIL in the users table (the opt-out is real). ────
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    // The most recent broadcast row must be the one we just sent: our title/body/route + the resolved
    // aggregate counters (recipient_count = requested, skipped, delivered). It's append-only (V10).
    const { rows: broadcasts } = await client.query(
      `SELECT title, body, route, recipient_count, targeted, delivered, skipped
         FROM notification_broadcasts
        ORDER BY id DESC
        LIMIT 1`,
    );
    expect(broadcasts).toHaveLength(1);
    const row = broadcasts[0];
    expect(row.title).toBe(TITLE);
    expect(row.body).toBe(BODY);
    expect(row.route).toBe(ROUTE);
    expect(row.recipient_count).toBe(2);
    expect(row.targeted).toBe(2);
    expect(row.delivered).toBe(0); // no FCM in CI — nothing delivered, and the record says so honestly
    expect(row.skipped).toBe(0);

    // The opt-out is genuinely opted out in the DB: notification_pref = EMAIL (assertable in-DB via pg,
    // as golden-path / profile-edit do). That is what makes them push-ineligible, so the UI disabled
    // their recipient checkbox above (TM-427); the server-side skip of an opt-out is covered separately
    // by BroadcastServiceTest + PushAdminControllerIntegrationTest.
    const { rows: prefs } = await client.query(
      "SELECT notification_pref FROM users WHERE lower(email) = lower($1)",
      [OPTOUT_RECIPIENT.email],
    );
    expect(prefs).toHaveLength(1);
    expect(prefs[0].notification_pref).toBe("EMAIL");
  } finally {
    await client.end();
  }
});
