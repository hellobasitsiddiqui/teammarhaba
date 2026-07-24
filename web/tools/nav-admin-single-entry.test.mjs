// Admin-nav single-entry guard (TM-937): post wave-admin-1 the #/admin hub (TM-917) is the ONE
// top-nav entry to the admin layer — its rows reach all five consoles. The four per-console top-nav
// links (#nav-admin-events "Manage events" / #nav-admin-venues / #nav-admin-interests /
// #nav-admin-messages) were removed so an admin's nav shows a single "Admin" link, not five. This
// test pins the ban: index.html must keep #nav-admin but contain NONE of the removed ids, and
// router.js must not reference them either (its reveal/hide blocks went with the links). The console
// ROUTES (#/admin/events etc.) remain valid — only the top-nav links are banned.
//
// This replaces nav-admin-events-label.test.mjs (TM-766's "Manage events" dedup guard): with the
// per-console links gone that label concern is moot, but the whole-nav duplicate-label guard is
// still worth keeping, so it lives on below.
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

// The four per-console nav ids TM-937 retired. Matched as the bare id string so BOTH the HTML
// (`id="nav-admin-events"`) and the router (`$("nav-admin-events")`) forms are caught.
const REMOVED_IDS = [
  "nav-admin-events",
  "nav-admin-venues",
  "nav-admin-interests",
  "nav-admin-messages",
];

test("index.html keeps the single #nav-admin hub link", () => {
  assert.match(
    indexHtml,
    /<a id="nav-admin" href="#\/admin"/,
    'index.html must keep <a id="nav-admin" href="#/admin"> — the one admin nav entry',
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

// Every account-nav entry is an anchor with a `nav-…` id and visible text; collect (id -> text).
// (Non-anchor entries like the avatar #nav-avatar carry no link label, so the `<a>` filter skips them.)
function navLinks() {
  const links = [];
  const re = /<a id="(nav-[^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    links.push({ id: m[1], text: m[2].trim() });
  }
  return links;
}

test("no two account-nav links share the same visible label (TM-766)", () => {
  const seen = new Map(); // lowercased label -> first id that used it
  for (const l of navLinks()) {
    const key = l.text.toLowerCase();
    if (seen.has(key)) {
      assert.fail(`duplicate nav label "${l.text}" on #${seen.get(key)} and #${l.id}`);
    }
    seen.set(key, l.id);
  }
});
