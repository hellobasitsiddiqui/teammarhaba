import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, TARGET, API_BASE_URL, dbConfig } from "../fixtures.mjs";
import { authHeadersFor } from "../events-api.mjs";

// Admin "suspend account" now BLOCKS API access (TM-742 / fix TM-741).
//
// The bug: the admin "disable/suspend" action flipped users.enabled=false and audited it, but NOTHING
// in the inbound request path read that flag. A suspended user kept full authenticated access to the
// whole /api/v1 surface for the token's ~1h TTL — and since Firebase was never disabled, its refresh
// token kept minting fresh ID tokens indefinitely. The enabled flag was honoured only on OUTBOUND
// notification/push suppression, never as an access gate. So the control advertised as "blocks an
// account" gave no lockout at all (the HIGH finding on TM-655 → TM-742).
//
// The fix wires FirebaseAuthenticationFilter to consult users.enabled after the token verifies and
// refuse a suspended, active account (context left empty → the uniform 401 entry point). This spec
// proves that behaviour END-TO-END through the real browser + full stack: an admin suspends a user via
// the console, and that user's API access goes from GRANTED (200) to BLOCKED (401) as a result.
//
// The mirror is admin-walkthrough.spec.mjs (same ADMIN sign-in, same console disable flow, same DB
// seam). This spec adds the piece that walkthrough only asserts on the WRITE side (users.enabled=false
// persisted): it asserts the READ side — that the suspend now actually locks the account OUT of the API.
//
// WHY A FRESH TARGET TOKEN, MINTED AFTER THE SUSPEND. We assert the 401 against a token minted AFTER the
// disable, so the token itself verifies cleanly (the emulator account is never Firebase-disabled, and a
// token minted after the fix's best-effort revokeSessions() has a later auth_time, so checkRevoked does
// NOT reject it). That makes the 401 attributable purely to the inbound users.enabled=false GATE — the
// exact line the fix adds — not to Firebase revocation (which is a slower, best-effort, credential-
// dependent defence that is unavailable under the emulator). This mirrors the backend integration test
// FirebaseAuthIntegrationTest.suspendedAccountIsRejectedEvenWithAValidToken, which makes the same point.
//
// ORDER-INDEPENDENT + LEAVES CLEAN STATE. TARGET is the shared disable-able fixture (admin-walkthrough
// disables it too, and the suite shares one DB). So we do NOT assume TARGET starts enabled: beforeAll
// re-enables it via the admin API to establish a deterministic 200 baseline, and afterAll re-enables it
// again so a shared-DB re-run (CI `retries: 1`) and any later spec start from a clean, enabled TARGET.

/**
 * Mint a FRESH emulator ID token for `account` and call GET /api/v1/me with it, returning the raw
 * fetch Response. The identity is the Bearer token (never a request body) — the same first-party API
 * pattern events-api.mjs / chat-seed.mjs use. `/api/v1/me` is an authenticated read behind the
 * `.anyRequest().authenticated()` gate, so its status is a clean signal of whether the account can
 * reach the API at all: 200 when it can, 401 (uniform problem+json) when the auth filter refuses it.
 */
async function getMeAs(account) {
  const headers = await authHeadersFor(account);
  return fetch(`${API_BASE_URL}/api/v1/me`, { method: "GET", headers });
}

/**
 * Set TARGET's enabled flag via the admin API (PATCH /api/v1/admin/users/{id}). Called with the
 * ADMIN's headers — the admin is never suspended, so this always goes through. Used to reset TARGET to
 * a known state (enabled) around the test so the spec is isolated from admin-walkthrough on the shared
 * DB. `role: null` leaves the role untouched (the update only toggles `enabled`).
 */
async function setTargetEnabled(adminHeaders, id, enabled) {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/users/${id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ enabled, role: null }),
  });
  if (!res.ok) {
    throw new Error(`re-enable TARGET (id=${id}) failed: ${res.status} ${await res.text()}`);
  }
}

/** Look up TARGET's users.id straight from Postgres (same seam admin-walkthrough uses for its DB
 *  assertion) so we can PATCH it by id in beforeAll/afterAll without first driving the UI. */
async function targetUserId() {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT id FROM users WHERE email = $1", [TARGET.email]);
    expect(rows).toHaveLength(1);
    return Number(rows[0].id);
  } finally {
    await client.end();
  }
}

let adminHeaders;
let targetId;

// Establish a deterministic precondition: TARGET is ENABLED before this test runs (a prior spec on the
// shared DB may have left it disabled). Reset it via the admin API so the 200 baseline is reliable.
test.beforeAll(async () => {
  adminHeaders = await authHeadersFor(ADMIN);
  targetId = await targetUserId();
  await setTargetEnabled(adminHeaders, targetId, true);
});

// Leave TARGET enabled again so a shared-DB re-run / any later spec starts clean. Best-effort — a
// failed cleanup must not fail the suite.
test.afterAll(async () => {
  try {
    if (adminHeaders && targetId != null) await setTargetEnabled(adminHeaders, targetId, true);
  } catch {
    /* best-effort cleanup — ignore */
  }
});

// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the admin controls
// — the identical localStorage init-script every other admin/auth spec uses.
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

test("@admin suspending a user via the console blocks their API access (200 → 401)", async ({ page }) => {
  // ── Baseline: while ENABLED, TARGET can reach the API. GET /api/v1/me → 200. This is the exact
  //    call that the bug left working AFTER a suspend, and is the "before" side of the fix's contract.
  const before = await getMeAs(TARGET);
  expect(before.status).toBe(200);

  // ── Admin suspends TARGET through the real console (mirrors admin-walkthrough.spec.mjs). ──────────
  // 1. Anonymous lands on the login view.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // 2. Sign in as the seeded ADMIN (real Firebase flow against the Auth emulator). Email-code is the
  // default front door (TM-234); the email+password form lives under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");

  // 3. Authenticated: the admin nav appears (ROLE_ADMIN only).
  await expect(page.locator("#signout-btn")).toBeVisible();
  await expect(page.locator("#nav-admin")).toBeVisible();

  // 4. Open the admin layer, then the users console via the hub (TM-917: #nav-admin opens the #/admin
  //    hub; the users console moved to #/admin/users). TARGET is listed + Enabled (reset in beforeAll).
  await page.click("#nav-admin");
  await page.click('.admin-hub-row[href="#/admin/users"]');
  await expect(page.locator("#admin-view")).toBeVisible();
  const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
  await expect(targetRow).toBeVisible();
  // Scope to the account-state badge by text: the push-eligibility badge (TM-427) shares the
  // .tm-badge-ok/.tm-badge-off classes, so an unscoped selector is ambiguous ("Enabled" + "Push").
  await expect(targetRow.locator(".tm-badge-ok", { hasText: "Enabled" })).toHaveText("Enabled");

  // The ID column (the row's only muted cell) carries the DB id — cross-check it matches the row we
  // reset in beforeAll, so the UI action and the DB/API assertions all target the SAME account.
  const rowId = Number((await targetRow.locator("td.tm-muted").first().innerText()).trim());
  expect(rowId).toBe(targetId);

  // 5. Disable the account, confirming through the styled confirm dialog (not native confirm()).
  await targetRow.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Disable", exact: true }).click();

  // 6. The UI reflects it: success toast + the row's status flips to Disabled.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Account disabled");
  // Scope by text — a disabled + no-push row has two .tm-badge-off spans ("Disabled" + "No push").
  await expect(targetRow.locator(".tm-badge-off", { hasText: "Disabled" })).toHaveText("Disabled");

  // 7. It persisted: the users row is now disabled in the database.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT enabled FROM users WHERE id = $1", [targetId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
  } finally {
    await client.end();
  }

  // ── THE FIX (TM-742): the suspend now BLOCKS the API. A FRESH TARGET token — minted after the
  //    disable, so it verifies cleanly and is NOT revoked — is refused by the inbound users.enabled
  //    gate. GET /api/v1/me → 401 (uniform application/problem+json, title "Unauthorized"). Before the
  //    fix this returned 200: the suspended account kept full access. This is the assertion that would
  //    FAIL before the fix and PASS after it.
  const after = await getMeAs(TARGET);
  expect(after.status).toBe(401);
  expect(after.headers.get("content-type")).toContain("application/problem+json");
  const problem = await after.json();
  expect(problem.title).toBe("Unauthorized");

  // And it's the whole authenticated surface, not just /me: the ping probe is refused too, proving the
  // gate is in the auth filter (applies to every /api/v1 route), not one endpoint's own check.
  const pingHeaders = await authHeadersFor(TARGET);
  const ping = await fetch(`${API_BASE_URL}/api/v1/ping`, { method: "GET", headers: pingHeaders });
  expect(ping.status).toBe(401);
});
