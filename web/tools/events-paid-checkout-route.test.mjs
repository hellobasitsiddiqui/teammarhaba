// Regression tests for the paid-per-event checkout routing guard (TM-624/TM-625), the CRITICAL
// money-safety branch: a PAY event whose checkout module is missing must NEVER be silently free-joined.
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE INVARIANT (characterization of already-shipped behaviour, TM-738 P0 [events]):
//   `routePaidCheckout(detail)` in events.js resolves the AUTHORITATIVE per-event entitlement and, for a
//   PAY decision, hands off to the membership-checkout screen (`window.tmMembershipCheckout.open`) instead
//   of the direct free RSVP. The one case it must NOT silently free-join is a confirmed PAY whose checkout
//   seam is absent (`window.tmMembershipCheckout` missing, or `.open` is not a function): that would let a
//   paid/premium event through for free. So it surfaces an error toast and returns TRUE — and a `true`
//   return makes runCommand `return` before ever issuing the direct RSVP. The join is aborted, not freed.
//
// WHY MIRROR + SOURCE-GUARD: events.js can't be imported under `node --test` (api.js → auth.js → the
// Firebase gstatic CDN import chain never resolves off-browser), exactly like events-command-guard.test.mjs.
// So we reimplement routePaidCheckout 1:1 — reusing the REAL pure decision helper `requiresPaidCheckout`
// from events-core.js (which IS loadable) and injecting the three side-effecting seams (entitlement lookup,
// toast, the window.tmMembershipCheckout module) — drive every branch through it, then pin the wiring with
// a source guard so the mirror can't drift from the shipped source.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { requiresPaidCheckout } from "../src/assets/events-core.js";

// ── routePaidCheckout, mirrored 1:1 from events.js ────────────────────────────────────────────────────
//
// The three seams events.js closes over are passed in explicitly:
//   getEntitlement — the GET /events/{id}/entitlement lookup (may reject)
//   checkoutModule — what `window.tmMembershipCheckout` resolves to (undefined = module absent)
//   toast          — the error-surface seam (records the calls the real toast() would make)
// Everything else (the PAY decision via the real requiresPaidCheckout, the missing-module fail-safe,
// the return-value contract) is copied verbatim so the branch behaviour under test is the shipped one.

function makeRoutePaidCheckout({ getEntitlement, checkoutModule, toast }) {
  return async function routePaidCheckout(detail) {
    let entitlement;
    try {
      entitlement = await getEntitlement(detail.id);
    } catch {
      // Couldn't price the event — fall back to the normal RSVP path; the backend is the real gate.
      return false;
    }
    if (!requiresPaidCheckout(entitlement)) return false; // FREE / INCLUDED / UPGRADE → normal RSVP

    // PAY: this event costs the caller money — route through the checkout screen rather than free-RSVPing.
    const checkout = checkoutModule;
    if (!checkout || typeof checkout.open !== "function") {
      // The checkout module isn't available — do NOT quietly join a paid event for free. Surface it and
      // abort the join (returning true skips the direct RSVP).
      toast("Checkout isn't available right now. Please try again.", { type: "error" });
      return true;
    }
    await checkout.open(detail);
    return true;
  };
}

const PAY = { decision: "PAY", amountPence: 1500 };
const FREE = { decision: "FREE", amountPence: 0 };
const INCLUDED = { decision: "INCLUDED", amountPence: 0 };
const DETAIL = { id: 42, heading: "Rooftop social" };

function recordingToast() {
  const calls = [];
  const toast = (message, opts) => calls.push({ message, opts });
  return { toast, calls };
}

// ── The money-safety branch: PAY + no checkout module → error, aborts, NEVER free-joins ───────────────

test("PAY event with the checkout module ABSENT surfaces an error and aborts (returns true, no free join)", async () => {
  const { toast, calls } = recordingToast();
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => PAY,
    checkoutModule: undefined, // window.tmMembershipCheckout never mounted
    toast,
  });

  const handled = await route(DETAIL);

  assert.equal(handled, true, "returns true so runCommand skips the direct RSVP — the paid join is aborted, not freed");
  assert.equal(calls.length, 1, "the user is told checkout is unavailable");
  assert.equal(calls[0].opts.type, "error", "surfaced as an error, not a silent success");
});

test("PAY event where tmMembershipCheckout exists but .open is NOT a function also aborts (returns true)", async () => {
  const { toast, calls } = recordingToast();
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => PAY,
    checkoutModule: { open: "not-a-function" }, // malformed module — still must not free-join
    toast,
  });

  const handled = await route(DETAIL);

  assert.equal(handled, true, "a malformed checkout module is treated exactly like an absent one");
  assert.equal(calls.length, 1, "the same error is surfaced");
  assert.equal(calls[0].opts.type, "error");
});

// ── The healthy PAY path still hands off to checkout (never free-joins, no error toast) ────────────────

test("PAY event with a working checkout module hands off to checkout.open and does NOT error-toast", async () => {
  const { toast, calls } = recordingToast();
  const opened = [];
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => PAY,
    checkoutModule: { open: async (d) => opened.push(d) },
    toast,
  });

  const handled = await route(DETAIL);

  assert.equal(handled, true, "checkout took over — the direct RSVP is skipped");
  assert.deepEqual(opened, [DETAIL], "the checkout screen was opened for this event");
  assert.equal(calls.length, 0, "a healthy hand-off surfaces no error");
});

// ── FREE / INCLUDED fall through to the direct RSVP (false), even with no checkout module ──────────────

test("FREE event falls through to the direct RSVP (returns false) regardless of the checkout module", async () => {
  const { toast, calls } = recordingToast();
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => FREE,
    checkoutModule: undefined,
    toast,
  });

  assert.equal(await route(DETAIL), false, "FREE is not a paid charge — the normal RSVP proceeds");
  assert.equal(calls.length, 0, "no checkout, no error — nothing to surface for a free event");
});

test("INCLUDED event falls through to the direct RSVP (returns false)", async () => {
  const { toast } = recordingToast();
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => INCLUDED,
    checkoutModule: undefined,
    toast,
  });

  assert.equal(await route(DETAIL), false, "INCLUDED (the tier covers it) uses the normal RSVP");
});

// ── A failed entitlement lookup degrades to the direct RSVP (backend is the real gate) ─────────────────

test("a failed entitlement lookup falls through to the direct RSVP (returns false) — the backend re-gates", async () => {
  const { toast, calls } = recordingToast();
  const route = makeRoutePaidCheckout({
    getEntitlement: async () => {
      throw new Error("network down");
    },
    checkoutModule: undefined,
    toast,
  });

  assert.equal(await route(DETAIL), false, "an un-priced event degrades to the direct RSVP; the backend 402 is the real gate");
  assert.equal(calls.length, 0, "no error is surfaced to the user on a best-effort price lookup");
});

// ── Source guard: events.js keeps the missing-module fail-safe wired (no silent free join) ─────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_SRC = readFileSync(join(HERE, "../src/assets/events.js"), "utf8");

test("events.js routePaidCheckout keeps the missing-checkout-module fail-safe (error + return true, never free-join)", () => {
  // The PAY branch reads the checkout module off the window.
  assert.match(EVENTS_SRC, /window\.tmMembershipCheckout/, "the checkout module is read from the window seam");
  // The guard: absent module OR non-function .open must be caught.
  assert.match(
    EVENTS_SRC,
    /if\s*\(!checkout\s*\|\|\s*typeof\s+checkout\.open\s*!==\s*"function"\)/,
    "the missing / malformed checkout module is guarded",
  );
  // On that branch it surfaces an error toast …
  assert.match(EVENTS_SRC, /toast\([^)]*type:\s*"error"[^)]*\)/, "an error toast is surfaced when checkout is unavailable");
  // … and returns true (skipping the direct RSVP), so a paid event is NEVER quietly free-joined.
  const guardBody = EVENTS_SRC.slice(
    EVENTS_SRC.indexOf('typeof checkout.open !== "function"'),
    EVENTS_SRC.indexOf("await checkout.open"),
  );
  assert.match(guardBody, /return\s+true;/, "the fail-safe returns true so the direct RSVP is skipped — no free join");
});

test("events.js only routes to paid checkout when requiresPaidCheckout says so (FREE/INCLUDED fall through)", () => {
  assert.match(
    EVENTS_SRC,
    /if\s*\(!core\.requiresPaidCheckout\(entitlement\)\)\s*return\s+false;/,
    "a non-PAY entitlement falls through to the direct RSVP",
  );
});
