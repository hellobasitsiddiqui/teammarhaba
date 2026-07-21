// Unit tests for the group-chat sender-identity + friendly-read-by pure core (TM-828 / TM-829).
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`
// (ci.yml web-build job). No DOM/Firebase, so it runs in plain Node exactly like chat-core.test.mjs.
//
// FAIL-BEFORE / PASS-AFTER: against origin/main chat-core.js exports neither `startsSenderRun` nor
// `readByLabel`, and `toThreadMessage` carries no `senderName` — so importing them throws (SyntaxError:
// does not provide an export) and every test in this file fails. After the TM-828/TM-829 change they exist
// and these pass. That's the reproduced gap the tickets close.

import assert from "node:assert/strict";
import { test } from "node:test";

import { startsSenderRun, readByLabel, toThreadMessage } from "../src/assets/chat-core.js";

/* ─────────────────────────────── TM-828: sender-run grouping predicate ───────────────────────────── */

test("startsSenderRun: an incoming message with no previous line starts a run", () => {
  const msg = { mine: false, senderId: 7, senderName: "Katalin" };
  assert.equal(startsSenderRun(msg, null), true);
  assert.equal(startsSenderRun(msg, undefined), true);
});

test("startsSenderRun: a run continuation (same sender, back-to-back) does NOT restart", () => {
  const a = { mine: false, senderId: 7, senderName: "Katalin" };
  const b = { mine: false, senderId: 7, senderName: "Katalin" };
  // b immediately follows a from the same author → no new header on b.
  assert.equal(startsSenderRun(b, a), false);
});

test("startsSenderRun: a different sender starts a new run", () => {
  const prev = { mine: false, senderId: 7, senderName: "Katalin" };
  const cur = { mine: false, senderId: 9, senderName: "Nitin" };
  assert.equal(startsSenderRun(cur, prev), true);
});

test("startsSenderRun: an own (out-going) message never gets an identity header", () => {
  const prev = { mine: false, senderId: 7, senderName: "Katalin" };
  assert.equal(startsSenderRun({ mine: true, senderId: 1, senderName: "Me" }, prev), false);
});

test("startsSenderRun: a system / announcement message never gets an identity header", () => {
  const prev = { mine: false, senderId: 7, senderName: "Katalin" };
  assert.equal(startsSenderRun({ system: true }, prev), false);
  assert.equal(startsSenderRun({ announcement: true, senderId: 3, senderName: "Admin" }, prev), false);
});

test("startsSenderRun: an incoming line after an OWN message starts a run", () => {
  const own = { mine: true, senderId: 1, senderName: "Me" };
  const incoming = { mine: false, senderId: 7, senderName: "Katalin" };
  assert.equal(startsSenderRun(incoming, own), true);
});

test("startsSenderRun: an incoming line after a SYSTEM notice starts a run", () => {
  const sys = { system: true };
  const incoming = { mine: false, senderId: 7, senderName: "Katalin" };
  assert.equal(startsSenderRun(incoming, sys), true);
});

test("startsSenderRun: falls back to name when ids are absent", () => {
  const prev = { mine: false, senderName: "Katalin" };
  const same = { mine: false, senderName: "Katalin" };
  const other = { mine: false, senderName: "Nitin" };
  assert.equal(startsSenderRun(same, prev), false);
  assert.equal(startsSenderRun(other, prev), true);
});

test("startsSenderRun: id match wins over a differing name", () => {
  // Same account (id 7) even if a name changed mid-thread → still one run.
  const prev = { mine: false, senderId: 7, senderName: "Katalin" };
  const cur = { mine: false, senderId: 7, senderName: "Katalin K." };
  assert.equal(startsSenderRun(cur, prev), false);
});

/* ─────────────────────────────── TM-829: friendly read-by bucket label ───────────────────────────── */

test("readByLabel: zero readers → 'Sent' (TM-940 — industry-standard receipt, was 'Read by none')", () => {
  assert.equal(readByLabel(0, 5), "Sent");
  assert.equal(readByLabel(0, 0), "Sent");
});

test("readByLabel: all other members read → 'Read by everyone'", () => {
  assert.equal(readByLabel(5, 5), "Read by everyone");
  assert.equal(readByLabel(4, 4), "Read by everyone");
});

test("readByLabel: some-but-not-all in a LARGE group → 'Read by few'", () => {
  assert.equal(readByLabel(2, 10), "Read by few");
  assert.equal(readByLabel(1, 8), "Read by few");
});

test("readByLabel: some-but-not-all in a SMALL group → exact 'Read by N'", () => {
  // 2–3 others: a specific count reads better than the vague 'few'.
  assert.equal(readByLabel(1, 2), "Read by 1");
  assert.equal(readByLabel(2, 3), "Read by 2");
});

test("readByLabel: unknown denominator → exact 'Read by N' (can't claim everyone)", () => {
  assert.equal(readByLabel(3), "Read by 3");
  assert.equal(readByLabel(3, 0), "Read by 3");
  assert.equal(readByLabel(3, -1), "Read by 3");
});

test("readByLabel: a stale roster can't push the read count past 'everyone'", () => {
  // readerCount exceeding the known denominator is clamped, so it reads as everyone, not a bogus 'few'.
  assert.equal(readByLabel(9, 5), "Read by everyone");
});

test("readByLabel: coerces junk to a non-negative integer", () => {
  assert.equal(readByLabel("2", "10"), "Read by few");
  assert.equal(readByLabel(-4, 5), "Sent"); // TM-940: clamped to 0 readers → "Sent"
  assert.equal(readByLabel(1.9, 3), "Read by 1"); // 1.9 truncates to 1; small group (3 others) → exact
});

/* ─────────────────────────────── TM-828: toThreadMessage threads sender identity ─────────────────── */

test("toThreadMessage carries senderName + senderPhotoUrl through", () => {
  const vm = toThreadMessage({ id: 1, senderId: 7, senderName: "Katalin", body: "hi" });
  assert.equal(vm.senderName, "Katalin");
  assert.equal(vm.senderPhotoUrl, null); // no server-side photo store today
});

test("toThreadMessage: a null sender name normalises to an empty string", () => {
  const vm = toThreadMessage({ id: 2, senderId: null, senderName: null, system: true, body: "notice" });
  assert.equal(vm.senderName, "");
  assert.equal(vm.senderPhotoUrl, null);
});

test("toThreadMessage: a server photo URL is carried when present", () => {
  const vm = toThreadMessage({ id: 3, senderId: 9, senderName: "Nitin", senderPhotoUrl: "https://x/y.jpg" });
  assert.equal(vm.senderPhotoUrl, "https://x/y.jpg");
});
