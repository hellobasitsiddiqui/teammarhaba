// TM-906 sign-out ban guard. Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// THE RULE: TM-906 removed the top-nav sign-out button ENTIRELY. The only sign-out entry is the
// Profile hub's "Sign out" menu row (#profile-signout-row, profile.js), behind the styled ui.js
// confirmDialog. The old button's DOM id must never come back — not as a control, not as a hidden
// orphan, not as an e2e selector — because ~20 specs once coupled to it as their "signed in" signal
// and the whole point of the migration (body[data-auth] via e2e/helpers/auth-state.mjs) is that the
// next nav reshuffle is a one-file fix, not a 21-file one.
//
// THE GUARD: walk web/src, web/e2e, web/tools AND the mobile Maestro flow dirs (android/maestro,
// ios/maestro) and assert NO file mentions the banned id. The Maestro dirs are in scope because the
// flows drive the SAME hosted SPA by DOM id — the original migration missed them precisely because
// this guard only walked web/ (the warm-session sign-out blocks in login-sms.yaml / journey.yaml
// kept tapping the deleted element). This file is the single allowlisted exception (it must name
// the token to ban it — assembled from parts below anyway, so even this file never contains the
// literal). Per the reshaping-shared-UI rule: when a shared UI seam is retired, pin the retirement
// with a guard so it can't silently regrow.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const REPO_ROOT = join(WEB_ROOT, "..");

// The banned DOM id, assembled so this guard file itself never contains the literal token.
const BANNED = ["signout", "btn"].join("-");

// The only file allowed to (conceptually) reference the ban — this guard itself.
const ALLOWLIST = new Set([basename(fileURLToPath(import.meta.url))]);

// Directories that are build/tooling output or vendored deps — never product or spec source.
const SKIP_DIRS = new Set(["node_modules", "playwright-report", "test-results", ".firebase"]);

/** Recursively collect every regular file under `dir`, skipping vendored/output directories. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

test(`no file in web/src, web/e2e, web/tools, android/maestro or ios/maestro references the retired top-nav sign-out id (TM-906)`, () => {
  const roots = [
    ...["src", "e2e", "tools"].map((d) => join(WEB_ROOT, d)),
    join(REPO_ROOT, "android", "maestro"),
    join(REPO_ROOT, "ios", "maestro"),
  ];
  const offenders = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (ALLOWLIST.has(basename(file))) continue;
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable/binary — nothing a selector could hide in
      }
      if (text.includes(BANNED)) offenders.push(relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the retired '#${BANNED}' id is referenced again in: ${offenders.join(", ")} — ` +
      "sign-out lives ONLY on the Profile hub row behind the confirm dialog (TM-906); " +
      "e2e specs must use helpers/auth-state.mjs and Maestro flows the profile-row + confirm path",
  );
});
