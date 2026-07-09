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

test("confirm copy is honest about the best-effort-push limit", () => {
  const copy = recallConfirmCopy();
  // Names the two in-app surfaces it DOES clear...
  assert.match(copy, /in-app inbox/i);
  assert.match(copy, /notification bell/i);
  // ...and is explicit that an already-delivered push can't be un-sent (the documented limit).
  assert.match(copy, /can't be un-sent|tray/i);
  // ...and that recall itself is irreversible (recall + resend, no edit).
  assert.match(copy, /can't undo|recall it and send/i);
});

// --- result summary ---------------------------------------------------------------------------

test("summariseRecall leads with the removed reach, pluralised", () => {
  assert.equal(summariseRecall({ removed: 42 }), "Message recalled — removed from 42 inboxes");
  assert.equal(summariseRecall({ removed: 1 }), "Message recalled — removed from 1 inbox");
});

test("summariseRecall treats removed:0 as a successful no-op recall, not a failure", () => {
  const zero = "Message recalled — no in-app copies remained to remove";
  assert.equal(summariseRecall({ removed: 0 }), zero);
  assert.equal(summariseRecall({}), zero); // missing/absent count
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
