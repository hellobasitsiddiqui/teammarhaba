// Web-security config guards (TM-722, TM-655 LOW web-security cluster). Framework-free — Node's built-in
// test runner (`node --test web/tools/*.test.mjs`).
//
// Two static config assertions that can't be covered by DOM/unit tests because the boundary IS the
// config file:
//   1. firebase.json Hosting serves the SPA/admin console WITH a set of security headers (CSP,
//      X-Content-Type-Options, X-Frame-Options, Referrer-Policy) — the app previously shipped with none.
//   2. storage.rules does NOT accept `image/svg+xml` for the publicly-readable upload paths (an SVG is an
//      active document → stored-XSS vector when served world-readable); it restricts to raster types.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─────────────────────────────── firebase.json security headers (findings 2 & 3) ───────────────────
const firebaseJson = JSON.parse(readFileSync(join(repoRoot, "firebase.json"), "utf8"));

/** The header map for the catch-all `**` Hosting source, keyed by header name. */
function catchAllHeaders() {
  const headers = firebaseJson.hosting?.headers ?? [];
  const block = headers.find((h) => h.source === "**");
  assert.ok(block, "firebase.json hosting.headers must have a catch-all `**` block");
  const map = {};
  for (const { key, value } of block.headers) map[key] = value;
  return map;
}

test("the SPA is served with a Content-Security-Policy", () => {
  const csp = catchAllHeaders()["Content-Security-Policy"];
  assert.ok(csp, "firebase.json must set a Content-Security-Policy on the `**` source (finding 2/3)");
  // Lock the dangerous vectors: no plugins, no framing (clickjacking), locked base-uri.
  assert.match(csp, /object-src 'none'/, "CSP must set object-src 'none'");
  assert.match(csp, /frame-ancestors 'none'/, "CSP must set frame-ancestors 'none' (anti-clickjacking)");
  assert.match(csp, /base-uri 'self'/, "CSP must set base-uri 'self'");
  assert.match(csp, /default-src 'self'/, "CSP must set a restrictive default-src");
  // Scripts: self + the Firebase SDK CDN + the Revolut widget — and NO 'unsafe-inline' script exec.
  assert.match(csp, /script-src[^;]*https:\/\/www\.gstatic\.com/, "CSP script-src must allow the Firebase SDK (gstatic)");
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, "CSP script-src must NOT allow 'unsafe-inline' (XSS)");
  // Firebase phone/SMS auth (TM-1002): the SDK's invisible reCAPTCHA hard-codes
  // https://www.google.com/recaptcha/ for BOTH the api.js loader script AND the challenge iframe
  // (see web/src/assets/auth.js — RecaptchaVerifier). If either directive omits it, the loader is
  // CSP-blocked, the verifier never renders, and EVERY phone number fails sign-in in prod — an
  // emulator run can't catch this (test numbers bypass real reCAPTCHA), so the header is pinned here.
  // The allowance is path-scoped (`/recaptcha/`) so the rest of google.com stays blocked.
  assert.match(csp, /script-src[^;]*www\.google\.com\/recaptcha\//, "CSP script-src must allow the reCAPTCHA loader (TM-1002 — breaks ALL phone auth)");
  assert.match(csp, /frame-src[^;]*www\.google\.com\/recaptcha\//, "CSP frame-src must allow the reCAPTCHA challenge iframe (TM-1002 — breaks ALL phone auth)");
  assert.match(csp, /frame-src[^;]*recaptcha\.google\.com\/recaptcha\//, "CSP frame-src must allow the recaptcha.google.com challenge host (TM-1002 — breaks ALL phone auth)");
  // Fonts + the Revolut card iframe must survive the policy (regression: don't break the app).
  assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/, "CSP must allow the Google Fonts font host");
  assert.match(csp, /frame-src[^;]*revolut\.com/, "CSP frame-src must allow the Revolut checkout iframe");
});

test("the SPA is served with the core security headers", () => {
  const h = catchAllHeaders();
  assert.equal(h["X-Content-Type-Options"], "nosniff", "must send X-Content-Type-Options: nosniff");
  assert.equal(h["X-Frame-Options"], "DENY", "must send X-Frame-Options: DENY (anti-clickjacking)");
  assert.ok(h["Referrer-Policy"], "must send a Referrer-Policy");
});

test("the immutable /assets cache header is preserved (regression)", () => {
  const headers = firebaseJson.hosting?.headers ?? [];
  const assets = headers.find((h) => h.source === "/assets/**");
  assert.ok(assets, "the /assets/** long-cache header block must be preserved");
});

// ─────────────────────────────── storage.rules: no public SVG (finding 5) ───────────────────────────
const rules = readFileSync(join(repoRoot, "storage.rules"), "utf8");

test("SECURITY: storage.rules does not accept svg for public-read uploads (no image/.* wildcard)", () => {
  // The permissive `image/.*` wildcard (which matches image/svg+xml) must be gone from the write rules.
  assert.doesNotMatch(
    rules,
    /contentType\.matches\('image\/\.\*'\)/,
    "storage.rules must not use the image/.* wildcard — it accepts image/svg+xml (stored-XSS)",
  );
});

test("storage.rules restricts public uploads to a raster allowlist that excludes svg", () => {
  const m = rules.match(/matches\('image\/\(([^)]*)\)'\)/);
  assert.ok(m, "storage.rules must gate uploads on an explicit image/(…) content-type allowlist");
  const allowed = m[1].split("|").map((s) => s.trim());
  assert.ok(allowed.includes("png") && allowed.includes("jpeg"), "the raster allowlist must include png + jpeg");
  assert.ok(!allowed.some((t) => /svg/i.test(t)), `the allowlist must NOT include svg (got: ${allowed.join(", ")})`);
});

test("every public write path uses the raster guard (avatars, event-images, venue-images)", () => {
  // The guard helper must be referenced by all three create/update blocks — no path left on a wildcard.
  const uses = (rules.match(/isPublicRasterImage\(\)/g) || []).length;
  assert.ok(uses >= 4, `expected the raster guard defined + used in 3 write blocks, saw ${uses} references`);
});
