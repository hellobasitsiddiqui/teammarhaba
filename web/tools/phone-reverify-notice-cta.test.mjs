// TM-1005 — the grace banner's "Verify now" CTA must LAND somewhere. Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG THIS PINS SHUT: the TM-992 grace banner told a re-verify-eligible account to verify, and its
// "Verify now" hash-navved to #/onboarding — but during the grace window the router still counts the
// account as onboarded (the verified-phone term only folds into the gate on HARD_GATE), so router.js's
// "onboarded user on #/onboarding" guard bounced them straight back home. The CTA went nowhere. The fix
// routes it to #/profile (REVERIFY_CTA_TARGET — where the TM-1005 "Verify this number" affordance
// lives) and dispatches PHONE_VERIFY_REQUEST_EVENT so the profile reveals + focuses that affordance.
//
// HOW IT'S TESTED: phone-reverify-notice.js statically imports auth.js (the Firebase CDN chain), so it
// can't be `import`ed under `node --test`. Like profile-edit-behaviour.test.mjs we eval the REAL source
// as a data: URL with its imports replaced by injected deps — the PURE deps (session-guard-core,
// profile-core.needsVerifiedPhone, the whole phone-reverify-core contract) are the REAL modules, so the
// banner-show decision and the CTA target under test are the shipped ones; only auth/api/el are fakes.
//
// FAIL-BEFORE / PASS-AFTER: on pre-TM-1005 main the `import { REVERIFY_CTA_TARGET,
// PHONE_VERIFY_REQUEST_EVENT }` from the real phone-reverify-core.js throws at load (the exports don't
// exist) — the file is red. And behaviourally, main's CTA set hash "#/onboarding" and dispatched no
// event, failing both core assertions. With the fix, everything below passes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { needsVerifiedPhone } from "../src/assets/profile-core.js";
import { sessionKey, isResponseCurrent } from "../src/assets/session-guard-core.js";
import {
  phoneReverifyDecision,
  parseReverifyDeadline,
  reverifyNoticeText,
  ReverifyDecision,
  REVERIFY_CTA_TARGET,
  PHONE_VERIFY_REQUEST_EVENT,
} from "../src/assets/phone-reverify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- a minimal fake DOM node — just the surface the notice module touches ------------------------
function fakeNode(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    hidden: false,
    _attrs: {},
    _children: [],
    _listeners: {},
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    addEventListener(type, fn) {
      this._listeners[type] = fn;
    },
    appendChild(n) {
      this._children.push(n);
      return n;
    },
    removeChild(n) {
      this._children = this._children.filter((c) => c !== n);
      return n;
    },
    get firstChild() {
      return this._children[0] ?? null;
    },
    prepend(n) {
      this._children.unshift(n);
    },
    insertAdjacentElement(_where, n) {
      this._children.push(n);
    },
  };
}

// A fake ui.js `el(tag, props, children)` mirroring the real contract for the touched surface:
// text → textContent, class/id/role/… → attributes, onXxx → addEventListener (ui.js line ~26).
function fakeElBuilder(tag, props = {}, children = []) {
  const node = fakeNode(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "hidden") node.hidden = Boolean(v);
    else if (/^on[A-Z]/.test(k)) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) if (c != null) node.appendChild(c);
  return node;
}

/** Depth-first search for the node carrying the given class token. */
function findByClass(node, cls) {
  if (!node || typeof node !== "object") return null;
  const classes = (node.getAttribute?.("class") || "").split(/\s+/);
  if (classes.includes(cls)) return node;
  for (const child of node._children || []) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

// ---- load the REAL notice source with its imports replaced by injected deps ----------------------
let currentUserImpl = () => null;
let getMeImpl = async () => ({});
const AUTH_CALLBACKS = [];

const deps = {
  onAuthChanged: (cb) => {
    AUTH_CALLBACKS.push(cb); // captured, NOT invoked — tests drive refresh() directly
  },
  currentUser: (...a) => currentUserImpl(...a),
  getMe: (...a) => getMeImpl(...a),
  el: fakeElBuilder,
  // The REAL pure logic — the show decision + CTA contract under test are the shipped ones.
  sessionKey,
  isResponseCurrent,
  needsVerifiedPhone,
  phoneReverifyDecision,
  parseReverifyDeadline,
  reverifyNoticeText,
  ReverifyDecision,
  REVERIFY_CTA_TARGET,
  PHONE_VERIFY_REQUEST_EVENT,
};

function loadNoticeModule() {
  const src = readFileSync(join(HERE, "../src/assets/phone-reverify-notice.js"), "utf8");
  const withoutImports = src.replace(/^import[\s\S]*?;\s*$/gm, "");
  const preamble =
    "const { onAuthChanged, currentUser, getMe, el, sessionKey, isResponseCurrent, needsVerifiedPhone,\n" +
    "  phoneReverifyDecision, parseReverifyDeadline, reverifyNoticeText, ReverifyDecision,\n" +
    "  REVERIFY_CTA_TARGET, PHONE_VERIFY_REQUEST_EVENT,\n" +
    "} = globalThis.__NOTICE_DEPS__;\n";
  const code = preamble + withoutImports;
  assert.doesNotMatch(code, /^import[\s\S]*?from/m, "all top-level imports must be replaced before eval");
  globalThis.__NOTICE_DEPS__ = deps;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

// The fake page: a `main.app` the banner mounts into, id-lookups, and a window that records the CTA's
// hash navigation + dispatched events. getElementById searches the mounted tree LIVE — host() relies
// on finding its already-mounted node (otherwise every call would mount a duplicate).
const APP = fakeNode("main");
const DISPATCHED = [];
globalThis.document = {
  getElementById: (id) => APP._children.find((c) => c.getAttribute?.("id") === id) ?? null,
  querySelector: (sel) => (sel === "main.app" ? APP : null),
  createElement: (tag) => fakeNode(tag),
};
globalThis.window = {
  location: { hash: "#/home" },
  dispatchEvent: (ev) => {
    DISPATCHED.push(ev);
    return true;
  },
  addEventListener: () => {},
};

const notice = await loadNoticeModule();

/** The mounted banner host (host() prepends it into main.app on first use). */
function registeredHost() {
  return globalThis.document.getElementById("phone-reverify-notice");
}

test("TM-1005: the grace banner's 'Verify now' navigates to #/profile and dispatches the handoff event", async () => {
  // A re-verify-eligible account in the grace window: a stored phone, nothing Firebase-linked, no
  // configured deadline (the safe default → GRACE_NUDGE).
  currentUserImpl = () => ({ uid: "u-1005", phoneNumber: null });
  getMeImpl = async () => ({ phone: "+447700900123" });
  await notice.refresh();

  const host = registeredHost();
  assert.ok(host, "the grace banner mounts into main.app");
  assert.equal(host.hidden, false, "the banner shows for the grace-nudge decision");

  const cta = findByClass(host, "tm-verify-banner-resend");
  assert.ok(cta, "the banner renders its 'Verify now' CTA");
  assert.equal(cta.textContent, "Verify now");

  // Tap it — the shipped click listener (ui.js wires onClick via addEventListener("click")).
  cta._listeners.click();

  // The dead-end fix: land where the verify affordance lives, NOT on the bouncing onboarding gate…
  assert.equal(globalThis.window.location.hash, REVERIFY_CTA_TARGET, "CTA navigates to the profile");
  assert.equal(REVERIFY_CTA_TARGET, "#/profile");
  assert.notEqual(globalThis.window.location.hash, "#/onboarding", "never the router-bounced gate route");
  // …and announce the intent so the profile reveals + focuses the affordance.
  assert.equal(DISPATCHED.length, 1, "exactly one handoff event dispatches");
  assert.equal(DISPATCHED[0].type, PHONE_VERIFY_REQUEST_EVENT, "the shared contract event name");
  assert.equal(host.hidden, true, "the banner hides once the CTA is taken");
});

test("TM-1005: refresh() clears the banner once the stored phone becomes the verified one", async () => {
  // After the profile-side verify links the credential, currentUser().phoneNumber IS the stored number
  // — the profile asks the banner to re-check (window.tmPhoneReverifyNotice.refresh()); it must clear.
  currentUserImpl = () => ({ uid: "u-1005", phoneNumber: "+447700900123" });
  getMeImpl = async () => ({ phone: "+447700900123" });
  await notice.refresh();
  const host = registeredHost();
  assert.ok(host, "the banner host exists from the previous test's mount");
  assert.equal(host.hidden, true, "verified ⇒ the nag is gone");
});
