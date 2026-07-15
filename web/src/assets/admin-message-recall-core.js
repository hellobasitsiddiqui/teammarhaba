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
 * it is always confirmed — and the copy is HONEST about what recall does and its one real limit. It
 * describes the HYBRID behaviour (TM-473, the owner's design decision): recipients who haven't seen it
 * yet won't see it at all, while anyone who already saw it keeps it struck-through and marked "Recalled
 * by admin" (we don't silently vanish something someone already looked at). And it's explicit that a
 * push already delivered to a phone tray can't be un-sent (there is no un-push). Keeping all that in
 * the confirm means an admin recalls with eyes open and never believes recall is more total than it is.
 *
 * @returns {string}
 */
export function recallConfirmCopy() {
  return (
    "Recall this message? Recipients who haven't seen it yet won't see it at all. Anyone who already " +
    "saw it will keep it struck through and marked “Recalled by admin”. A phone push that was " +
    "already delivered can't be un-sent, so it may still show in their notification tray until they " +
    "clear it. You can't undo a recall — to change a message, recall it and send a new one."
  );
}

// --- result summary (AdminMessageRecallResponse → the success toast) ---------------------------

/**
 * An honest one-line summary of a recall result for the success toast, read off the
 * AdminMessageRecallResponse (TM-473). The HYBRID recall touches two partitions, reported separately:
 *   - `removed`    : durable in-app copies DELETED — the recipients who hadn't seen it yet (clean vanish);
 *   - `tombstoned` : durable in-app copies KEPT + marked recalled — recipients who'd already seen it
 *                    (now shown struck-through as "Recalled by admin").
 * The copy leads with the total reach (removed + tombstoned) and, when some were already seen, names how
 * many were kept as tombstones — so the admin sees exactly what happened. A total of 0 means there was
 * nothing left in-app to pull (already recalled, or every copy had been purged), which is still a
 * successful recall — so it says so rather than implying a failure.
 *
 *   "Message recalled — pulled from 42 recipients"                              (all unseen)
 *   "Message recalled — pulled from 42 recipients (30 had seen it, now marked recalled)"
 *   "Message recalled — pulled from 1 recipient"
 *   "Message recalled — no in-app copies remained to remove"                    (total === 0)
 *
 * @param {{removed?: number, tombstoned?: number}} [result]
 * @returns {string}
 */
export function summariseRecall(result = {}) {
  const removed = Number(result.removed) || 0;
  const tombstoned = Number(result.tombstoned) || 0;
  const total = removed + tombstoned;
  if (total <= 0) {
    return "Message recalled — no in-app copies remained to remove";
  }
  const noun = total === 1 ? "recipient" : "recipients";
  let summary = `Message recalled — pulled from ${total} ${noun}`;
  if (tombstoned > 0) {
    summary += ` (${tombstoned} had seen it, now marked recalled)`;
  }
  return summary;
}

// --- control state (the reusable bit TM-444's list rows also consume) --------------------------

/**
 * The recall control's state for a given sent message. A message is recalled iff it carries a
 * non-empty `recalledAt` (the header marker the backend sets), an explicit `recalled === true` flag,
 * OR a `status` of `RECALLED` (the derived delivery status the sent-history list projects, TM-473/
 * TM-444 — the list row shape carries the status, not always a `recalledAt`) — so the compose success
 * object AND the sent-history row shape both resolve correctly. Returns:
 *   - `recalled`  : whether it has already been recalled;
 *   - `canRecall` : whether the recall action should be offered (only a live message);
 *   - `label`     : the button/state text ({@link RECALL_LABEL} live, {@link RECALLED_LABEL} once done);
 *   - `note`      : a short status line for the recalled state ("" while live), so a row/panel can show
 *                   "Recalled" without each surface re-deriving the copy.
 *
 * @param {{recalledAt?: ?string, recalled?: boolean, status?: ?string}} [message]
 * @returns {{recalled: boolean, canRecall: boolean, label: string, note: string}}
 */
export function recallControlModel(message = {}) {
  const recalledStatus = isNonEmptyString(message.status) && message.status.trim().toUpperCase() === "RECALLED";
  const recalled = message.recalled === true || isNonEmptyString(message.recalledAt) || recalledStatus;
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
