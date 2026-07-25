// TM-1041 app-shell width-clamp guard. Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// THE CONTRACT (TM-1041 = wave-app-shell-1 ticket A): every route sits inside ONE Revolut-style
// column — a responsive clamp band `--app-max`, applied on `.app` via `min(100%, …)` so it is
// full-width on phones (clamp inert → native/WebView byte-identical) and 420–480px on wider viewports,
// where the centred column paints the paper `--surface` on a neutral `--app-canvas`. Per-view page
// widths were consolidated onto this single column. This guard pins the durable invariant so a later
// edit can't silently re-introduce a per-view page width or drop the clamp. TM-1044 (ticket D) extends
// this into the full breakpoint/guard sweep; keep both in sync.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "..", "src", "assets", "styles.css"), "utf8");

test("the --app-max clamp band token exists (420–480px)", () => {
  assert.match(
    CSS,
    /--app-max:\s*clamp\(\s*420px\s*,\s*40vw\s*,\s*480px\s*\)/,
    "the shell width token --app-max: clamp(420px, 40vw, 480px) must exist in :root",
  );
});

test(".app inherits the clamp band via min(100%, var(--app-max))", () => {
  // `min(100%, var(--app-max))` is unique to the `.app` shell width — the single column every route
  // inherits. (There are two `.app {` blocks — the base text-align/padding one and the width one — so
  // match the declaration directly rather than scoping to a `.app {` prefix.)
  assert.match(
    CSS,
    /width:\s*min\(\s*100%\s*,\s*var\(--app-max\)\s*\)/,
    ".app must set width: min(100%, var(--app-max)) — the single column every route inherits",
  );
});

test("the neutral canvas is a wide-viewport-only token (inert on phones)", () => {
  assert.ok(CSS.includes("--app-canvas"), "the --app-canvas neutral-canvas token must exist");
  // The canvas must be gated behind a min-width media query so phones stay on --page-bg unchanged.
  assert.match(
    CSS,
    /@media\s*\(min-width:[^)]*\)\s*\{[^]*?body\s*\{[^}]*background:\s*var\(--app-canvas\)/,
    "body must paint var(--app-canvas) only inside a (min-width: …) query — never unconditionally, " +
      "so 390/360 phones + the native WebView stay on --page-bg (byte-identical to production)",
  );
});

test("per-view page widths were consolidated onto the shell column (no self-set 48rem page cap)", () => {
  // .profile-view's old desktop page cap. Component widths (toasts/modals/lock-card) are intentionally
  // kept, but no ROUTED VIEW may re-declare its own page width — that reintroduces per-route drift.
  assert.ok(
    !CSS.includes("min(48rem, 100%)"),
    ".profile-view (and peers) must inherit the .app clamp band, not set their own min(48rem, 100%) width",
  );
});
