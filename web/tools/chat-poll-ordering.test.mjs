// Regression tests for the chat thread-poll stale-response guard (TM-721). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG: pollThread (chat.js) did a wholesale `thread.messages = next` with the fetched server page.
// While that fetch was in flight, an SSE frame (onMessage/onEdited/onDeleted) could deliver a NEWER
// message and mutate thread.messages incrementally. When the older poll response then landed it replaced
// the whole array — clobbering the just-arrived live message until the next tick. Two overlapping poll
// responses could likewise apply out of order.
//
// THE FIX: a monotonic `thread.rev` bumped on every live (SSE) mutation. pollThread snapshots rev BEFORE
// its fetch and DROPS the response if rev changed meanwhile (a live update is newer → its incremental
// state wins), and a `polling` latch stops two poll responses overlapping. chat.js can't be imported
// under `node --test` (it sits on the api.js → Firebase CDN chain), so this reimplements the exact guard
// state machine the fix added and drives the race through it — a behavioural proof of the invariant.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── The guard state machine, mirrored 1:1 from chat.js pollThread + the SSE handlers ─────────────────

/** A tiny thread model with the two fields the guard reads/writes. */
function makeThread(messages = []) {
  return { messages: messages.slice(), rev: 0, polling: false };
}

/** A live (SSE) mutation: apply it AND bump rev, exactly as onMessage/onEdited/onDeleted now do. */
function liveApply(thread, mutate) {
  thread.messages = mutate(thread.messages);
  thread.rev++;
}

/** One poll tick: fetch (via `fetchPage`), then apply ONLY if not overlapping and rev is unchanged. */
async function pollTick(thread, fetchPage) {
  if (thread.polling) return "overlap-skipped";
  const revAtFetch = thread.rev;
  thread.polling = true;
  let page;
  try {
    page = await fetchPage();
  } finally {
    thread.polling = false;
  }
  if (thread.rev !== revAtFetch) return "dropped-stale"; // a live update landed mid-flight → keep it
  thread.messages = page;
  return "applied";
}

// ── The race the bug was about ───────────────────────────────────────────────────────────────────────

test("a poll response is DROPPED when a live SSE message arrives while it's in flight", async () => {
  const thread = makeThread([{ id: "1" }]);
  // The poll fetched an OLD page (just msg 1). Its promise is parked until we release it.
  let releaseFetch;
  const fetchPage = () => new Promise((r) => { releaseFetch = () => r([{ id: "1" }]); });

  const tick = pollTick(thread, fetchPage);
  // Mid-flight, SSE delivers a newer message 2 (bumps rev).
  liveApply(thread, (msgs) => [...msgs, { id: "2" }]);
  releaseFetch();

  assert.equal(await tick, "dropped-stale");
  // The live message survived — the stale poll page did NOT wipe it back to just [1].
  assert.deepEqual(thread.messages.map((m) => m.id), ["1", "2"]);
});

test("a poll response is APPLIED normally when NO live update raced it", async () => {
  const thread = makeThread([{ id: "1" }]);
  const result = await pollTick(thread, async () => [{ id: "1" }, { id: "2" }]);
  assert.equal(result, "applied");
  assert.deepEqual(thread.messages.map((m) => m.id), ["1", "2"]);
});

test("overlapping poll ticks don't both apply — the second is skipped while the first runs", async () => {
  const thread = makeThread([{ id: "1" }]);
  let releaseFirst;
  const slow = () => new Promise((r) => { releaseFirst = () => r([{ id: "1" }, { id: "2" }]); });

  const first = pollTick(thread, slow);
  const second = await pollTick(thread, async () => [{ id: "999" }]); // fires while first is in flight
  assert.equal(second, "overlap-skipped");

  releaseFirst();
  assert.equal(await first, "applied");
  assert.deepEqual(thread.messages.map((m) => m.id), ["1", "2"]);
});

// ── Source guards: the real chat.js keeps the moving parts wired (can't import it here) ───────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SRC = readFileSync(join(HERE, "../src/assets/chat.js"), "utf8");

test("chat.js pollThread snapshots rev before the fetch and drops a stale/overlapping response", () => {
  assert.match(CHAT_SRC, /if\s*\(thread\.polling\)\s*return;/, "overlap guard present");
  assert.match(CHAT_SRC, /const\s+revAtFetch\s*=\s*thread\.rev;/, "rev is snapshotted before the fetch");
  assert.match(CHAT_SRC, /thread\.rev\s*!==\s*revAtFetch/, "the stale-response check compares rev");
});

test("chat.js bumps thread.rev on every live (SSE) mutation so the poll guard can see it", () => {
  // Three live writers (onMessage/onEdited/onDeleted) must each bump rev, else a poll could clobber them.
  const bumps = CHAT_SRC.match(/thread\.rev\+\+/g) || [];
  assert.ok(bumps.length >= 3, `expected each SSE handler to bump thread.rev (found ${bumps.length})`);
});
