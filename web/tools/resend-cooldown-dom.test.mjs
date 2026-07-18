// Fake-DOM harness for the resend cooldown's DOM half (TM-866, committed per review) — drives
// resend-cooldown.js's REAL controller under `node --test` with a ~5-line fake <button>, so the
// behaviours that live only in the DOM layer (hold + relabel, the 1s interval lifecycle, the
// announce-exactly-once contracts, syncDisabled's "only ever disables" invariant, the busy-window
// enable deferral, the reserved min-width) are on the PR gate, not just the dispatched e2e run.
// Importable in Node because resend-cooldown.js depends solely on resend-cooldown-core.js — same
// shape as otp-input-dom.test.mjs, the precedent this file mirrors. Time (Date.now + setInterval)
// is driven with node:test's mock timers, so no test sleeps for real.

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachResendCooldown } from "../src/assets/resend-cooldown.js";

/** Enable mocked Date + setInterval for one test (auto-restored when the test ends). */
function useClock(t) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
}

/**
 * A fake resend button: exactly the surface the controller touches — textContent, disabled,
 * offsetWidth (read once by the width reservation) and a style bag for minWidth.
 */
function makeButton(label = "Resend") {
  return { textContent: label, disabled: false, offsetWidth: 120, style: {} };
}

/** Wire a controller around a fresh fake button, collecting announcements. */
function makeController(t, { isBusy } = {}) {
  useClock(t);
  const button = makeButton();
  const announced = [];
  const c = attachResendCooldown({
    button,
    announce: (m) => announced.push(m),
    isBusy,
    codeNoun: "email code",
  });
  return { button, announced, c };
}

test("attach on a missing button returns null (optional-chain contract)", () => {
  assert.equal(attachResendCooldown({ button: null }), null);
});

test("start(): held + full-window label + reserved width + exactly one start announcement", (t) => {
  const { button, announced, c } = makeController(t);

  c.start();
  assert.equal(button.disabled, true, "held from the very start");
  assert.equal(button.textContent, "Resend in 0:30", "full window painted immediately, not at tick 1");
  assert.equal(button.style.minWidth, "120px", "row geometry frozen for the whole window");
  assert.deepEqual(announced, ["You can request a new email code in 30 seconds."]);

  // A second start mid-window is a no-op (core's no-double-start): no re-announce, same window.
  c.start();
  assert.deepEqual(announced.length, 1, "no second announcement for a mid-window start");
});

test("the interval ticks the label down from the clock", (t) => {
  const { button, c } = makeController(t);
  c.start();
  t.mock.timers.tick(1000);
  assert.equal(button.textContent, "Resend in 0:29");
  t.mock.timers.tick(9000);
  assert.equal(button.textContent, "Resend in 0:20");
});

test("syncDisabled re-asserts the hold after a busy sweep, and only ever DISABLES", (t) => {
  const { button, c } = makeController(t);
  c.start();

  // setBusy(false)'s sweep just wrote disabled=false on every control — the cooldown re-claims.
  button.disabled = false;
  c.syncDisabled();
  assert.equal(button.disabled, true, "an active cooldown re-asserts disabled after the sweep");

  // The other direction is the load-bearing invariant: with the window OVER, syncDisabled must
  // NOT enable — during a setBusy(true) window it runs right after the sweep disabled everything,
  // and enabling there would reopen the double-fire door the sweep exists to close.
  t.mock.timers.tick(31_000); // expire (also restores the button)
  button.disabled = true; // ...as under setBusy(true)'s blanket disable
  c.syncDisabled();
  assert.equal(button.disabled, true, "syncDisabled never enables — that is the expiry tick's job");
});

test("expiry restores label + enabled + width and announces exactly once, even with late ticks", (t) => {
  const { button, announced, c } = makeController(t);
  c.start();

  t.mock.timers.tick(31_000); // one LATE fire past the deadline — the deadline-based core's case
  assert.equal(button.disabled, false, "re-enabled at expiry");
  assert.equal(button.textContent, "Resend", "original label restored");
  assert.equal(button.style.minWidth, "", "reserved width released");
  assert.deepEqual(announced.at(-1), "You can request a new email code now.");
  assert.equal(announced.length, 2, "one start + one expiry announcement, nothing else");

  t.mock.timers.tick(5000);
  assert.equal(announced.length, 2, "no announcements after the window is over");
});

test("reset() mid-window restores silently and stops the interval (no leaked repaints)", (t) => {
  const { button, announced, c } = makeController(t);
  c.start();
  t.mock.timers.tick(2000);

  c.reset();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Resend");
  assert.equal(button.style.minWidth, "");
  assert.equal(announced.length, 1, "a mere navigation reset never announces");

  // A leaked interval would call restore() again and clobber this sentinel back to "Resend".
  button.textContent = "SENTINEL";
  t.mock.timers.tick(2000);
  assert.equal(button.textContent, "SENTINEL", "no label writes after reset — interval cleared");
});

test("an expiry DURING a busy window defers the enable to the busy sweep (never fights setBusy)", (t) => {
  // The TM-866 review finding: the user auto-submits the OTP at ~29s; the verify is still on the
  // wire (setBusy(true) has EVERY control disabled, aria-busy on the form) when the 30s deadline
  // crosses. The expiry tick must not hand back one clickable button inside a greyed-out form —
  // a click there would pass isActive() only to be silently swallowed by the single-flight run().
  let busy = false;
  const { button, announced, c } = makeController(t, { isBusy: () => busy });
  c.start();
  t.mock.timers.tick(29_000);

  busy = true; // run(verify…) in flight: setBusy(true) swept every control disabled
  button.disabled = true; // …this button included
  t.mock.timers.tick(2000); // the deadline crosses mid-flight

  assert.equal(button.disabled, true, "the enable is DEFERRED while the form is busy");
  assert.equal(button.textContent, "Resend", "the label restore itself is immediate");
  assert.equal(announced.at(-1), "You can request a new email code now.", "expiry still announced once");

  // The busy window closes: setBusy(false)'s sweep enables everything, then consults syncDisabled,
  // which leaves the button alone because the cooldown is over — the deferred enable lands here.
  busy = false;
  button.disabled = false; // the sweep
  c.syncDisabled();
  assert.equal(button.disabled, false, "enabled once the busy window closes");
});

test("a reset() DURING a busy window also defers the enable (sign-out while an action is in flight)", (t) => {
  let busy = false;
  const { button, c } = makeController(t, { isBusy: () => busy });
  c.start();

  busy = true;
  button.disabled = true; // setBusy(true)'s sweep
  c.reset(); // e.g. onAuthChanged firing while run(signOut) is still busy

  assert.equal(button.disabled, true, "reset mid-busy leaves the button to the sweep");
  assert.equal(button.textContent, "Resend");

  busy = false;
  button.disabled = false; // setBusy(false)'s sweep
  c.syncDisabled();
  assert.equal(button.disabled, false);
});
