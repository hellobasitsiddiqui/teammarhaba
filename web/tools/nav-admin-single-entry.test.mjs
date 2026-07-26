// Admin-nav single-entry guard (TM-937 → TM-1043): the #/admin hub (TM-917) is the ONE nav entry to
// the admin layer — its rows reach all five consoles. TM-937 removed the four per-console top-nav
// links (#nav-admin-events "Manage events" / #nav-admin-venues / #nav-admin-interests /
// #nav-admin-messages); TM-1043 then deleted the whole top .app-nav (including #nav-admin), so the
// single admin entry is now the tab bar's admin-only fifth tab (#tab-admin, tabbar.js → "#/admin",
// TM-915/TM-1042). This test pins both halves: the tab bar keeps that one entry, and none of the
// retired per-console link ids ever come back (in index.html OR router.js). The console ROUTES
// (#/admin/events etc.) remain valid — only nav links are constrained.
//
// This replaces nav-admin-events-label.test.mjs (TM-766's "Manage events" dedup guard): with the
// per-console links gone that label concern is moot, but the duplicate-label guard is still worth
// keeping, so it lives on below against the tab-bar labels (the only primary nav now).
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "src", "index.html"), "utf8"); // web/tools -> web/src
const routerJs = readFileSync(join(here, "..", "src", "assets", "router.js"), "utf8");
const tabbarJs = readFileSync(join(here, "..", "src", "assets", "tabbar.js"), "utf8");

// The four per-console nav ids TM-937 retired. Matched as the bare id string so BOTH the HTML
// (`id="nav-admin-events"`) and the router (`$("nav-admin-events")`) forms are caught.
const REMOVED_IDS = [
  "nav-admin-events",
  "nav-admin-venues",
  "nav-admin-interests",
  "nav-admin-messages",
];

test("the tab bar's #tab-admin is the single admin nav entry (TM-915 / TM-1043)", () => {
  // tabbar.js creates the admin-only fifth tab on demand; pin its id + destination so the one admin
  // entry can't silently drift off the hub route. (The old top-nav <a id="nav-admin"> was deleted
  // with the .app-nav in TM-1043 — see the ban below.)
  assert.match(
    tabbarJs,
    /ADMIN_TAB_LINK_ID\s*=\s*"tab-admin"/,
    'tabbar.js must keep the admin tab id "tab-admin"',
  );
  assert.match(
    tabbarJs,
    /link\.href\s*=\s*"#\/admin"/,
    'the admin tab must point at the #/admin hub — the single entry to all five consoles',
  );
});

test("index.html no longer carries ANY top-nav admin link (TM-1043 deleted the .app-nav)", () => {
  assert.ok(
    !indexHtml.includes('id="nav-admin"'),
    'index.html must not resurrect the old top-nav <a id="nav-admin"> — the tab bar owns the admin entry',
  );
});

test("index.html contains none of the removed per-console admin links (TM-937)", () => {
  for (const id of REMOVED_IDS) {
    assert.ok(!indexHtml.includes(id), `index.html still contains "${id}" — removed by TM-937`);
  }
});

test("router.js no longer references the removed per-console admin links (TM-937)", () => {
  for (const id of REMOVED_IDS) {
    assert.ok(!routerJs.includes(id), `router.js still references "${id}" — removed by TM-937`);
  }
});

// Every static tab-bar entry is an anchor with a `tab-…` id and a visible .app-tab-label; collect
// (id -> label). (The admin fifth tab is created dynamically by tabbar.js with the label "Admin",
// so it's appended by hand below — the guard covers the full 5-tab set.)
function tabLabels() {
  const labels = [{ id: "tab-admin", text: "Admin" }];
  const re = /<a id="(tab-[^"]+)"[^>]*>[\s\S]*?<span class="app-tab-label">([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    labels.push({ id: m[1], text: m[2].trim() });
  }
  return labels;
}

test("no two tab-bar entries share the same visible label (TM-766 guard, retargeted to the tab bar)", () => {
  const seen = new Map(); // lowercased label -> first id that used it
  const labels = tabLabels();
  assert.ok(labels.length >= 5, "expected the four static tabs + the dynamic admin tab in the label set");
  for (const l of labels) {
    const key = l.text.toLowerCase();
    if (seen.has(key)) {
      assert.fail(`duplicate tab label "${l.text}" on #${seen.get(key)} and #${l.id}`);
    }
    seen.set(key, l.id);
  }
});
