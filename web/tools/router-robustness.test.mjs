// Regression tests for the router's error-handling hardening (TM-721). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THREE crashes, all inside guard()/currentRoute() (so they took the whole router down on a routine
// navigation), all now handled:
//   5. sessionStorage access THROWS in a locked-down WebView / incognito / cookies-blocked context —
//      not just the property lookup, getItem/setItem itself raises SecurityError. guard() used it raw.
//   6. decodeURIComponent THROWS a URIError on a malformed %-escape in an events/chat deep link
//      (`#/events/%E0%A4%A`, a lone `%`). eventDetailId/chatThreadId decoded raw.
//   7. resolveRoleThenGuard applied stale role/onboarding after an ACCOUNT SWITCH — it checked "is anyone
//      signed in?" (true for the new user) instead of "is it the SAME user?".
//
// router.js can't be imported under `node --test` (it sits on the api.js → Firebase CDN chain), so the
// pure guard helpers (safe-decode, safe-storage) are reimplemented 1:1 and driven behaviourally, and the
// DOM-coupled uid fix is pinned with a source guard — the same split membership-route-wiring.test.mjs uses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SRC = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

// ── Finding 6: safe percent-decoding — mirror of router.js safeDecodeSegment ─────────────────────────

function safeDecodeSegment(rest) {
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

test("safeDecodeSegment decodes a normal segment as before", () => {
  assert.equal(safeDecodeSegment("hello%20world"), "hello world");
  assert.equal(safeDecodeSegment("abc123"), "abc123");
});

test("safeDecodeSegment does NOT throw on a malformed %-escape — it falls back to the raw segment", () => {
  // These all make a bare decodeURIComponent throw URIError; the guard must survive and yield SOMETHING
  // (a garbage id → the screen shows 'couldn't load', instead of the router crashing).
  for (const bad of ["%E0%A4%A", "%", "%zz", "100%off"]) {
    assert.doesNotThrow(() => safeDecodeSegment(bad));
    assert.equal(safeDecodeSegment(bad), bad);
  }
});

test("a raw decodeURIComponent really does throw on those inputs (the bug this guards)", () => {
  assert.throws(() => decodeURIComponent("%E0%A4%A"), URIError);
});

// ── Finding 5: safe sessionStorage — mirror of router.js safeSessionGet/Set/Remove ───────────────────

function makeSafeStorage(storage) {
  return {
    get: (k) => { try { return storage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { storage.setItem(k, v); } catch { /* best-effort */ } },
    remove: (k) => { try { storage.removeItem(k); } catch { /* best-effort */ } },
  };
}

/** A storage that throws on every access, like a cookies-blocked / locked-down WebView. */
const throwingStorage = {
  getItem() { throw new DOMException("blocked", "SecurityError"); },
  setItem() { throw new DOMException("blocked", "SecurityError"); },
  removeItem() { throw new DOMException("blocked", "SecurityError"); },
};

test("safe storage wrappers never throw when the underlying storage is blocked (TM-721)", () => {
  const s = makeSafeStorage(throwingStorage);
  assert.doesNotThrow(() => s.set("tm.intendedRoute", "#/profile"));
  assert.doesNotThrow(() => s.remove("tm.intendedRoute"));
  assert.equal(s.get("tm.intendedRoute"), null, "a blocked read degrades to null (forget the route)");
});

test("safe storage wrappers still round-trip a normal working storage", () => {
  const map = new Map();
  const working = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
  const s = makeSafeStorage(working);
  s.set("tm.intendedRoute", "#/admin");
  assert.equal(s.get("tm.intendedRoute"), "#/admin");
  s.remove("tm.intendedRoute");
  assert.equal(s.get("tm.intendedRoute"), null);
});

// ── Source guards: the real router.js uses the safe helpers and the uid switch check ─────────────────

test("router.js guard() no longer touches sessionStorage raw — it goes through the safe wrappers (5)", () => {
  // Everything after the wrapper definitions must be safeSession*; a raw sessionStorage. call outside the
  // three wrapper bodies would re-open the crash. Count raw refs: exactly the 3 inside the wrappers.
  const rawRefs = ROUTER_SRC.match(/sessionStorage\./g) || [];
  assert.equal(rawRefs.length, 3, `only the 3 wrapper bodies may touch sessionStorage raw (found ${rawRefs.length})`);
  assert.match(ROUTER_SRC, /function\s+safeSessionSet\(/);
  assert.match(ROUTER_SRC, /function\s+safeSessionGet\(/);
  assert.match(ROUTER_SRC, /function\s+safeSessionRemove\(/);
});

test("router.js decodes deep-link segments through safeDecodeSegment, not raw decodeURIComponent (6)", () => {
  assert.match(ROUTER_SRC, /function\s+safeDecodeSegment\(/, "the safe decoder exists");
  // eventDetailId + chatThreadId must call it; a raw decodeURIComponent should only live inside the helper.
  const rawDecodes = ROUTER_SRC.match(/decodeURIComponent\(/g) || [];
  assert.equal(rawDecodes.length, 1, `decodeURIComponent should only appear inside safeDecodeSegment (found ${rawDecodes.length})`);
});

test("resolveRoleThenGuard guards by UID, not mere presence, so a mid-flight account switch is caught (7)", () => {
  const fn = ROUTER_SRC.match(/async function resolveRoleThenGuard\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate resolveRoleThenGuard()");
  const body = fn[1];
  assert.match(body, /const\s+uid\s*=\s*user\.uid;/, "the resolving user's uid is pinned up front");
  assert.match(body, /now\.uid\s*!==\s*uid/, "after the lookups it re-checks the SAME uid (not just signed-in)");
});
