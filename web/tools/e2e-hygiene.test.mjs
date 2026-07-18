// TM-897 regression guard: the TM-867 six-box OTP auto-submits the moment a full code lands, so
// nothing under web/e2e may click #emailcode-verify-btn — the click either targets a disabled
// button (busy window already open) or a hidden form (verify already succeeded), and dies on
// Playwright's 30s actionability timeout. The migrated specs follow this contract
// (tm867-otp-6box.spec.mjs pins it); this test extends it to EVERYTHING under web/e2e, including
// standalone capture/evidence scripts that live outside the Playwright testDir and thus outside
// any CI spec run — exactly where the TM-890 closure review found the last stale click.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e");
const SKIP_DIRS = new Set(["node_modules", "test-results", "playwright-report"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

test("no web/e2e file clicks #emailcode-verify-btn (TM-867 auto-submit contract)", () => {
  const offenders = walk(E2E_ROOT).filter((f) =>
    /click\(\s*["'`]#emailcode-verify-btn/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(
    offenders.map((f) => relative(E2E_ROOT, f)),
    [],
    "these files still click the verify button the OTP auto-submit hides/disables — fill the code and wait instead",
  );
});
