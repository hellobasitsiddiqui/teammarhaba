// Unit tests (TM-373) for the pure notification (push-broadcast) sent-history row model — the title /
// body / reach / outcome formatting the History tab paints, asserted without a browser. Runs on the PR
// gate via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  broadcastTitle,
  broadcastBody,
  reachSummary,
  outcomeCounts,
  formatRecipientCount,
} from "../src/assets/notification-history-core.js";

// A representative broadcast history row each test tweaks — mirrors BroadcastHistoryResponse.
const row = (over = {}) => ({
  id: 7,
  sentAt: "2026-07-01T10:00:00Z",
  title: "Doors open at 7",
  body: "See you at the venue!",
  route: "#/events",
  recipientCount: 12,
  delivered: 10,
  skipped: 2,
  ...over,
});

// ---- title -----------------------------------------------------------------------------------

test("broadcastTitle returns the trimmed title, or (untitled) for a blank/absent title", () => {
  assert.equal(broadcastTitle(row({ title: "  Hello  " })), "Hello");
  assert.equal(broadcastTitle(row({ title: "" })), "(untitled)");
  assert.equal(broadcastTitle(row({ title: null })), "(untitled)");
  assert.equal(broadcastTitle({}), "(untitled)");
});

// ---- body ------------------------------------------------------------------------------------

test("broadcastBody returns the body verbatim (whitespace preserved), '' when absent", () => {
  assert.equal(broadcastBody(row({ body: "line 1\n  line 2" })), "line 1\n  line 2");
  assert.equal(broadcastBody(row({ body: "" })), "");
  assert.equal(broadcastBody(row({ body: null })), "");
  assert.equal(broadcastBody({}), "");
});

// ---- reach summary ---------------------------------------------------------------------------

test("reachSummary shows recipients + delivered", () => {
  assert.equal(reachSummary(row({ recipientCount: 12, delivered: 10 })), "12 recipients · 10 delivered");
  assert.equal(reachSummary(row({ recipientCount: 1, delivered: 1 })), "1 recipient · 1 delivered");
  assert.equal(reachSummary(row({ recipientCount: 5, delivered: 0 })), "5 recipients · 0 delivered");
});

test("reachSummary omits delivered when it isn't a usable number", () => {
  assert.equal(reachSummary({ recipientCount: 3 }), "3 recipients");
  assert.equal(reachSummary({ recipientCount: 3, delivered: null }), "3 recipients");
  assert.equal(reachSummary({ recipientCount: 3, delivered: "x" }), "3 recipients");
});

// ---- outcome counts --------------------------------------------------------------------------

test("outcomeCounts floors each counter to a non-negative integer", () => {
  assert.deepEqual(outcomeCounts(row({ recipientCount: 12, delivered: 10, skipped: 2 })), {
    recipients: 12,
    delivered: 10,
    skipped: 2,
  });
  assert.deepEqual(outcomeCounts({ recipientCount: -5, delivered: 2.9, skipped: undefined }), {
    recipients: 0,
    delivered: 2,
    skipped: 0,
  });
  assert.deepEqual(outcomeCounts({}), { recipients: 0, delivered: 0, skipped: 0 });
});

// ---- shared re-export ------------------------------------------------------------------------

test("formatRecipientCount is re-exported from the shared core and pluralises", () => {
  assert.equal(formatRecipientCount(0), "0 recipients");
  assert.equal(formatRecipientCount(1), "1 recipient");
  assert.equal(formatRecipientCount(9), "9 recipients");
});
