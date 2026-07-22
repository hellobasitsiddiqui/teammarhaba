// Profile load-skeleton + narrow-width regression guards (TM-663 + TM-665). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUGS (both on the Profile screen, from a 2026-07-12 Android screen recording):
//   • TM-663: entering Profile briefly flashed a concrete, MISLEADING empty placeholder — a "Your
//     profile" name with a "0% complete" strength bar — for a heartbeat before GET /me resolved, so an
//     established user was told their profile was empty. The concrete strings were hardcoded as the
//     initial render in buildShell().
//   • TM-665: on the narrow Android WebView the Profile content clipped on the RIGHT edge — flex rows
//     (strength label, membership row, menu rows) couldn't shrink/wrap, pushing content past the card.
//
// THE FIXES:
//   • TM-663: the identity name + strength percentage now start BLANK and the screen mounts with a
//     `.tm-pf-loading` skeleton class that paintHub() removes on the first real /me paint (and
//     renderStatus() removes on a load error). No concrete "0%/Your profile" ever paints pre-load.
//   • TM-665: the Profile column caps at max-width:100% and its flex rows get min-width:0 / wrapping so
//     long content wraps within the card instead of overflowing right on the narrow shell width.
//
// profile.js can't be imported under `node --test` (it sits on the api.js → Firebase CDN chain), so —
// exactly like profile-membership-row.test.mjs / membership-route-wiring.test.mjs — these are
// SOURCE-LEVEL guards over the profile.js render path and the styles.css profile rules. This is the
// fail-before / pass-after test: pre-fix the concrete literals were the initial render and the overflow
// guards were absent (fails); post-fix the pre-data render is the skeleton and the guards are present
// (passes).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_SRC = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const STYLES_SRC = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

// The hub-building region of profile.js: from the identity-header comment to the point the shell object
// is assembled. Scoping the pre-data assertions here keeps them precise — paintHub() legitimately SETS
// the real text at runtime; what must not exist is a CONCRETE misleading value in the INITIAL render.
function hubBuildRegion() {
  const start = PROFILE_SRC.indexOf("Identity header (paper-profile)");
  const end = PROFILE_SRC.indexOf("shell = {");
  assert.ok(start > 0 && end > start, "expected to find the hub-building region of buildShell()");
  return PROFILE_SRC.slice(start, end);
}

// ---- TM-663: no concrete misleading placeholder pre-load, a skeleton instead --------------------

test("TM-663: the pre-data identity render is BLANK, not the misleading 'Your profile' placeholder", () => {
  const region = hubBuildRegion();
  // The hub name node must start empty (text: "") — the "Your profile" placeholder is exactly the
  // misleading concrete value the recording caught flashing for an established user.
  assert.doesNotMatch(
    region,
    /const\s+hubName\s*=\s*el\([^)]*text:\s*"Your profile"/s,
    "hubName must NOT be initialised to the concrete 'Your profile' placeholder — it flashes before /me resolves",
  );
  assert.match(
    region,
    /const\s+hubName\s*=\s*el\([^)]*text:\s*""/s,
    "hubName must start blank so the skeleton fills the gap until paintHub() lands the real name",
  );
});

test("TM-663: the pre-data strength render is BLANK, not the misleading '0% complete'", () => {
  // TM-913: the strength percent is now the RING's centre label — built blank in strengthRing() (the
  // `pct` span, `text: ""`). The guarantee is unchanged: no concrete 0% (or "0% complete") flashes
  // before /me resolves. Assert the ring's centre label starts blank in its builder.
  const ringStart = PROFILE_SRC.indexOf("function strengthRing()");
  assert.ok(ringStart > 0, "expected the strengthRing() builder to exist");
  const ringBody = PROFILE_SRC.slice(ringStart, PROFILE_SRC.indexOf("function pfCard", ringStart));
  assert.doesNotMatch(
    ringBody,
    /const\s+pct\s*=\s*el\([^)]*text:\s*"0%/s,
    "the ring's centre percent must NOT be initialised to a concrete 0% — that's the misleading pre-load flash",
  );
  assert.match(
    ringBody,
    /const\s+pct\s*=\s*el\([^)]*text:\s*""/s,
    "the ring's centre percent must start blank so a loaded user never sees a concrete 0% before real strength paints",
  );
});

test("TM-663: the screen mounts with the loading-skeleton class until real data paints", () => {
  // The .tm-pf root is built with the skeleton class...
  assert.match(
    PROFILE_SRC,
    /class:\s*"tm-pf tm-pf-loading"/,
    "buildShell must mount the profile root with `tm-pf-loading` so the hub shows a skeleton pre-load",
  );
  // ...and paintHub() removes it when the real /me data lands.
  assert.match(
    PROFILE_SRC,
    /paintHub[\s\S]*?classList\.remove\("tm-pf-loading"\)/,
    "paintHub must remove `tm-pf-loading` on the first real paint so the concrete identity/strength show",
  );
  // ...and a load error also clears it (so the skeleton never hangs forever).
  assert.match(
    PROFILE_SRC,
    /state\.error[\s\S]*?classList\.remove\("tm-pf-loading"\)/,
    "renderStatus must clear `tm-pf-loading` on a load error so the skeleton never shimmers indefinitely",
  );
});

test("TM-663: the loading skeleton is styled with a token-only shimmer (theme-safe)", () => {
  assert.match(
    STYLES_SRC,
    /\.tm-pf-loading\b/,
    "styles.css must define the .tm-pf-loading skeleton rules the profile screen mounts with",
  );
  assert.match(
    STYLES_SRC,
    /@keyframes\s+tm-pf-shimmer/,
    "the skeleton must animate via a defined shimmer keyframe",
  );
  // TOKEN-ONLY: the skeleton must not hardcode a colour — it inks with Paper surface tokens so it works
  // across every accent + both toggle states (grep the skeleton block for a raw hex/rgb).
  const skelStart = STYLES_SRC.indexOf(".tm-pf-loading");
  const skelBlock = STYLES_SRC.slice(skelStart, STYLES_SRC.indexOf("@keyframes tm-pf-shimmer"));
  assert.doesNotMatch(
    skelBlock,
    /#[0-9a-fA-F]{3,8}\b|\brgb\(/,
    "the skeleton must be token-only (var(--surface*)) — no hardcoded colour",
  );
  assert.match(skelBlock, /var\(--surface/, "the skeleton must ink with a --surface* token");
});

// ---- TM-665: nothing clips on the right at the narrow shell width --------------------------------

test("TM-665: the Profile column can't exceed its own box (no sideways overflow / right clip)", () => {
  const start = STYLES_SRC.indexOf(".tm-pf {");
  const block = STYLES_SRC.slice(start, STYLES_SRC.indexOf("}", start));
  assert.match(block, /max-width:\s*100%/, ".tm-pf must cap at max-width:100% so it never overflows the shell");
  assert.match(block, /overflow-wrap:\s*anywhere/, ".tm-pf must wrap long unbreakable content, not push it off-screen");
});

test("TM-665: the strength label wraps instead of forcing the row wider than the card", () => {
  const start = STYLES_SRC.indexOf(".tm-pf-barlbl {");
  const block = STYLES_SRC.slice(start, STYLES_SRC.indexOf("}", start));
  assert.match(block, /flex-wrap:\s*wrap/, ".tm-pf-barlbl must allow the label + nudge to wrap on a narrow phone");
});

test("TM-665: the membership tier block is shrinkable so 'Manage →' isn't pushed off the right edge", () => {
  const start = STYLES_SRC.indexOf(".tm-pf-memb-main {");
  assert.ok(start > 0, ".tm-pf-memb-main must have a rule making it shrinkable");
  const block = STYLES_SRC.slice(start, STYLES_SRC.indexOf("}", start));
  assert.match(block, /min-width:\s*0/, ".tm-pf-memb-main must be shrinkable (min-width:0) so the row can't overflow right");
});

test("TM-665: menu rows keep the chevron on-screen — the label wraps, the chevron stays fixed", () => {
  const rowStart = STYLES_SRC.indexOf(".tm-pf-menu-row {");
  const rowBlock = STYLES_SRC.slice(rowStart, STYLES_SRC.indexOf("}", rowStart));
  assert.match(rowBlock, /max-width:\s*100%/, "a menu row must not exceed the card width");
  assert.match(rowBlock, /min-width:\s*0/, "a menu row must be shrinkable so a long label wraps instead of overflowing");
});

// ---- TM-913: the strength ring (SVG progress ring, was a horizontal bar) -------------------------
// These are the render-path + styles.css guards for the ring swap. profile.js can't be imported under
// `node --test` (Firebase CDN chain), so — like the TM-663 guards above — they assert over the source.
// The behavioural dashoffset math is exercised for real in profile-core.test.mjs (strengthRingGeometry).

test("TM-913: the strength card renders an SVG progress ring, not the old horizontal bar", () => {
  // The old bar markup (`<div class="tm-pf-bar"><i></i></div>`) is gone from the render path...
  assert.doesNotMatch(PROFILE_SRC, /class:\s*"tm-pf-bar"/, "the horizontal bar markup must be replaced by the ring");
  assert.doesNotMatch(STYLES_SRC, /\.tm-pf-bar\s*\{/, "the .tm-pf-bar bar styles must be replaced by the ring styles");
  // ...replaced by a strengthRing() builder that mounts an SVG <circle> fill arc.
  assert.match(PROFILE_SRC, /function\s+strengthRing\(\)/, "a strengthRing() builder must exist");
  assert.match(PROFILE_SRC, /class:\s*"tm-pf-ring-arc"[\s\S]*?"stroke-dasharray"/, "the fill arc must be a dash-array clipped circle");
});

test("TM-913: paintHub drives the ring arc's dashoffset from the real strength percent", () => {
  // paintHub sets stroke-dashoffset off strengthRingGeometry(percent) — the ring reflects percent.
  assert.match(
    PROFILE_SRC,
    /ringArc\.style\.strokeDashoffset\s*=\s*String\(strengthRingGeometry\(strength\.percent/,
    "paintHub must set the arc's dashoffset from strengthRingGeometry(strength.percent)",
  );
  // The centre label is the bare percent (no "complete" — that stays in the nudge line, agreed default).
  assert.match(
    PROFILE_SRC,
    /barPct\.textContent\s*=\s*`\$\{strength\.percent\}%`/,
    "the ring centre must show the bare percent (e.g. '87%'), not '87% complete'",
  );
});

test("TM-913: the ring carries role=progressbar with live aria-valuenow reflecting the percent", () => {
  // The ring container is the progressbar (min/max fixed 0..100 at build time).
  assert.match(PROFILE_SRC, /role:\s*"progressbar"/, "the ring must be a role=progressbar");
  assert.match(PROFILE_SRC, /"aria-valuemin":\s*"0"/, "the progressbar must declare aria-valuemin=0");
  assert.match(PROFILE_SRC, /"aria-valuemax":\s*"100"/, "the progressbar must declare aria-valuemax=100");
  // paintHub sets valuenow (+ a spoken valuetext) to the live percent.
  assert.match(
    PROFILE_SRC,
    /ring\.setAttribute\("aria-valuenow",\s*String\(strength\.percent\)\)/,
    "paintHub must set aria-valuenow to the live strength percent",
  );
  // The decorative SVG is aria-hidden so the SR announces one progressbar node, not the raw circles.
  assert.match(PROFILE_SRC, /class:\s*"tm-pf-ring-svg"[\s\S]*?"aria-hidden":\s*"true"/, "the ring SVG must be aria-hidden");
});

test("TM-913: the ring fill animates on paint but is silenced under prefers-reduced-motion", () => {
  const arcStart = STYLES_SRC.indexOf(".tm-pf-ring-arc {");
  assert.ok(arcStart > 0, ".tm-pf-ring-arc must have a rule");
  const arcBlock = STYLES_SRC.slice(arcStart, STYLES_SRC.indexOf("}", arcStart));
  assert.match(arcBlock, /transition:\s*stroke-dashoffset/, "the arc must animate its dashoffset on paint");
  // A reduced-motion block must drop the arc's transition (no animated fill when reduced).
  assert.match(
    STYLES_SRC,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.tm-pf-ring-arc\s*\{[\s\S]*?transition:\s*none/,
    "prefers-reduced-motion must silence the ring fill animation",
  );
});

test("TM-913: the loading skeleton adapts to the RING shape (a disc), not a bar", () => {
  // The skeleton makes the ring box a round shimmer disc and hides the concrete arc + percent while
  // loading — so nothing (no misleading 0% arc/number) flashes before real strength lands.
  assert.match(STYLES_SRC, /\.tm-pf-loading\s+\.tm-pf-ring\s*\{[\s\S]*?border-radius:\s*50%/, "the skeleton must round the ring box into a disc");
  assert.match(
    STYLES_SRC,
    /\.tm-pf-loading\s+\.tm-pf-ring-svg[\s\S]*?visibility:\s*hidden/,
    "the concrete arc + percent must be hidden under the shimmer while loading",
  );
});
