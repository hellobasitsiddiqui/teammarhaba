// Notification (push-broadcast) sent-history — the pure, browser-free row model (TM-373, epic TM-358).
//
// The History tab on the Send-notification screen (admin-notifications.js) lists the push broadcasts the
// signed-in admin has sent — mirroring the MESSAGE sent-history (admin-sent-history.js, TM-444). It reads
// GET /api/v1/admin/push/broadcasts (TM-373), newest-first, paged, in the shared page envelope
// `{ items, page, size, totalElements, totalPages }` (TM-115, zero-based page). Each item is a
// BroadcastHistoryResponse header row:
//   {
//     id:             number,   // notification_broadcasts header id (keys the row)
//     sentAt:         string,   // ISO-8601 instant the broadcast was sent (drives newest-first order)
//     title:          string,   // the push title as sent
//     body:           string,   // the push body as sent (the broadcast header stores the body inline)
//     route:          ?string,  // the optional in-app deep-link route it opened; null if none
//     recipientCount: number,   // reach the broadcast resolved to at send time
//     delivered:      number,   // devices the broadcast successfully delivered to
//     skipped:        number,   // recipients skipped (opted out / no device / disabled / not found)
//   }
//
// WHY A PURE CORE (the broadcast.js / admin-sent-history-core.js split): admin-notifications.js
// transitively imports the Firebase SDK (via api.js → auth.js) from a gstatic CDN URL the Node test
// runner can't load, so any logic living there is untestable on the PR gate. Everything here is a pure
// function of its inputs — no DOM, no fetch, no Firebase — so `node --test web/tools/*.test.mjs` can
// assert it. The generic paging math + `formatRecipientCount` are SHARED from admin-sent-history-core.js
// (same envelope, same conventions) rather than re-implemented here; this file adds only the
// broadcast-row-specific formatting.

import { formatRecipientCount } from "./admin-sent-history-core.js";

export { formatRecipientCount };

/** A trimmed string, or "" for anything that isn't a non-blank string. */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The display title for a broadcast history row — the push title as sent, or a neutral "(untitled)"
 * placeholder for a blank/absent title (belt-and-braces: the send path requires a title, so this only
 * guards a malformed row). Returned trimmed.
 * @param {{title?: unknown}} [row]
 * @returns {string}
 */
export function broadcastTitle(row = {}) {
  return cleanText(row.title) || "(untitled)";
}

/**
 * The display body for a broadcast history row — the push body VERBATIM (not trimmed, so whitespace
 * renders faithfully), or "" when there's genuinely no body. Unlike the message history (where the body
 * is a lazy by-id fetch), the broadcast header carries its body inline, so a row can show it directly.
 * @param {{body?: unknown}} [row]
 * @returns {string}
 */
export function broadcastBody(row = {}) {
  return typeof row.body === "string" ? row.body : "";
}

/**
 * A one-line reach summary for a broadcast row: the recipient count (the audience it targeted) plus the
 * delivered count when it differs, e.g. "12 recipients · 18 delivered". The counts are floored to 0 for
 * a malformed row. `delivered` is shown only when present and non-negative — a header always records it,
 * but this stays defensive so a partial row still reads sensibly.
 *
 * @param {{recipientCount?: unknown, delivered?: unknown}} [row]
 * @returns {string}
 */
export function reachSummary(row = {}) {
  const parts = [formatRecipientCount(row.recipientCount)];
  // Only append "delivered" when the row actually carries a numeric value — a null/undefined/garbage
  // `delivered` (a partial or malformed row) is treated as absent, not silently rendered as "0
  // delivered". A header always records the count, so in practice this always shows.
  if (typeof row.delivered === "number" && Number.isFinite(row.delivered) && row.delivered >= 0) {
    parts.push(`${Math.trunc(row.delivered)} delivered`);
  }
  return parts.join(" · ");
}

/**
 * The delivery-outcome facts for a broadcast's expanded detail — reach, delivered and skipped as
 * labelled, display-ready numbers (each floored to 0). Kept separate from {@link reachSummary} (the
 * compact row line) so the detail panel can lay them out as a facts list.
 *
 * @param {{recipientCount?: unknown, delivered?: unknown, skipped?: unknown}} [row]
 * @returns {{recipients: number, delivered: number, skipped: number}}
 */
export function outcomeCounts(row = {}) {
  return {
    recipients: flooredInt(row.recipientCount),
    delivered: flooredInt(row.delivered),
    skipped: flooredInt(row.skipped),
  };
}

/** Coerce to a non-negative integer (floored at 0), or 0 for a non-finite value. */
function flooredInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}
