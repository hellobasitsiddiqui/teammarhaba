// Unit tests for the site-wide alert-banner core (TM-243) — the pure dismissal/visibility logic behind
// alerts.js. Framework-free: Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`. No DOM/fetch — alerts-core.js is browser-free by construction.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  Dismissal,
  Level,
  contentHash,
  ackKey,
  sessionKey,
  levelClass,
  ariaRole,
  showsDismissControl,
  dismissControl,
  isDismissed,
  visibleAlerts,
  alertsSignature,
  recordDismissal,
  adoptActiveResult,
} from "../src/assets/alerts-core.js";

/** A minimal in-memory Storage (getItem/setItem) — a fresh instance models a fresh browser session. */
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function stores(ack = fakeStore(), session = fakeStore()) {
  return { ackStore: ack, sessionStore: session };
}

const warnAck = { id: 1, level: Level.WARNING, dismissal: Dismissal.ACKNOWLEDGE, message: "Events cancelled due to heat" };
const infoDismiss = { id: 2, level: Level.INFO, dismissal: Dismissal.DISMISS, message: "Scheduled maintenance tonight" };
const critPersistent = { id: 3, level: Level.CRITICAL, dismissal: Dismissal.PERSISTENT, message: "Service degraded" };

// --- Visibility with nothing dismissed ----------------------------------------------------------

test("all active alerts are visible when nothing has been dismissed", () => {
  const alerts = [warnAck, infoDismiss, critPersistent];
  assert.deepEqual(visibleAlerts(alerts, stores()), alerts);
});

test("visibleAlerts tolerates a non-array / empty input", () => {
  assert.deepEqual(visibleAlerts(null, stores()), []);
  assert.deepEqual(visibleAlerts([], stores()), []);
});

// --- ACKNOWLEDGE: sticky, persists across sessions ----------------------------------------------

test("acknowledging a sticky alert hides it and keeps it hidden across a new session", () => {
  const ack = fakeStore();
  const s1 = stores(ack, fakeStore());

  assert.equal(isDismissed(warnAck, s1), false);
  recordDismissal(warnAck, s1);

  // Written to localStorage (the ack store), not sessionStorage.
  assert.equal(ack.getItem(ackKey(warnAck)), "1");
  assert.equal(isDismissed(warnAck, s1), true);
  assert.deepEqual(visibleAlerts([warnAck], s1), []);

  // A brand-new SESSION (fresh sessionStore) but the SAME localStorage — still dismissed (sticky).
  const s2 = stores(ack, fakeStore());
  assert.equal(isDismissed(warnAck, s2), true);
  assert.deepEqual(visibleAlerts([warnAck], s2), []);
});

// --- DISMISS: session-only, returns next session ------------------------------------------------

test("dismissing a session alert hides it this session but it returns next session", () => {
  const ack = fakeStore();
  const session = fakeStore();
  const s1 = stores(ack, session);

  recordDismissal(infoDismiss, s1);

  // Written to sessionStorage, NOT localStorage.
  assert.equal(session.getItem(sessionKey(infoDismiss)), "1");
  assert.equal(ack.getItem(sessionKey(infoDismiss)), null);
  assert.deepEqual(visibleAlerts([infoDismiss], s1), []);

  // A NEW session (fresh sessionStore) — the alert reappears (only ack is durable).
  const s2 = stores(ack, fakeStore());
  assert.equal(isDismissed(infoDismiss, s2), false);
  assert.deepEqual(visibleAlerts([infoDismiss], s2), [infoDismiss]);
});

// --- PERSISTENT: no dismiss control, never hidden by dismissal -----------------------------------

test("a PERSISTENT alert has no dismiss control and can never be dismissed away", () => {
  const s = stores();
  assert.equal(showsDismissControl(critPersistent.dismissal), false);
  assert.equal(dismissControl(critPersistent.dismissal), null);

  recordDismissal(critPersistent, s); // no-op — nothing to record
  assert.equal(isDismissed(critPersistent, s), false);
  assert.deepEqual(visibleAlerts([critPersistent], s), [critPersistent]);
});

// --- Content hash: an EDITED alert re-shows even after acknowledgement ---------------------------

test("editing an acknowledged alert (same id, new content) re-shows it", () => {
  const ack = fakeStore();
  const s = stores(ack, fakeStore());

  recordDismissal(warnAck, s);
  assert.deepEqual(visibleAlerts([warnAck], s), []);

  // Same id, edited message → different content hash → different ack key → shows again.
  const edited = { ...warnAck, message: "Events cancelled due to heat — extended to Friday" };
  assert.notEqual(ackKey(edited), ackKey(warnAck));
  assert.equal(isDismissed(edited, s), false);
  assert.deepEqual(visibleAlerts([edited], s), [edited]);
});

test("contentHash is stable and order-insensitive for identical content", () => {
  assert.equal(contentHash(warnAck), contentHash({ ...warnAck }));
  assert.notEqual(contentHash(warnAck), contentHash({ ...warnAck, level: Level.CRITICAL }));
});

// --- Render fingerprint: skip the rebuild (and re-announce) when the set is unchanged (TM-572) ---

test("alertsSignature is identical for an unchanged set (even as fresh objects) → render is skipped", () => {
  const first = [critPersistent, warnAck];
  // A second poll returning the SAME content as brand-new objects (reference-different) — the diff must
  // be by id + content, not identity, so the live-region banners are NOT re-inserted / re-announced.
  const second = [{ ...critPersistent }, { ...warnAck }];
  assert.equal(alertsSignature(first), alertsSignature(second));
});

test("editing an alert (same id, new message) changes the signature → it repaints and re-announces", () => {
  const before = [critPersistent];
  const after = [{ ...critPersistent, message: "Service degraded — now fully down" }];
  assert.notEqual(alertsSignature(before), alertsSignature(after));
});

test("adding, removing or reordering an alert changes the signature", () => {
  const base = [critPersistent, warnAck];
  assert.notEqual(alertsSignature(base), alertsSignature([critPersistent]), "removal changes it");
  assert.notEqual(alertsSignature(base), alertsSignature([critPersistent, warnAck, infoDismiss]), "addition changes it");
  assert.notEqual(alertsSignature(base), alertsSignature([warnAck, critPersistent]), "reorder changes it");
});

test("alertsSignature keys by id AND content — distinct alerts never collide into one signature", () => {
  // Same content, different id → different signature (id is part of the key).
  assert.notEqual(alertsSignature([warnAck]), alertsSignature([{ ...warnAck, id: 99 }]));
  // Empty / non-array → empty signature (host paints nothing, stays hidden).
  assert.equal(alertsSignature([]), "");
  assert.equal(alertsSignature(null), "");
});

// --- Level → colour class + a11y role mapping ---------------------------------------------------

test("levelClass maps each level to its Paper modifier class (unknown → info)", () => {
  assert.equal(levelClass(Level.INFO), "tm-alert--info");
  assert.equal(levelClass(Level.WARNING), "tm-alert--warning");
  assert.equal(levelClass(Level.CRITICAL), "tm-alert--critical");
  assert.equal(levelClass("SOMETHING_ELSE"), "tm-alert--info");
});

test("ariaRole announces CRITICAL assertively (alert) and the rest politely (status)", () => {
  assert.equal(ariaRole(Level.CRITICAL), "alert");
  assert.equal(ariaRole(Level.WARNING), "status");
  assert.equal(ariaRole(Level.INFO), "status");
});

test("dismissControl gives OK for acknowledge, × for dismiss, null for persistent", () => {
  assert.equal(dismissControl(Dismissal.ACKNOWLEDGE).text, "OK");
  assert.equal(dismissControl(Dismissal.DISMISS).text, "×");
  assert.equal(dismissControl(Dismissal.DISMISS).ariaLabel, "Dismiss");
  assert.equal(dismissControl(Dismissal.PERSISTENT), null);
});

// --- Contract guards: JS enums + CSS tokens stay in step ----------------------------------------

test("the JS enums mirror the backend AlertLevel / AlertDismissal names", () => {
  assert.deepEqual(Object.values(Level), ["INFO", "WARNING", "CRITICAL"]);
  assert.deepEqual(Object.values(Dismissal), ["ACKNOWLEDGE", "DISMISS", "PERSISTENT"]);
});

test("styles.css defines the level modifier classes + accent tokens the core references", () => {
  // Guards against alerts-core.js's level classes drifting from the stylesheet that colours them.
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, "..", "src", "assets", "styles.css"), "utf8");
  for (const cls of ["tm-alert--info", "tm-alert--warning", "tm-alert--critical"]) {
    assert.ok(css.includes(`.${cls}`), `styles.css must style .${cls}`);
  }
  for (const token of ["--alert-info", "--alert-warning", "--alert-critical"]) {
    assert.ok(css.includes(`${token}:`), `styles.css must define ${token}`);
  }
});

// --- adoptActiveResult: a failed poll must NOT wipe live banners (TM-734) -----------------------

test("adoptActiveResult adopts a real fetched set (including a genuinely-empty one)", () => {
  const set = [{ id: 1, message: "Heatwave", level: "CRITICAL", dismissal: "PERSISTENT" }];
  assert.deepEqual(adoptActiveResult(set), { adopt: true, alerts: set });
  // An operator who pulled every notice → a real empty success → adopt it (banners clear legitimately).
  assert.deepEqual(adoptActiveResult([]), { adopt: true, alerts: [] });
});

test("adoptActiveResult IGNORES a failed fetch (null) so the last banners stand (TM-734)", () => {
  // getActiveAlerts() now returns null on a network/HTTP failure — must NOT be adopted as "no alerts",
  // otherwise a transient blip would wipe a PERSISTENT CRITICAL operator notice.
  const r = adoptActiveResult(null);
  assert.equal(r.adopt, false);
  // Defensive: any non-array (undefined, a stray object) is treated as failure, never as an empty set.
  assert.equal(adoptActiveResult(undefined).adopt, false);
  assert.equal(adoptActiveResult({}).adopt, false);
});
