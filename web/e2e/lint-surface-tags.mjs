// TM-1179 — surface-tag lint. Fails if any Playwright test's FULL title (test title + every enclosing
// describe title) carries no product-surface @tag. This is the regression guard behind surface-scoped
// e2e (TM-1180): `--grep @<surface>` selects by the full title, so an untagged test would be SILENTLY
// dropped from a scoped run. Keeping every test tagged makes that scoping safe.
//
// Uses Playwright's own `test --list` as the oracle (it resolves describe-level tags — a
// `test.describe("@profile …", …)` covers all its tests), so this matches exactly what `--grep` sees.
// Only the `chromium` project is inspected — mobile-chromium re-runs a subset of the same specs, so a
// per-project check would double-count.
//
// Run:  node lint-surface-tags.mjs   (from web/e2e)   — exit 0 = all tagged, exit 1 = gaps listed.

import { execFileSync } from "node:child_process";

// The product surfaces a spec can belong to. NOT: @playwright/@teammarhaba (framework), @example/@tag/
// @param (placeholders), or a bare @tmNNN ticket tag (a ticket is not a surface). Add new surfaces here
// as the app grows — an unknown surface tag simply won't satisfy the lint until it's listed.
const SURFACE = new RegExp(
  "@(auth|admin|admin-events|admin-hub|admin-interests|profile|profile-shell|events|event-image|" +
    "chat|chat-foundation|chat-live|chat-search|chat-announcement|chat-late-join|membership|payments|" +
    "subscription|venue|venues|app-shell|onboarding|notif|notifications|avatar|responsive|theme|terms|" +
    "alert|alerts|help|waitlist|golden|webview|broadcast|papercuts|badges|image-upload|money-safety|" +
    "ios-badge|nav-races|media)(\\b|-)",
);

let listing;
try {
  listing = execFileSync("npx", ["playwright", "test", "--list"], { encoding: "utf8" });
} catch (err) {
  // `--list` exits non-zero when there ARE tests but a config warning prints to stderr; its stdout is
  // still the listing. Fall back to whatever it captured before failing.
  listing = err.stdout ? String(err.stdout) : "";
  if (!listing) {
    console.error("lint-surface-tags: could not list tests (playwright --list produced no output).");
    console.error(err.stderr ? String(err.stderr) : err.message);
    process.exit(2);
  }
}

const lines = listing
  .split("\n")
  .filter((l) => l.includes("[chromium]") && /\.spec\.mjs:\d+:\d+ ›/.test(l));

if (lines.length === 0) {
  console.error("lint-surface-tags: no chromium tests found — refusing to pass vacuously.");
  process.exit(2);
}

const untagged = lines.filter((l) => !SURFACE.test(l));
if (untagged.length > 0) {
  console.error(
    `✗ ${untagged.length} of ${lines.length} e2e test(s) carry no product-surface @tag (TM-1179).\n` +
      "  Every test's title — or an enclosing test.describe() — must include a surface tag (e.g. @profile,\n" +
      "  @events, @chat, @admin-events) so surface-scoped e2e (--grep) can't silently skip it. Offenders:",
  );
  for (const l of untagged) console.error("   " + l.replace(/^\s*\[chromium\] › /, ""));
  process.exit(1);
}

console.log(`✓ all ${lines.length} e2e tests carry a product-surface @tag (TM-1179).`);
