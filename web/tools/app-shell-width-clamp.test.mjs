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

// ── TM-1044 (ticket D): breakpoint sweep — the shell is a single ≤480px column at every viewport, so the
//    old desktop↔phone media queries that gated the top nav are gone, and no routed VIEW may re-introduce
//    a page width wider than the column. (Intra-column COMPONENT widths are content sizing, exempt.) ──

const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

test("the ≤33rem top-nav / hamburger breakpoint is gone (TM-1042/TM-1043 swept it)", () => {
  // The tab bar reveals unconditionally (TM-1042) and the top nav is deleted (TM-1043), so NO
  // `@media (max-width: 33rem)` — the old .app-nav-toggle / tab-bar-reveal gate — may remain.
  assert.ok(
    !/@media\s*\(\s*max-width:\s*33rem\s*\)/.test(NO_COMMENTS),
    "no @media (max-width: 33rem) breakpoint may survive — the tab bar shows at all widths and the top nav is gone",
  );
});

test("no routed VIEW re-introduces a page-width cap wider than the 480px column ceiling (TM-1044)", () => {
  // Page-level routed views must inherit the .app clamp band, never set their own wider cap — that would
  // reintroduce the per-route drift TM-1041 removed. Component widths (.tm-modal / .tm-toast /
  // .tm-lock-card etc.) are content sizing and out of scope here.
  const VIEWS = [".auth", ".profile-view", ".onboarding-view", ".chat-view", ".notifications-view", ".events-view"];
  const offenders = [];
  for (const sel of VIEWS) {
    const block = NO_COMMENTS.match(new RegExp(`(?:^|\\n)\\s*${sel.replace(/\./g, "\\.")}\\s*\\{[\\s\\S]*?\\n\\}`));
    if (!block) continue;
    for (const decl of block[0].match(/(?:max-)?width:\s*[^;]+;/g) || []) {
      const rem = /(\d+(?:\.\d+)?)\s*rem/.exec(decl);
      if (rem && parseFloat(rem[1]) > 30) offenders.push(`${sel} → ${decl.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `routed views must inherit the ≤480px clamp band, not set a wider page cap: ${offenders.join(" ; ")}`,
  );
});

// ── TM-1072: the notification bell is fixed chrome; its companion screen headers must be STICKY so on
//    scroll the bell stays anchored to its header instead of floating over list rows (the Chat-list bug). ──

test("bell-anchoring headers are sticky + the Chat header clears the bell (TM-1072)", () => {
  // The sticky rule that keeps the fixed bell with its header while content scrolls beneath.
  const sticky = NO_COMMENTS.match(/\.tm-chat-head\s*,[\s\S]*?\{[\s\S]*?\}/);
  assert.ok(
    sticky && /position:\s*sticky/.test(sticky[0]),
    ".tm-chat-head (+ #auth-signed-in .tm-home-head / #profile-view .tm-pf-topbar) must be position: sticky " +
      "so the fixed bell stays anchored to its header on scroll, not floating over list rows (TM-1072)",
  );
  // The Chat header reserves the same 44px bell-clearance Home/Profile already had.
  assert.match(
    NO_COMMENTS,
    /\.tm-chat-head\s*\{\s*padding-right:\s*calc\(\s*44px/,
    "the Chat header (.tm-chat-head) must reserve the 44px bell clearance (TM-1072)",
  );
});

// ── TM-1073: soft shade page background, white content cards. The page ground (--page-bg on the phone
//    body, --surface on the wide-viewport .app column) is a LIGHT NEUTRAL SHADE so the WHITE content
//    cards (--surface-card) pop against it. Pin: shade ground on both surfaces, cards stay white, and
//    the shade is genuinely distinct from card-white (the whole point of the change). ──

/** First (light-mode `:root`) value of a custom property — dark-mode overrides come later in the file. */
function lightValue(prop) {
  const m = NO_COMMENTS.match(new RegExp(`${prop.replace(/[-]/g, "\\-")}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}
/** Resolve a token to its underlying value, following one/more levels of `var(--x)` aliasing to the
 *  primitive it points at (TM-1073 aliases --page-bg/--surface onto the --shade-* primitives). */
function resolved(prop, depth = 0) {
  const v = lightValue(prop);
  const ref = v && /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref && depth < 6) return resolved(ref[1], depth + 1);
  return v;
}
/** Parse a #rrggbb (or #rgb) hex into [r,g,b]; null for non-hex (e.g. var(...)). */
function hex(v) {
  if (!v) return null;
  let m = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i].repeat(2), 16));
  return null;
}

test("the page ground is an explicit light shade, not near-white var(--g1) (TM-1073)", () => {
  const pageBg = resolved("--page-bg");
  const rgb = hex(pageBg);
  assert.ok(rgb, `--page-bg (light) must resolve to an explicit shade hex, got '${pageBg}' — not var(--g1) near-white`);
  assert.notEqual(pageBg, "#fafafa", "--page-bg must no longer resolve to --g1 (#fafafa) near-white (TM-1073)");
  // A real but LIGHT shade: every channel visibly below white (≤245) yet still light (≥205).
  assert.ok(
    rgb.every((c) => c <= 245) && rgb.every((c) => c >= 205),
    `--page-bg ${pageBg} must be a light neutral SHADE (all channels 205–245) so cards can pop without the page going dark`,
  );
});

test("the .app column ground (--surface) matches the page shade (TM-1073)", () => {
  // On wide viewports the centred column paints --surface; it must read the SAME shade as the phone
  // body's --page-bg, so the shade treatment is identical on both surfaces (not near-white on desktop).
  assert.equal(
    resolved("--surface"),
    resolved("--page-bg"),
    "--surface (the wide-viewport .app column ground) must resolve to the same shade as --page-bg so every screen reads identically",
  );
});

test("content cards stay pure white and pop against the shade (TM-1073)", () => {
  assert.match(
    NO_COMMENTS,
    /--surface-card:\s*var\(--white\)\s*;/,
    "--surface-card must stay var(--white) — the white content boxes that pop against the shade page",
  );
  // The invariant that makes the whole change worth doing: card-white ≠ page-shade.
  assert.notEqual(
    resolved("--surface-card"),
    resolved("--page-bg"),
    "the white card token must resolve to a different colour than the shade page token (otherwise cards don't pop) (TM-1073)",
  );
});

test("the wide-viewport canvas stays at least as deep as the shade column (TM-1073)", () => {
  // At desktop the column (shade) sits on --app-canvas; the canvas must be no lighter than the column
  // so the column edge still reads (a lighter canvas would make the column look like a dark inset).
  const canvas = hex(resolved("--app-canvas"));
  const column = hex(resolved("--surface"));
  assert.ok(canvas && column, "--app-canvas and --surface must both be explicit hexes for the depth check");
  const lum = ([r, g, b]) => r + g + b;
  assert.ok(
    lum(canvas) <= lum(column),
    "--app-canvas must be no lighter than the --surface column shade so the column edge reads at wide viewports (TM-1073)",
  );
});

// ── TM-1075: content is TOP-aligned and the .app column FILLS the viewport height. The old
//    `body { place-items: center }` vertically centred the column (short content floated mid-screen,
//    column background shrank to content). Pin: body top-aligns (start), .app fills 100dvh height. ──

test("body top-aligns the column (place-items: start center), never center (TM-1075)", () => {
  // Scope to the base `body { … }` rule block.
  const block = NO_COMMENTS.match(/(?:^|\n)body\s*\{[\s\S]*?\n\}/);
  assert.ok(block, "the base body { … } rule must exist");
  assert.match(
    block[0],
    /place-items:\s*start\s+center\b/,
    "body must use `place-items: start center` — TOP-aligned content, horizontal centring kept (TM-1075)",
  );
  assert.ok(
    !/place-items:\s*center\s*;/.test(block[0]),
    "body must NOT use the old `place-items: center` (that vertically centred the short column) (TM-1075)",
  );
  // TM-665 horizontal-centring cap must be untouched.
  assert.match(
    block[0],
    /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    "the TM-665 minmax(0, 1fr) column cap must survive the top-align change",
  );
});

test(".app fills the viewport height so its background spans top→bottom (TM-1075)", () => {
  // Scope to the base `.app { … }` width-agnostic rule (the one carrying padding + the safe-area
  // insets, i.e. the block that also has `text-align: center`).
  const block = NO_COMMENTS.match(/(?:^|\n)\.app\s*\{[\s\S]*?text-align:\s*center[\s\S]*?\n\}/);
  assert.ok(block, "the base .app { text-align: center; … } rule must exist");
  assert.match(
    block[0],
    /min-height:\s*100dvh/,
    ".app must set min-height: 100dvh so the column fills the dynamic viewport height (TM-1075/TM-295)",
  );
  assert.match(
    block[0],
    /min-height:\s*100vh/,
    ".app must keep a 100vh fallback before 100dvh for viewports without dvh support (TM-295)",
  );
  assert.match(
    block[0],
    /align-self:\s*stretch/,
    ".app must set align-self: stretch so the grid item stretches down the row track (TM-1075)",
  );
});

// ── TM-1074: the admin surface is a WIDE column. `.admin-console` wants min(72rem, 96vw) but the shell
//    clamps `.app` to the ≤480px phone band, so the wider child overflowed right. Fix: when `.app` holds
//    a visible admin console, `--app-max` re-points to the admin width so `.app` grows to fit it. ──

test("the admin surface widens the shell clamp via .app:has(> .admin-console:not([hidden])) (TM-1074)", () => {
  assert.match(
    NO_COMMENTS,
    /\.app:has\(\s*>\s*\.admin-console:not\(\[hidden\]\)\s*\)\s*\{[^}]*--app-max:\s*min\(\s*72rem\s*,\s*96vw\s*\)/,
    ".app:has(> .admin-console:not([hidden])) must re-point --app-max to min(72rem, 96vw) so the admin " +
      "column fits inside the shell (no right overflow) — gated on a VISIBLE admin console only (TM-1074)",
  );
  // .admin-console FILLS the widened .app content box (width/max-width: 100%) rather than setting its
  // own 72rem width — an own 72rem is WIDER than .app's padded content box and overflows right (clipped
  // by overflow-x:hidden). Filling to 100% makes .app's padding the symmetric gutter, no leak.
  const adminBlock = NO_COMMENTS.match(/\.admin-console\s*\{[\s\S]*?\n\}/);
  assert.ok(adminBlock, ".admin-console rule must exist");
  assert.match(
    adminBlock[0],
    /width:\s*100%/,
    ".admin-console must fill the widened .app content box (width: 100%), not set its own 72rem (which overflows .app's padded content box) (TM-1074)",
  );
  assert.match(
    adminBlock[0],
    /max-width:\s*100%/,
    ".admin-console must cap at max-width: 100% so it can never exceed the .app content box (TM-1074)",
  );
  assert.ok(
    !/width:\s*min\(\s*72rem\s*,\s*96vw\s*\)/.test(adminBlock[0]),
    ".admin-console must NOT set its own min(72rem, 96vw) width — that overflowed .app's padded content box (TM-1074)",
  );
  // The base clamp token is UNCHANGED — non-admin routes stay on the phone band (the :has scopes the
  // widen to the .app subtree only; #app-tabbar + non-admin routes read the untouched :root token).
  assert.match(
    NO_COMMENTS,
    /--app-max:\s*clamp\(\s*420px\s*,\s*40vw\s*,\s*480px\s*\)/,
    "the :root --app-max phone band must stay clamp(420px, 40vw, 480px) — only the admin subtree overrides it (TM-1074)",
  );
});
