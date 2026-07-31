// TM-1180 — surface-scoped e2e resolver (Part B of TM-1178). Turns a WEB PR's changed-file list into a
// Playwright `--grep` so a branch dispatch runs only the specs its change surface can affect, instead of
// the full ~18-min matrix. The nightly cron always runs FULL (the changes job passes no grep), so this is
// pure per-PR speedup with the nightly as the coverage backstop.
//
// SAFETY (never trade coverage for speed): resolveScope returns { full: true } — meaning run the WHOLE
// suite — for any of:
//   • a file in surface-to-specs.json `forceFull` (shared-core: index.html, styles.css, router/api/ui/
//     app/auth/avatar-events/config — they fan out across every surface),
//   • any web/ file that is NOT under web/src/ (a harness/e2e/public change can alter any spec's behaviour),
//   • any web/src/ path that matches no map prefix (unknown → assume it could break anything).
// Otherwise it returns { full: false, grep } where grep is the union of the matched surfaces' tags PLUS
// the always-on smoke set — so the core path (login + app-shell) is exercised on every scoped run, which
// also guarantees the grep matches >=1 test (Playwright errors if a --grep selects nothing).
//
// Non-web/ files (backend/, infra/, docs) are simply ignored: they can't affect the browser suite and must
// not force a full run when they ride alongside a scoped web change.
//
// CLI:  printf '%s\n' "$CHANGED_FILES" | node scope-e2e.mjs   →  prints "FULL" or the grep regex on stdout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP = JSON.parse(readFileSync(join(HERE, "surface-to-specs.json"), "utf8"));

/**
 * @param {string[]} changedFiles - repo-relative paths (e.g. from `git diff --name-only`).
 * @param {object}   [map]        - the surface-to-specs map (defaults to the committed JSON).
 * @returns {{full: true, reason: string} | {full: false, grep: string}}
 */
export function resolveScope(changedFiles, map = DEFAULT_MAP) {
  const tags = new Set(map.alwaysOn);
  for (const raw of changedFiles) {
    const f = String(raw).trim();
    if (!f) continue;
    if (!f.startsWith("web/")) continue; // non-web change can't touch the browser suite → ignore
    if (!f.startsWith("web/src/")) return { full: true, reason: `web-but-not-src: ${f}` }; // harness/e2e/public
    if (map.forceFull.includes(f)) return { full: true, reason: `shared-core: ${f}` }; // fans out everywhere
    const entry = map.map.find((e) => f.startsWith(e.prefix));
    if (!entry) return { full: true, reason: `unmapped web/src path: ${f}` }; // unknown → FULL (safe default)
    for (const t of entry.tags) tags.add(t);
  }
  return { full: false, grep: [...tags].join("|") };
}

// Run as a CLI when invoked directly (not when imported by the self-test). Reads the newline-delimited
// changed-file list from argv (if given) or stdin, and prints "FULL" or the grep regex.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argFiles = process.argv.slice(2);
  const files = argFiles.length ? argFiles : readFileSync(0, "utf8").split("\n");
  const res = resolveScope(files);
  if (res.full) {
    process.stderr.write(`e2e scope: FULL suite (${res.reason})\n`);
    process.stdout.write("FULL\n");
  } else {
    process.stderr.write(`e2e scope: SCOPED → --grep '${res.grep}'\n`);
    process.stdout.write(res.grep + "\n");
  }
}
