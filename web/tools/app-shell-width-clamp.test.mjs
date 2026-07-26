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

// ── TM-1042 (ticket B): the bottom tab bar is the single nav at ALL widths, constrained to the band ──

test("the tab bar is constrained to the shell clamp band (centred, not full-bleed)", () => {
  // Scope to the `.app-tabbar` base rule block (up to its line-start closing brace) rather than a
  // `[^}]*` window — the block's own comment contains a `[hidden]{…}` brace that would truncate it.
  const block = CSS.match(/\.app-tabbar\s*\{[\s\S]*?\n\}/);
  assert.ok(block, ".app-tabbar base rule must exist");
  assert.match(
    block[0],
    /width:\s*min\(\s*100%\s*,\s*var\(--app-max\)\s*\)/,
    ".app-tabbar must set width: min(100%, var(--app-max)) so on wide viewports the fixed bar sits under " +
      "the column, and on phones (min → 100%) spans full width unchanged",
  );
});

test("the tab-bar reveal is unconditional — NOT gated behind the old ≤33rem query (TM-1042)", () => {
  assert.match(
    CSS,
    /\.app-tabbar:not\(\[hidden\]\)\s*\{\s*display:\s*grid/,
    "the router-gated reveal .app-tabbar:not([hidden]) { display: grid } must exist",
  );
  // Regression guard: the reveal must no longer be the first rule inside a (max-width: 33rem) query —
  // that was the desktop-hides-the-bar gate B removes. The bar now shows at every width (router still
  // decides WHEN via shouldShowTabbar), so a 33rem wrapper around the reveal would reintroduce the gate.
  assert.ok(
    !/@media\s*\(max-width:\s*33rem\)\s*\{\s*\.app-tabbar:not\(\[hidden\]\)/.test(CSS),
    "the tab-bar reveal must not be wrapped in a @media (max-width: 33rem) block — it is unconditional now",
  );
});

// ── TM-1043 (ticket C): the top nav .app-nav is DELETED — the bottom tab bar is the only nav, and the
//    notification bell is standalone route-independent chrome. Pin the deletion so it can't regrow. ──

test("no top-nav element survives in index.html (TM-1043 deleted .app-nav + the hamburger)", () => {
  const HTML = readFileSync(join(HERE, "..", "src", "index.html"), "utf8");
  assert.ok(!/class=["']app-nav["']/.test(HTML), 'the <nav class="app-nav"> top nav must be gone (TM-1043)');
  assert.ok(!/id=["']nav-toggle["']/.test(HTML), "the #nav-toggle hamburger must be gone (TM-1043)");
});

test("no live .app-nav CSS selector survives (TM-1043 — historical comments are fine)", () => {
  // Strip /* … */ comments; the deletion left accurate historical comments that name .app-nav.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/\.app-nav\b/.test(stripped),
    "no live .app-nav / .app-nav-toggle / .app-nav--corner-bell selector may remain in styles.css (TM-1043)",
  );
});
