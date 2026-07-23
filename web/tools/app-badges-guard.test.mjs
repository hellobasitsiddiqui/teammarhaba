// Source + seam guard for the "Get the app" store-badge behaviour (TM-974). Framework-free —
// Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Why source-level (same shape as otp-input-markup.test.mjs / events-aria-describedby.test.mjs):
// app-badges.js can't be imported under `node --test` — it's a side-effect module that imports ui.js
// and mutates the live DOM at import time (there's no pure exported seam). The runtime behaviour IS
// covered by an e2e spec (web/e2e/tests/webview-get-app-hidden.spec.mjs), but that runs on main only,
// AFTER merge. So the PR gate pins the contract two ways:
//   1. textually over app-badges.js + index.html (the hide gate + the iOS a11y attributes), and
//   2. against the REAL isWebViewEnv() from auth-env.js — the one piece that IS unit-testable — so the
//      "native shell hides the badges" decision is asserted on live logic, not just a string match.
//
// GROOMED SCOPE (TM-974): web behaviour is unchanged (both badges render; iOS is a "Coming soon"
// placeholder; web platform-detection is DEFERRED). This is a CHARACTERIZATION / REGRESSION GUARD:
// it pins the as-built native-shell hide + the disabled-iOS-badge a11y so a revert of either goes red.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isWebViewEnv } from "../src/assets/auth-env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), "utf8");

const BADGES = read("../src/assets/app-badges.js");
const HTML = read("../src/index.html");

/** The <button …> tag for the disabled iOS "Coming soon" badge in index.html (open tag only). */
function iosBadgeOpenTag() {
  const m = HTML.match(/<button[^>]*class="store-badge store-badge-disabled"[^>]*>/);
  assert.ok(m, "the disabled iOS store badge <button> exists in index.html");
  return m[0];
}

// ─── (1) Native-shell hide gate ──────────────────────────────────────────────────────────────────

test("app-badges.js gates the badge hide on isWebViewEnv() (the native-shell signal)", () => {
  // The hide branch is guarded by isWebViewEnv — not an unconditional hide, not a UA sniff.
  assert.match(BADGES, /import\s*\{\s*isWebViewEnv\s*\}\s*from\s*"\.\/auth-env\.js"/);
  assert.match(BADGES, /if\s*\(\s*isWebViewEnv\(\)\s*\)/, "hide is gated on isWebViewEnv()");
});

test("inside the WebView the whole #app-store-badges block is hidden via `hidden` (no reflow remove)", () => {
  // Sets `hidden` on the block — not remove(), not display:none — so the node stays inspectable.
  assert.match(
    BADGES,
    /getElementById\("app-store-badges"\)[\s\S]*?badges\.hidden\s*=\s*true/,
    "the WebView branch sets #app-store-badges.hidden = true",
  );
  assert.doesNotMatch(BADGES, /\.remove\(\)/, "the block is hidden, not removed (keeps it inspectable)");
});

test("the isWebViewEnv gate returns TRUE for both native-shell signals and FALSE on a plain page", () => {
  // Assert the real decision app-badges.js keys off (not just a string): the native Android/iOS shell
  // (TM-231) flags itself via a window boolean OR the injected JS bridge; a normal browser has neither.
  assert.equal(isWebViewEnv({ TEAMMARHABA_WEBVIEW: true }), true, "window boolean → hide");
  assert.equal(isWebViewEnv({ TeamMarhabaWebView: {} }), true, "JS bridge object → hide");
  assert.equal(isWebViewEnv({}), false, "plain browser page → badges stay");
  assert.equal(isWebViewEnv({ TEAMMARHABA_WEBVIEW: false }), false, "a falsy flag does NOT hide");
});

// ─── (2) Disabled iOS badge accessibility ────────────────────────────────────────────────────────

test("the static iOS badge is announced unavailable and carries an accessible label", () => {
  const tag = iosBadgeOpenTag();
  // It's a real <button>, not a dead <a> (a disabled link would still take focus + look clickable).
  assert.match(tag, /^<button/, "the iOS badge is a <button>, not a link");
  // Announced disabled to assistive tech.
  assert.match(tag, /aria-disabled="true"/, "iOS badge is announced disabled via aria-disabled");
  // Has an accessible name (the visible 'Coming soon / iOS' text is decorative-glyph-adjacent, so an
  // explicit aria-label pins the announced name).
  assert.match(tag, /aria-label="[^"]+"/, "iOS badge has an accessible label");
});

test("web runtime keeps the iOS badge announced-unavailable but tappable — not a silent dead button", () => {
  // On the web path app-badges.js removes the native `disabled` (so the button emits a click and can be
  // reached) yet re-asserts aria-disabled=true, so it stays announced unavailable while giving honest
  // toast feedback on tap instead of being a silent no-op. That's tappable-but-not-a-focus-trap +
  // still-labelled — the a11y contract for the placeholder.
  assert.match(BADGES, /\.store-badge-disabled/, "the web branch targets the disabled iOS badge");
  assert.match(BADGES, /removeAttribute\("disabled"\)/, "web path removes `disabled` so it's reachable/tappable");
  assert.match(
    BADGES,
    /setAttribute\("aria-disabled",\s*"true"\)/,
    "web path KEEPS aria-disabled=true (still announced unavailable, not silently 'enabled')",
  );
  assert.match(BADGES, /addEventListener\("click"/, "a tap gets honest feedback (a toast), not silence");
});
