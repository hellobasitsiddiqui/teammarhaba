// Parse/syntax gate for the browser JS (TM-584). Fails on a SyntaxError or a duplicate
// declaration/export in ANY module under web/src — the class of bug that white-screened main.
//
// Why this exists: the web CI gate only ran `node --test web/tools/*.test.mjs`, which import the
// pure `*-core.js` modules but never `api.js` or the DOM modules. So when TM-438 and TM-439 each
// added an identical `export async function listMyConversations` to `web/src/assets/api.js` on
// branches cut at different points, git merged both cleanly → a DUPLICATE export → a hard
// SyntaxError that white-screened the SPA on main (fixed in TM-583). Nothing in CI parsed api.js,
// so it merged fully green. This gate parses every browser JS file so that can never recur.
//
// Why module goal (`--check --input-type=module`) for every file:
//   • The app's browser JS is authored as ES modules (import/export). Plain `node --check file.js`
//     treats a `.js` file as CommonJS and MIS-REPORTS ES modules — and worse, Node's CommonJS
//     loader auto-detects ESM syntax and only *warns* (exit 0) on a duplicate `export`, so a
//     CommonJS check would SILENTLY PASS the exact bug this gate must catch. Module goal reports it
//     as `SyntaxError: Identifier '…' has already been declared` and exits non-zero. Verified.
//   • The handful of classic <script> files (config.js, appearance.js, app.js, nav-toggle.js —
//     build-info.js became a module in TM-666) contain no module-incompatible syntax and parse
//     cleanly in module goal, which
//     is strictly stronger (it also enforces strict mode). So checking everything as a module is
//     both the correct check for the real modules and a safe, stricter check for the classic ones.
//
// Fast, framework-free (Node built-ins only), no runtime/browser. Run from the repo root:
//   node web/tools/check-syntax.mjs
// Optionally pass one or more directories to scan (default: web/src):
//   node web/tools/check-syntax.mjs web/src

import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is two levels up from this script (web/tools/ → repo root), so the gate works no matter
// what the caller's current working directory is.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Directories to scan. Default to the browser source tree (assets/ + status/ + any future browser
// JS live under web/src). Non-browser build tooling lives under web/tools and is NOT scanned here —
// it's exercised by the existing `node --test` gate.
const targetDirs = (process.argv.slice(2).length ? process.argv.slice(2) : ["web/src"]).map((d) =>
  join(REPO_ROOT, d),
);

/** Recursively collect every `*.js` file under `dir` (returns absolute paths, sorted for stable output). */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never descend into dependency trees — we only own our own source.
      if (entry.name === "node_modules") continue;
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Parse one file in ES-module goal via `node --check`. Returns null on success, else the error text.
 *  Content is piped over stdin (not passed as a path) because `--input-type=module` only applies to
 *  stdin/`--eval`; a path would be re-detected as CommonJS. We keep the filename ourselves for the
 *  report, so the `[stdin]:<line>` in Node's message still points at the right line in that file. */
function checkModule(absPath) {
  const source = readFileSync(absPath, "utf8");
  const res = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: source,
    encoding: "utf8",
  });
  if (res.status === 0) return null;
  return (res.stderr || res.stdout || `exited with code ${res.status}`).trim();
}

// --- run ---------------------------------------------------------------------------------------
const files = targetDirs.flatMap((d) => collectJsFiles(d));
const failures = [];
for (const f of files) {
  const err = checkModule(f);
  if (err) failures.push({ file: relative(REPO_ROOT, f), err });
}

if (failures.length > 0) {
  console.error(`\n✖ JS syntax gate: ${failures.length} of ${files.length} file(s) failed to parse:\n`);
  for (const { file, err } of failures) {
    console.error(`── ${file}`);
    console.error(`${err}\n`);
  }
  console.error(
    `Fix the SyntaxError(s) above. A common cause is a DUPLICATE export/declaration introduced by\n` +
      `two branches independently adding the same symbol and git merging both without a conflict.`,
  );
  process.exit(1);
}

console.log(`✓ JS syntax gate: ${files.length} browser JS module(s) parsed cleanly.`);
