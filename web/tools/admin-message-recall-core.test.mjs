// Unit tests (TM-473) for the pure admin-message recall core — the confirm copy, button labels, result
// summary and the reusable control-state model — asserted without a browser (the broadcast.js /
// admin-messages-core.js split). Runs on the PR gate via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECALL_LABEL,
  RECALLED_LABEL,
  recallConfirmCopy,
  summariseRecall,
  recallControlModel,
} from "../src/assets/admin-message-recall-core.js";

// --- labels -----------------------------------------------------------------------------------

test("labels are the live vs recalled action copy", () => {
  assert.equal(RECALL_LABEL, "Recall message");
  assert.equal(RECALLED_LABEL, "Recalled");
  assert.notEqual(RECALL_LABEL, RECALLED_LABEL);
});

// --- confirm copy -----------------------------------------------------------------------------

test("confirm copy describes the HYBRID behaviour and is honest about the best-effort-push limit", () => {
  const copy = recallConfirmCopy();
  // Names the HYBRID split: unseen recipients won't see it, already-seen ones keep it as a tombstone...
  assert.match(copy, /haven't seen it yet/i);
  assert.match(copy, /already saw it/i);
  assert.match(copy, /Recalled by admin/i);
  // ...and is explicit that an already-delivered push can't be un-sent (the documented limit).
  assert.match(copy, /can't be un-sent|tray/i);
  // ...and that recall itself is irreversible (recall + resend, no edit).
  assert.match(copy, /can't undo|recall it and send/i);
});

// --- result summary ---------------------------------------------------------------------------

test("summariseRecall leads with the total reach, pluralised", () => {
  // All unseen (deleted): no tombstone clause.
  assert.equal(summariseRecall({ removed: 42, tombstoned: 0 }), "Message recalled — pulled from 42 recipients");
  assert.equal(summariseRecall({ removed: 1 }), "Message recalled — pulled from 1 recipient");
});

test("summariseRecall names the tombstoned (already-seen) partition when there is one", () => {
  assert.equal(
    summariseRecall({ removed: 12, tombstoned: 30 }),
    "Message recalled — pulled from 42 recipients (30 had seen it, now marked recalled)",
  );
  // A pure-tombstone recall (everyone had already seen it) still reads honestly.
  assert.equal(
    summariseRecall({ removed: 0, tombstoned: 1 }),
    "Message recalled — pulled from 1 recipient (1 had seen it, now marked recalled)",
  );
});

test("summariseRecall treats a zero total as a successful no-op recall, not a failure", () => {
  const zero = "Message recalled — no in-app copies remained to remove";
  assert.equal(summariseRecall({ removed: 0, tombstoned: 0 }), zero);
  assert.equal(summariseRecall({}), zero); // missing/absent counts
  assert.equal(summariseRecall(), zero); // no arg
  assert.equal(summariseRecall({ removed: "not-a-number" }), zero); // coerces safely
});

// --- control-state model (reused by the compose success area AND TM-444's list rows) ----------

test("a live message offers recall", () => {
  const model = recallControlModel({ recalledAt: null });
  assert.equal(model.recalled, false);
  assert.equal(model.canRecall, true);
  assert.equal(model.label, RECALL_LABEL);
  assert.equal(model.note, "");
});

test("a message with a recalledAt timestamp is in the recalled state (no re-recall)", () => {
  const model = recallControlModel({ recalledAt: "2026-07-09T08:20:44.540Z" });
  assert.equal(model.recalled, true);
  assert.equal(model.canRecall, false);
  assert.equal(model.label, RECALLED_LABEL);
  assert.match(model.note, /recalled/i);
});

test("an explicit recalled:true flag also resolves to the recalled state", () => {
  const model = recallControlModel({ recalled: true });
  assert.equal(model.recalled, true);
  assert.equal(model.canRecall, false);
});

test("blank / whitespace recalledAt is treated as still-live", () => {
  assert.equal(recallControlModel({ recalledAt: "" }).canRecall, true);
  assert.equal(recallControlModel({ recalledAt: "   " }).canRecall, true);
  assert.equal(recallControlModel({}).canRecall, true);
  assert.equal(recallControlModel().canRecall, true); // no arg
});

test("a RECALLED status row resolves to the recalled state (sent-history rows carry status, not recalledAt) (TM-734)", () => {
  const model = recallControlModel({ status: "RECALLED" });
  assert.equal(model.recalled, true);
  assert.equal(model.canRecall, false);
  assert.equal(model.label, RECALLED_LABEL);
  assert.match(model.note, /recalled/i);
  // Case-insensitive on the wire token.
  assert.equal(recallControlModel({ status: "recalled" }).recalled, true);
});

test("a live sent-history row (status SENT/EMPTY) still offers recall (TM-734)", () => {
  assert.equal(recallControlModel({ status: "SENT" }).canRecall, true);
  assert.equal(recallControlModel({ status: "EMPTY" }).canRecall, true);
  assert.equal(recallControlModel({ status: "" }).canRecall, true);
});
