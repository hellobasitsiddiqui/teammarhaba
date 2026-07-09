// Admin message RECALL — the pure, browser-free half (TM-473, epic TM-432, group-admin-messaging).
//
// The reusable "recall control" logic, carved out of the DOM so `node --test web/tools/*.test.mjs` can
// assert it — the same broadcast.js / event-form.js / admin-messages-core.js split. The DOM module
// (admin-messages.js) transitively imports the Firebase SDK (via api.js → auth.js) from a gstatic CDN
// the Node test runner can't load, so anything testable lives here, as a pure function of its inputs.
//
// WHY A SEPARATE CORE (not folded into admin-messages-core.js): recall is a control that appears wherever
// a SENT message is shown — the compose success/return area in THIS branch, and the sent-history LIST
// rows in TM-444 (a parallel ticket whose view this branch must NOT assume exists). Both surfaces need
// the SAME confirm copy, button labels, disabled/"recalled" state and result summary, so they live here
// once and each surface just mounts them. TM-444 will import recallControlModel() for its rows.
//
// WHAT LIVES HERE (all pure):
//   - RECALL_LABEL / RECALLED_LABEL — the button + done-state copy;
//   - recallConfirmCopy() — the danger-confirm message, which SURFACES the best-effort-push honesty (an
//     already-delivered OS-tray push can't be un-sent; recall removes the in-app inbox + bell copies);
//   - summariseRecall() — an AdminMessageRecallResponse → the honest one-line success toast;
//   - recallControlModel() — given a sent message (live or already-recalled), the control's state:
//     whether recall is offered, the label to show, and a short status note. This is the bit TM-444's
//     list rows consume so a recalled row renders consistently with the compose success area.

// --- labels -----------------------------------------------------------------------------------

/** The action button label while a message is still live and recallable. */
export const RECALL_LABEL = "Recall message";

/** The terminal state label once a message has been recalled (the control is shown, disabled). */
export const RECALLED_LABEL = "Recalled";

// --- confirm copy (the danger dialog) ---------------------------------------------------------

/**
 * The message shown in the pre-recall danger confirm. Recall is a deliberate, consequential action, so
 * it is always confirmed — and the copy is HONEST about its one real limit: it pulls the message from
 * every recipient's in-app inbox and notification bell, but a push that already reached someone's phone
 * tray can't be un-sent (there is no un-push). Keeping that in the confirm means an admin recalls with
 * eyes open and never believes recall is more total than it is.
 *
 * @returns {string}
 */
export function recallConfirmCopy() {
  return (
    "Recall this message? It will be removed from every recipient's in-app inbox and notification " +
    "bell. A phone push that was already delivered can't be un-sent, so it may still show in their " +
    "notification tray until they clear it. You can't undo a recall — to change a message, recall it " +
    "and send a new one."
  );
}

// --- result summary (AdminMessageRecallResponse → the success toast) ---------------------------

/**
 * An honest one-line summary of a recall result for the success toast, read off the
 * AdminMessageRecallResponse (TM-473): `removed` is how many durable in-app copies were deleted (the
 * inbox/panel rows, which also back the bell). The copy leads with that reach; a `removed` of 0 means
 * there was nothing left in-app to pull (already recalled, or every recipient had already cleared it),
 * which is still a successful recall — so it says so rather than implying a failure.
 *
 *   "Message recalled — removed from 42 inboxes"
 *   "Message recalled — removed from 1 inbox"
 *   "Message recalled — no in-app copies remained to remove"   (removed === 0)
 *
 * @param {{removed?: number}} [result]
 * @returns {string}
 */
export function summariseRecall(result = {}) {
  const removed = Number(result.removed) || 0;
  if (removed <= 0) {
    return "Message recalled — no in-app copies remained to remove";
  }
  const noun = removed === 1 ? "inbox" : "inboxes";
  return `Message recalled — removed from ${removed} ${noun}`;
}

// --- control state (the reusable bit TM-444's list rows also consume) --------------------------

/**
 * The recall control's state for a given sent message. A message is recalled iff it carries a
 * non-empty `recalledAt` (the header marker the backend sets, surfaced on AdminSentHistoryResponse) OR
 * an explicit `recalled === true` flag — so both the sent-history row shape (TM-442/TM-444) and a
 * locally-updated compose success object resolve correctly. Returns:
 *   - `recalled`  : whether it has already been recalled;
 *   - `canRecall` : whether the recall action should be offered (only a live message);
 *   - `label`     : the button/state text ({@link RECALL_LABEL} live, {@link RECALLED_LABEL} once done);
 *   - `note`      : a short status line for the recalled state ("" while live), so a row/panel can show
 *                   "Recalled" without each surface re-deriving the copy.
 *
 * @param {{recalledAt?: ?string, recalled?: boolean}} [message]
 * @returns {{recalled: boolean, canRecall: boolean, label: string, note: string}}
 */
export function recallControlModel(message = {}) {
  const recalled = message.recalled === true || isNonEmptyString(message.recalledAt);
  return {
    recalled,
    canRecall: !recalled,
    label: recalled ? RECALLED_LABEL : RECALL_LABEL,
    note: recalled ? "This message was recalled and removed from recipients' inboxes." : "",
  };
}

/** True for a non-blank string (a set `recalledAt` timestamp), false for null/undefined/""/non-string. */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
