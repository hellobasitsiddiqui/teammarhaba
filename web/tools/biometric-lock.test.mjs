// Tests for the app-lock STATE MACHINE (TM-282 / TM-334). Framework-free — Node's built-in test
// runner, same harness as biometric-policy.test.mjs / biometric.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// TM-334 (the bug these guard): presenting the Android system BiometricPrompt backgrounds then
// foregrounds the Activity, so @capacitor/app emits `appStateChange { isActive: true }` on dismissal.
// The old resume handler treated that synthetic resume as a fresh lock trigger, so a SUCCESSFUL
// unlock immediately re-locked and re-prompted → an endless loop that trapped the user. These tests
// drive `createLockController` with a mock authenticate() + a mock @capacitor/app emitting the
// background→foreground pair, and assert the loop is gone — exactly the native-biometric path the web
// e2e can't reach because `isNativeShell()` is false there.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createLockController, UNLOCK_SETTLE_MS } from "../src/assets/biometric-lock.js";

/**
 * Build a controller wired to controllable mocks + a fake clock, plus a tiny `@capacitor/app`-style
 * emitter that drives the controller's resume handler. `authResult` is what the mocked prompt
 * resolves to (default: success). `emitPrompt()` replays the EXACT event order a real BiometricPrompt
 * produces around an authenticate() call: background (isActive:false) → the prompt resolves →
 * foreground (isActive:true).
 */
function makeHarness({ authResult = { ok: true }, usable = true, enabled = true, native = true } = {}) {
  const calls = { authenticate: 0, overlayShow: 0, overlayHide: 0 };
  let clock = 1000;

  const overlay = {
    show() {
      calls.overlayShow += 1;
    },
    hide() {
      calls.overlayHide += 1;
    },
  };

  // The mocked prompt. Resolving it is what "dismisses" the system prompt, which is when the real
  // plugin foregrounds the activity — so the caller emits the foreground right after the resolve.
  let resolvePrompt;
  const authenticate = () => {
    calls.authenticate += 1;
    return new Promise((resolve) => {
      resolvePrompt = () => resolve(authResult);
    });
  };

  const controller = createLockController({
    authenticate,
    isBiometricAvailable: async () => usable,
    isAppLockEnabled: () => enabled,
    isNative: () => native,
    overlay,
    now: () => clock,
  });

  // Replay a full prompt cycle: the prompt backgrounds the activity, then on dismissal foregrounds
  // it. `dismiss` controls whether the prompt actually resolves (success/cancel) before the
  // foreground — a real dismissal always does.
  async function emitPromptCycle() {
    // Prompt shown → activity backgrounds.
    controller.onAppStateChange(false);
    await tick();
    // Prompt dismissed → it resolves...
    if (resolvePrompt) resolvePrompt();
    await tick();
    // ...and the activity foregrounds.
    controller.onAppStateChange(true);
    await tick();
  }

  return {
    controller,
    calls,
    overlay,
    emitPromptCycle,
    resolveNow: () => resolvePrompt && resolvePrompt(),
    advance: (ms) => {
      clock += ms;
    },
    setClock: (t) => {
      clock = t;
    },
    emit: (isActive) => controller.onAppStateChange(isActive),
  };
}

/** Flush the microtask queue so awaited promises in the controller settle. */
function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

test("TM-334: prompt-induced resume does NOT re-lock or re-prompt after a successful unlock", async () => {
  const h = makeHarness({ authResult: { ok: true } });

  // Genuine cold-start lock → prompts once.
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), true, "locked on boot");
  assert.equal(h.calls.authenticate, 1, "prompted once on lock");

  // The prompt cycle: background → resolve(success) → foreground. The foreground here is SYNTHETIC
  // (the prompt dismissing), and must NOT re-lock or re-prompt.
  await h.emitPromptCycle();

  assert.equal(h.controller.isLocked(), false, "successful unlock stays unlocked");
  assert.equal(h.calls.authenticate, 1, "the prompt's own resume did NOT re-prompt (no loop)");
});

test("TM-334: a GENUINE background→foreground (no prompt in flight) DOES lock", async () => {
  const h = makeHarness({ authResult: { ok: true } });

  // Start unlocked (no cold-start lock for this test).
  assert.equal(h.controller.isLocked(), false);

  // User leaves the app and comes back — a real resume, no prompt in flight.
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();

  assert.equal(h.controller.isLocked(), true, "real resume engages the lock");
  assert.equal(h.calls.authenticate, 1, "and prompts once");
});

test("TM-334: success unlocks and stays unlocked across the trailing settle-window resume", async () => {
  const h = makeHarness({ authResult: { ok: true } });
  await h.controller.maybeLock();
  await tick();

  await h.emitPromptCycle();
  assert.equal(h.controller.isLocked(), false, "unlocked");

  // A trailing foreground that arrives immediately after unlock (within the settle window) must be
  // ignored — this is the event that used to slam the lock back on.
  h.emit(true);
  await tick();
  assert.equal(h.controller.isLocked(), false, "trailing resume in settle window did not re-lock");
  assert.equal(h.calls.authenticate, 1, "no extra prompt");
});

test("TM-334: a genuine resume AFTER the settle window still locks again", async () => {
  const h = makeHarness({ authResult: { ok: true } });
  await h.controller.maybeLock();
  await tick();
  await h.emitPromptCycle();
  assert.equal(h.controller.isLocked(), false);

  // Time passes well beyond the settle window, then the user genuinely backgrounds + foregrounds.
  h.advance(UNLOCK_SETTLE_MS + 1);
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();

  assert.equal(h.controller.isLocked(), true, "a real later resume re-locks");
  assert.equal(h.calls.authenticate, 2, "and prompts again");
});

test("TM-334: cancel stays locked but does NOT busy-loop the prompt", async () => {
  const h = makeHarness({ authResult: { ok: false, reason: "dismissed", code: "userCancel" } });
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), true);
  assert.equal(h.calls.authenticate, 1, "prompted once");

  // Cancelling dismisses the prompt the same way: background → resolve(cancel) → foreground.
  await h.emitPromptCycle();

  assert.equal(h.controller.isLocked(), true, "cancel keeps the app locked");
  assert.equal(h.calls.authenticate, 1, "the cancel's own resume did NOT re-prompt (no busy-loop)");

  // Even a genuine later resume must not stack prompts while still locked (lock() is a no-op when
  // already locked) — the user retries via the Unlock button instead.
  h.advance(UNLOCK_SETTLE_MS + 1);
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();
  assert.equal(h.calls.authenticate, 1, "still no auto re-prompt while locked");
});

test("TM-334: fail-open (biometry unavailable) unlocks and does not trap the user", async () => {
  const h = makeHarness({ authResult: { ok: false, reason: "unavailable", code: "biometryNotEnrolled" } });
  await h.controller.maybeLock();
  await tick();

  await h.emitPromptCycle();

  assert.equal(h.controller.isLocked(), false, "unavailable biometry fails OPEN — never trapped");
});

test("maybeLock: outside the native shell it is a no-op (web unaffected)", async () => {
  const h = makeHarness({ native: false });
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), false);
  assert.equal(h.calls.overlayShow, 0, "no overlay mounted in a browser");
  assert.equal(h.calls.authenticate, 0, "no prompt in a browser");
});

test("maybeLock: lock disabled → no lock, no prompt", async () => {
  const h = makeHarness({ enabled: false });
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), false);
  assert.equal(h.calls.authenticate, 0);
});

test("maybeLock: device not lockable (no biometry/credential) → eager cover torn back down", async () => {
  const h = makeHarness({ usable: false });
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), false, "not locked when device can't authenticate");
  assert.ok(h.calls.overlayShow >= 1, "eager cover was mounted");
  assert.ok(h.calls.overlayHide >= 1, "then torn back down (no flash, no trap)");
});

test("eager cover (coverEagerly) shows the overlay before any async work, without prompting", () => {
  const h = makeHarness();
  h.controller.coverEagerly();
  assert.equal(h.calls.overlayShow, 1, "overlay shown synchronously");
  assert.equal(h.calls.authenticate, 0, "but no prompt yet");
});

// ─────────────────────────────────────────────────────────────────────────────
// TM-337: trusted in-app excursions (native camera/gallery) must NOT trip the lock.
// ─────────────────────────────────────────────────────────────────────────────

test("TM-337: an excursion background→foreground does NOT lock or prompt", async () => {
  const h = makeHarness({ authResult: { ok: true } });

  // Start unlocked (as after a successful login). We're about to open the native picker.
  assert.equal(h.controller.isLocked(), false);

  // Launching the picker: mark the excursion, the app backgrounds, then foregrounds on return.
  h.controller.beginTrustedExcursion();
  h.emit(false); // app backgrounds as the picker takes over
  await tick();
  h.emit(true); // picker returned → app foregrounds (this used to slam the lock on)
  await tick();
  h.controller.endTrustedExcursion(); // finally: picker resolved

  assert.equal(h.controller.isLocked(), false, "in-app excursion did NOT engage the lock");
  assert.equal(h.calls.authenticate, 0, "and did NOT prompt for biometrics");
});

test("TM-337: after an excursion ends, a LATER genuine background→foreground DOES lock", async () => {
  const h = makeHarness({ authResult: { ok: true } });
  assert.equal(h.controller.isLocked(), false);

  // Excursion happens and completes.
  h.controller.beginTrustedExcursion();
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();
  h.controller.endTrustedExcursion();
  assert.equal(h.controller.isLocked(), false, "excursion itself did not lock");

  // Time passes beyond the settle window, then the user genuinely leaves and comes back.
  h.advance(UNLOCK_SETTLE_MS + 1);
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();

  assert.equal(h.controller.isLocked(), true, "a real resume after the excursion still locks");
  assert.equal(h.calls.authenticate, 1, "and prompts");
});

test("TM-337: the excursion's trailing foreground (settle window) does not re-lock", async () => {
  const h = makeHarness({ authResult: { ok: true } });
  assert.equal(h.controller.isLocked(), false);

  // The trailing `isActive:true` can arrive a beat AFTER endTrustedExcursion() (the picker resolves,
  // finally runs, THEN the OS delivers the foreground event). It must be swallowed by the settle
  // window opened on end — exactly like the prompt's trailing resume.
  h.controller.beginTrustedExcursion();
  h.emit(false);
  await tick();
  h.controller.endTrustedExcursion(); // picker resolved first...
  h.emit(true); // ...then the late foreground lands (within the settle window)
  await tick();

  assert.equal(h.controller.isLocked(), false, "trailing excursion resume did not re-lock");
  assert.equal(h.calls.authenticate, 0, "no prompt");
});

test("TM-337: nested/overlapping excursions are reference-counted (inner end doesn't unshield)", async () => {
  const h = makeHarness({ authResult: { ok: true } });
  assert.equal(h.controller.isLocked(), false);

  h.controller.beginTrustedExcursion(); // outer
  h.controller.beginTrustedExcursion(); // inner (overlapping)
  h.controller.endTrustedExcursion(); // inner ends — outer still open

  // A resume while the outer excursion is still open must NOT lock.
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();
  assert.equal(h.controller.isLocked(), false, "still shielded while an excursion remains open");

  h.controller.endTrustedExcursion(); // outer ends
  h.advance(UNLOCK_SETTLE_MS + 1);
  h.emit(false);
  await tick();
  h.emit(true);
  await tick();
  assert.equal(h.controller.isLocked(), true, "once all excursions end, a real resume locks again");
});

test("TM-337: endTrustedExcursion without a matching begin never underflows / mis-suppresses", async () => {
  const h = makeHarness({ authResult: { ok: true } });

  // A stray end (defensive) must not push the counter negative and permanently suppress locking.
  h.controller.endTrustedExcursion();
  h.controller.endTrustedExcursion();

  h.emit(false);
  await tick();
  h.emit(true);
  await tick();
  assert.equal(h.controller.isLocked(), true, "stray ends don't disable locking");
});

test("TM-337 + TM-334: an excursion during a biometric prompt doesn't clear the prompt suppression", async () => {
  // Both suppressions can be in flight at once; ending one must not let the other's resume re-lock.
  const h = makeHarness({ authResult: { ok: true } });

  // Cold-start lock → prompt in flight.
  await h.controller.maybeLock();
  await tick();
  assert.equal(h.controller.isLocked(), true, "locked on boot");
  assert.equal(h.calls.authenticate, 1, "prompted once");

  // Overlap a trusted excursion, then end it BEFORE the prompt's paired resume arrives.
  h.controller.beginTrustedExcursion();
  h.controller.endTrustedExcursion();

  // Now replay the prompt's own background→resolve→foreground pair — it must still be suppressed and
  // resolve to a clean unlock (the excursion end must not have consumed the prompt's suppression).
  await h.emitPromptCycle();

  assert.equal(h.controller.isLocked(), false, "prompt unlock still succeeds");
  assert.equal(h.calls.authenticate, 1, "no re-prompt — prompt suppression intact across excursion end");
});

test("TM-334: a stray foreground with no prior prompt background still locks (no false suppression)", async () => {
  // Defends the edge where promptInFlight bookkeeping could wrongly swallow a real resume. After a
  // clean unlock + settle, a fresh genuine resume must lock.
  const h = makeHarness({ authResult: { ok: true } });
  await h.controller.maybeLock();
  await tick();
  await h.emitPromptCycle();
  h.advance(UNLOCK_SETTLE_MS + 1);

  // No background event precedes this foreground (e.g. a flaky WebView visibilitychange) — it must
  // still be treated as a real resume and lock.
  h.emit(true);
  await tick();
  assert.equal(h.controller.isLocked(), true, "stray real foreground locks");
});
