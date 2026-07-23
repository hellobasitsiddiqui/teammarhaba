// TM-1007 — phone OTP RESEND lifecycle contract for the shared invisible-reCAPTCHA verifier.
//
// THE BUG THIS PINS: auth.js used to do `verifier.clear()` + `new RecaptchaVerifier(...)` on the
// SAME container element on EVERY send. In the Firebase modular SDK, `clear()` on an *invisible*
// verifier does NOT remove the already-rendered widget DOM from the container (recaptcha_verifier.ts
// only removes child nodes for visible widgets), so the second construction hits grecaptcha.render's
// "reCAPTCHA has already been rendered in this element" throw. First send = clean container = works;
// RESEND = dirty container = throws → the user sees the generic "Couldn't verify that number"
// (onboarding.js phoneVerifyErrorCopy fallback). The fix is the Firebase-idiomatic lifecycle:
// an invisible verifier is created ONCE per verify session and REUSED across sends (the SDK itself
// calls `verifier._reset()` after every send, re-arming the widget), with a full container reset
// only when a genuinely new verifier must be built.
//
// WHY THIS IS A UNIT TEST, NOT E2E: the e2e Auth-emulator path sets
// `auth.settings.appVerificationDisabledForTesting = true` (auth.js ~:70), which swaps in Firebase's
// MockReCaptcha — no real widget is ever rendered, so the dirty-container throw is UNREACHABLE in
// CI. Real-reCAPTCHA behaviour can only be exercised by hand in a browser (same e2e gap class as
// TM-1002). This suite therefore pins the lifecycle DECISIONS with a strict fake that reproduces
// grecaptcha.render's dirty-container throw exactly — a regression back to recreate-per-send goes
// red here the same way production went red on resend.
//
// auth.js itself imports Firebase from a `https:` gstatic URL, so it can't be imported under
// node --test (same constraint as login.js — see otp-input-dom.test.mjs's header). The decision
// logic lives in the pure, dependency-free recaptcha-session-core.js (tested for real below) and a
// source-level guard asserts auth.js actually routes BOTH phone flows through it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  obtainRecaptchaVerifier,
  discardRecaptchaVerifier,
} from "../src/assets/recaptcha-session-core.js";

/**
 * Minimal fake container element — just the DOM surface the core module touches (children,
 * replaceChildren / removeChild fallback, isConnected), mirroring the fake-element style of
 * otp-input-dom.test.mjs.
 */
function makeContainer({ withReplaceChildren = true } = {}) {
  const container = {
    isConnected: true,
    children: [],
    get firstChild() {
      return this.children[0] ?? null;
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    removeChild(node) {
      const i = this.children.indexOf(node);
      if (i === -1) throw new Error("removeChild: node not found");
      this.children.splice(i, 1);
      return node;
    },
  };
  if (withReplaceChildren) {
    container.replaceChildren = (...nodes) => {
      container.children = [...nodes];
    };
  }
  return container;
}

/**
 * Strict fake RecaptchaVerifier factory reproducing the two real-SDK behaviours the bug hinged on:
 *   1. grecaptcha.render THROWS when the host element already contains a rendered widget — the
 *      exact TM-1007 resend failure ("reCAPTCHA has already been rendered in this element").
 *   2. `clear()` on an INVISIBLE verifier leaves the widget DOM in the container (the real
 *      recaptcha_verifier.ts only removes childNodes for visible widgets) — which is why
 *      clear-then-recreate was never enough.
 */
function makeStrictVerifierFactory() {
  const created = [];
  const create = (containerEl) => {
    if (containerEl.children.length > 0) {
      throw new Error("reCAPTCHA has already been rendered in this element");
    }
    const verifier = {
      cleared: false,
      widget: { kind: "recaptcha-widget" },
      clear() {
        this.cleared = true; // invisible widget: DOM deliberately left in place, like the real SDK
      },
    };
    containerEl.appendChild(verifier.widget);
    created.push(verifier);
    return verifier;
  };
  return { create, created };
}

test("first send on a clean container creates exactly one verifier, rendered into the container", () => {
  const session = { verifier: null, container: null };
  const container = makeContainer();
  const { create, created } = makeStrictVerifierFactory();

  const verifier = obtainRecaptchaVerifier(session, container, create);

  assert.equal(created.length, 1, "one verifier created for the first send");
  assert.equal(verifier, created[0]);
  assert.equal(container.children.length, 1, "the widget is rendered into the container");
});

test("RESEND on the same container REUSES the live verifier — no second create, no dirty-container throw", () => {
  const session = { verifier: null, container: null };
  const container = makeContainer();
  const { create, created } = makeStrictVerifierFactory();

  const first = obtainRecaptchaVerifier(session, container, create);
  // The resend path (onboarding.js resendBtn → sendPhoneCode → startPhoneVerify, and login.js
  // smsResend → sendSms → startPhoneSignIn) obtains again against the SAME container. Under the
  // old recreate-per-send behaviour the strict factory throws here, exactly like production.
  const second = obtainRecaptchaVerifier(session, container, create);

  assert.equal(second, first, "the resend reuses the SAME verifier instance");
  assert.equal(created.length, 1, "no second verifier is constructed for a resend");
  assert.equal(container.children.length, 1, "exactly one widget in the container — no duplicates");
  assert.equal(first.cleared, false, "the live verifier is not cleared mid-session");
});

test("a NEW container (fresh gate mount / other flow) retires the old verifier and creates a fresh one", () => {
  const session = { verifier: null, container: null };
  const gateContainer = makeContainer();
  const loginContainer = makeContainer();
  const { create, created } = makeStrictVerifierFactory();

  const first = obtainRecaptchaVerifier(session, gateContainer, create);
  const second = obtainRecaptchaVerifier(session, loginContainer, create);

  assert.notEqual(second, first, "a different container gets a fresh verifier");
  assert.equal(created.length, 2);
  assert.equal(first.cleared, true, "the previous session's verifier is clear()ed");
  assert.equal(session.verifier, second);
  assert.equal(session.container, loginContainer);
});

test("after a discard (failed send), the next obtain fully resets the stale widget DOM before recreating", () => {
  const session = { verifier: null, container: null };
  const container = makeContainer();
  const { create, created } = makeStrictVerifierFactory();

  const first = obtainRecaptchaVerifier(session, container, create);
  // A failed send discards the verifier (auth.js catch path) but — like the real invisible SDK —
  // the widget DOM stays behind in the container.
  discardRecaptchaVerifier(session);
  assert.equal(first.cleared, true, "discard clears the failed verifier");
  assert.equal(session.verifier, null);
  assert.equal(container.children.length, 1, "the stale widget DOM is still in the container (real clear() behaviour)");

  // The retry must NOT throw despite the dirty container: the core empties it before creating.
  const second = obtainRecaptchaVerifier(session, container, create);
  assert.equal(created.length, 2, "the retry builds a fresh verifier");
  assert.notEqual(second, first);
  assert.equal(container.children.length, 1, "the stale widget was removed — only the fresh one remains");
});

test("container reset falls back to a removeChild loop when replaceChildren is unavailable", () => {
  const session = { verifier: null, container: null };
  const container = makeContainer({ withReplaceChildren: false });
  container.appendChild({ kind: "stale-widget" }); // dirty from a previous life
  const { create, created } = makeStrictVerifierFactory();

  const verifier = obtainRecaptchaVerifier(session, container, create);

  assert.equal(created.length, 1);
  assert.equal(container.children.length, 1, "stale child removed via the fallback, fresh widget in");
  assert.equal(container.children[0], verifier.widget);
});

test("a detached recorded container is not reused — the remounted gate gets a fresh verifier", () => {
  const session = { verifier: null, container: null };
  const container = makeContainer();
  const { create, created } = makeStrictVerifierFactory();

  obtainRecaptchaVerifier(session, container, create);
  // The view unmounted (node left the document) — its widget is dead; a reuse would silently hang.
  container.isConnected = false;
  const second = obtainRecaptchaVerifier(session, container, create);

  assert.equal(created.length, 2, "detached container forces a rebuild");
  assert.equal(session.verifier, second);
});

// ---- source guard: auth.js must actually route BOTH phone flows through the tested core ---------
//
// auth.js can't be imported here (https: Firebase imports), so this pins the wiring textually —
// the same style as the markup/guard tests. If someone reverts to inline clear()+new per send,
// these go red even though the core module above still passes.

test("auth.js routes startPhoneSignIn AND startPhoneVerify through recaptcha-session-core", () => {
  const authSource = readFileSync(new URL("../src/assets/auth.js", import.meta.url), "utf8");

  assert.match(
    authSource,
    /from "\.\/recaptcha-session-core\.js"/,
    "auth.js imports the shared reCAPTCHA session lifecycle module",
  );
  const obtainCalls = authSource.match(/obtainRecaptchaVerifier\(/g) ?? [];
  assert.ok(
    obtainCalls.length >= 2,
    `both phone flows obtain via the core (found ${obtainCalls.length} call sites, need >= 2)`,
  );
  const discardCalls = authSource.match(/discardRecaptchaVerifier\(/g) ?? [];
  assert.ok(
    discardCalls.length >= 2,
    `both phone flows discard on failure via the core (found ${discardCalls.length} call sites, need >= 2)`,
  );
  assert.doesNotMatch(
    authSource,
    /recaptchaVerifier\.clear\(\)/,
    "the old per-send clear()+recreate pattern must not come back (TM-1007)",
  );
});
