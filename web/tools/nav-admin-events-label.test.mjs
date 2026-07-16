// Nav-label guard (TM-766): the account nav (#nav-items) reveals BOTH the user events-browse link
// (#nav-events) and the admin events console link (#nav-admin-events) for a signed-in admin. Both
// once read a bare "Events", so an admin saw "Events" twice with no way to tell which one manages
// events. The admin link is now "Manage events". This test locks that in AND guards the whole account
// nav against ANY future duplicate link label — it fails on the pre-fix tree (two "Events") and passes
// after.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "src", "index.html"), "utf8"); // web/tools -> web/src

// Every account-nav entry is an anchor with a `nav-…` id and visible text; collect (id -> text).
// (Buttons like #nav-help / the avatar #nav-avatar carry no link label, so the `<a>` filter skips them.)
function navLinks() {
  const links = [];
  const re = /<a id="(nav-[^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    links.push({ id: m[1], text: m[2].trim() });
  }
  return links;
}

test("admin events console nav link reads 'Manage events' (not a bare 'Events')", () => {
  const link = navLinks().find((l) => l.id === "nav-admin-events");
  assert.ok(link, 'no <a id="nav-admin-events"> found in index.html');
  assert.equal(link.text, "Manage events");
});

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
