// Top-nav ↔ bottom-tab-bar drift guard (TM-1024).
//
// DECISION (TM-1024): the DESKTOP signed-in top nav must be EXACTLY the four bottom-tab-bar tabs
// (tabbar-core.js `TABS`: Home · Events · Chat · Profile) in the same locked order, plus the Admin tab
// (`ADMIN_TAB`) for admins. Before TM-1024 the desktop nav carried a legacy link set (Help /
// Notifications / Take-a-tour) that did NOT match the mobile tab bar, so the two nav surfaces had
// drifted. Basit's call: top nav = the four tabs.
//
// `tabbar-core.js` is the SINGLE SOURCE OF TRUTH for the tab list. Rather than fully derive the HTML at
// build time (too invasive for the framework-free static index.html), TM-1024 hardcodes the four `<a>`
// links in index.html — and this test pins them to the tab table so the two can never silently drift:
// if someone adds/removes/reorders a tab in `TABS`, or edits a top-nav link's href, this guard fails
// until the two agree again. It also asserts router.js reveals the two NEW links (home + chat) and no
// longer references the three REMOVED legacy ids, and that the removed anchors are gone from the markup.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The one source of truth for the tab list — imported, not re-typed, so this test moves WITH it.
import { TABS, ADMIN_TAB, tabsFor } from "../src/assets/tabbar-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "src", "index.html"), "utf8"); // web/tools -> web/src
const routerJs = readFileSync(join(here, "..", "src", "assets", "router.js"), "utf8");

// Pull the #nav-items block (the account-nav row) so we only ever look at the primary top nav, not e.g.
// a stray same-id anchor elsewhere in the page.
function navItemsBlock() {
  const open = indexHtml.indexOf('<div id="nav-items"');
  assert.ok(open !== -1, 'index.html must contain the <div id="nav-items"> account-nav row');
  const close = indexHtml.indexOf("</div>", open);
  assert.ok(close !== -1, "#nav-items div must be closed");
  return indexHtml.slice(open, close);
}

// Collect every account-nav anchor in DOM order as { id, href } (buttons/spans without hrefs are skipped —
// they aren't primary destinations). Order is DOM order, which is the on-screen order for a flex row.
function navAnchors() {
  const block = navItemsBlock();
  const anchors = [];
  const re = /<a id="(nav-[^"]+)"[^>]*\bhref="([^"]+)"/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    anchors.push({ id: m[1], href: m[2] });
  }
  return anchors;
}

// The href each tab id should carry in the top nav: the `#nav-<id>` anchor must point at that tab's route.
function href(id) {
  const a = navAnchors().find((x) => x.id === id);
  return a ? a.href : undefined;
}

test("each of the four tabs has a matching top-nav link with the tab's route", () => {
  for (const tab of TABS) {
    const id = `nav-${tab.id}`;
    assert.equal(
      href(id),
      tab.route,
      `top-nav #${id} must href "${tab.route}" (the ${tab.id} tab's route) — top nav has drifted from tabbar-core.js TABS`,
    );
  }
});

test("the Admin top-nav link points at the Admin tab's route", () => {
  assert.equal(
    href(`nav-${ADMIN_TAB.id}`),
    ADMIN_TAB.route,
    `top-nav #nav-${ADMIN_TAB.id} must href "${ADMIN_TAB.route}" (the admin tab route)`,
  );
});

test("the PRIMARY top-nav links, in DOM order, are EXACTLY the four tabs (+ Admin) — no more, no less", () => {
  // The set of ids the tab list owns (four tabs + admin). Any other nav anchor (sign-in, and the
  // flag-gated membership/receipts) is NOT a primary tab and is allowed to sit in the row.
  const tabIds = new Set(tabsFor({ isAdmin: true }).map((t) => `nav-${t.id}`));
  // In DOM order, the tab-owned anchors must appear in the same order as tabsFor (Home·Events·Chat·Profile·Admin).
  const tabAnchorsInOrder = navAnchors()
    .map((a) => a.id)
    .filter((id) => tabIds.has(id));
  const expected = tabsFor({ isAdmin: true }).map((t) => `nav-${t.id}`);
  assert.deepEqual(
    tabAnchorsInOrder,
    expected,
    "the top-nav tab links must appear in tabbar-core.js order (Home · Events · Chat · Profile · Admin)",
  );
});

// The three legacy ids TM-1024 retired from the primary nav (Help / Notifications / Take-a-tour). The
// Help PAGE (#/help) and Notifications SCREEN (#/notifications, reached via the bell) stay reachable —
// only these NAV entries are gone.
const REMOVED_IDS = ["nav-help-link", "nav-notifications", "nav-help"];

test("the retired legacy nav ids are gone from #nav-items markup (TM-1024)", () => {
  const block = navItemsBlock();
  for (const id of REMOVED_IDS) {
    // Match the actual attribute form so a mention inside a comment doesn't false-positive.
    assert.ok(
      !new RegExp(`id="${id}"`).test(block),
      `#nav-items still declares id="${id}" — removed from the primary nav by TM-1024`,
    );
  }
});

test("router.js reveals the two NEW tab links and drops the retired ones (TM-1024)", () => {
  // The new links must be revealed (router.js references them by id, mirroring how nav-events is revealed).
  for (const id of ["nav-home", "nav-chat"]) {
    assert.ok(routerJs.includes(id), `router.js must reveal "${id}" (added by TM-1024)`);
  }
  // The retired links' reveal/hide lines must be gone (their elements no longer exist).
  for (const id of REMOVED_IDS) {
    assert.ok(!routerJs.includes(id), `router.js still references "${id}" — its reveal went with TM-1024`);
  }
});
