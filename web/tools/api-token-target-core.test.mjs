// Token-target scoping for the authenticated API client (TM-722, TM-655 LOW web-security). Framework-free
// — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// api.js can't be imported under Node (its Firebase CDN import chain is unloadable), so the security
// predicate lives in the pure api-token-target-core.js and is exercised directly here. The invariant:
// the Firebase ID token rides ONLY on requests to our own backend (the configured API base or
// same-origin) — never on an arbitrary absolute URL, or a `javascript:`/`data:` pseudo-URL.

import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldAttachToken, originOf } from "../src/assets/api-token-target-core.js";

const API_BASE = "https://api.teammarhaba.example";
const SELF = "https://app.teammarhaba.example";

test("relative paths always get the token (they resolve to our own origin)", () => {
  for (const p of ["/api/v1/me", "api/v1/me", "/api/v1/conversations/1/stream", ""]) {
    assert.equal(shouldAttachToken(p, API_BASE, SELF), true, `relative path ${JSON.stringify(p)}`);
  }
});

test("an absolute URL on the configured API base origin gets the token", () => {
  assert.equal(shouldAttachToken(`${API_BASE}/api/v1/me`, API_BASE, SELF), true);
  // A path/port on the same origin is still the API base.
  assert.equal(shouldAttachToken(`${API_BASE}:443/x`, API_BASE, SELF), true);
});

test("a same-origin absolute URL gets the token even when it isn't the API base", () => {
  assert.equal(shouldAttachToken(`${SELF}/whatever`, API_BASE, SELF), true);
});

test("SECURITY: a foreign absolute URL NEVER gets the token (exfiltration seam is closed)", () => {
  assert.equal(shouldAttachToken("https://evil.example/collect", API_BASE, SELF), false);
  assert.equal(shouldAttachToken("http://evil.example/collect", API_BASE, SELF), false);
});

test("SECURITY: a look-alike host that only PREFIX-matches the API base is refused (origin, not string)", () => {
  // string-prefix logic would wrongly accept this; origin comparison rejects it.
  assert.equal(shouldAttachToken("https://api.teammarhaba.example.evil.com/x", API_BASE, SELF), false);
});

test("SECURITY: non-http(s) pseudo-URLs never get the token", () => {
  for (const u of ["javascript:alert(1)", "data:text/html,<script>1</script>", "mailto:x@y.z", "file:///etc/passwd", "//evil.example/x"]) {
    assert.equal(shouldAttachToken(u, API_BASE, SELF), false, `pseudo-URL ${u}`);
  }
});

test("with no known self origin, only the API base origin authorises an absolute URL", () => {
  assert.equal(shouldAttachToken(`${API_BASE}/x`, API_BASE, null), true);
  assert.equal(shouldAttachToken(`${SELF}/x`, API_BASE, null), false);
});

test("originOf normalises to scheme+host+port and returns null for the unparseable", () => {
  assert.equal(originOf("https://Api.Example.COM/path"), "https://api.example.com");
  assert.equal(originOf("not a url"), null);
  // A `javascript:` URL parses but has an OPAQUE origin (the string "null") — never a real origin, so it
  // can't equal the API/self origin, which is why shouldAttachToken refuses it. Assert that opaque origin
  // is not a usable http(s) origin.
  const opaque = originOf("javascript:alert(1)");
  assert.ok(opaque === null || !opaque.startsWith("http"), `javascript: must not yield an http origin (got ${opaque})`);
});
