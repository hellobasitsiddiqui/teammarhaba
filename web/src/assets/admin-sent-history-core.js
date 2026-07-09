// Admin sent-history — the pure, browser-free half (TM-444, epic TM-432, group-admin-messaging).
//
// The "shape / format / paging helpers" the ticket calls for, carved out of the DOM module
// (admin-sent-history.js) for the SAME reason broadcast.js / admin-messages-core.js were split out of
// their DOM siblings: the DOM module transitively imports the Firebase SDK (via api.js → auth.js) from
// a gstatic CDN URL the Node test runner can't load, so anything living there is untestable on the PR
// gate. Everything here is a pure function of its inputs — no DOM, no fetch, no Firebase — so
// `node --test web/tools/*.test.mjs` can assert it.
//
// WHAT THIS VIEW READS (GET /api/v1/admin/messages, TM-442): the calling admin's sent-message history,
// newest-first, in the shared page envelope `{ items, page, size, totalElements, totalPages }` (TM-115,
// zero-based page). Each item is an AdminSentHistoryResponse row — a campaign HEADER, deliberately
// header-only (TM-442's DTO does NOT carry the message body: the body lives in the admin_message table
// but the sent-history endpoint projects only the header facts, and this ticket adds no backend change).
// A row's shape:
//   {
//     id:             number,   // the admin_message campaign id (keys the row)
//     sentAt:         string,   // ISO-8601 instant the campaign was sent (drives newest-first order)
//     sentByUid:      string,   // Firebase UID of the admin who sent it
//     title:          string,   // the message title as sent
//     deepLink:       ?string,  // the optional in-app route it opened; null if none
//     audienceType:   string,   // the single audience dimension: USER | CITY | EVENT
//     audienceRef:    string,   // human-readable "who" descriptor (id CSV / city name(s))
//     recipientCount: number,   // reach the audience resolved to at send time (durable inbox rows)
//     status:         string,   // derived delivery status: SENT | EMPTY | RECALLED (TM-473)
//   }
//
// The helpers below turn that raw envelope + rows into the small, display-ready facts the DOM paints:
// a safe/normalised page envelope, an audience summary line, the id-CSV detail split, a status pill
// descriptor, and the prev/next/range/page paging math — each a pure function so it's unit-tested here.

/**
 * Default page size for the sent-history list. Small — a sent history is browsed newest-first a screen
 * at a time, not bulk-scanned — and comfortably under the backend's page-size cap (PageRequests, TM-115),
 * so the server never silently shrinks it (which would desync our paging math from the returned `size`).
 */
export const DEFAULT_PAGE_SIZE = 20;

/** Friendly labels for the three audience dimensions a send targets (mirrors the compose type labels). */
const AUDIENCE_TYPE_LABELS = Object.freeze({
  USER: "People",
  CITY: "City",
  EVENT: "Event attendees",
});

/**
 * A human label for an audience `type` (USER | CITY | EVENT). Case-insensitive on the wire value; an
 * unknown/absent type falls back to a neutral "Audience" so a future dimension never renders as blank.
 * @param {unknown} type
 * @returns {string}
 */
export function audienceTypeLabel(type) {
  const key = typeof type === "string" ? type.toUpperCase() : "";
  return AUDIENCE_TYPE_LABELS[key] || "Audience";
}

/**
 * "N recipient(s)" — the reach a campaign was durably delivered to (the inbox is written to every active
 * recipient regardless of push preference, so recipientCount is the reliable "sent" figure). A negative
 * or non-finite count is floored to 0 so a malformed row still reads sensibly.
 * @param {unknown} count
 * @returns {string}
 */
export function formatRecipientCount(count) {
  const n = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
  return `${n} ${n === 1 ? "recipient" : "recipients"}`;
}

/** A trimmed string, or "" for anything that isn't a non-blank string. */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A one-line audience summary for a history row — the AC's "audience summary" on each row. Leads with the
 * type label, and for a CITY send appends the actual city name (the audienceRef IS the city, which is
 * human-meaningful); for USER / EVENT the ref is an opaque id CSV (not friendly in a summary), so those
 * lean on the type label plus the recipient count instead. The exact ids are still surfaced verbatim in
 * the expanded detail (see {@link audienceRefDetail}).
 *
 *   CITY  → "City · London"
 *   USER  → "People · 12 recipients"
 *   EVENT → "Event attendees · 40 recipients"
 *
 * @param {object} row a history row (see the row shape at the top of the file).
 * @returns {string}
 */
export function audienceSummary(row = {}) {
  const label = audienceTypeLabel(row.audienceType);
  const type = typeof row.audienceType === "string" ? row.audienceType.toUpperCase() : "";
  if (type === "CITY") {
    const city = cleanText(row.audienceRef);
    return city ? `${label} · ${city}` : label;
  }
  return `${label} · ${formatRecipientCount(row.recipientCount)}`;
}

/**
 * The audience reference broken into a labelled detail pair for the expanded row, so the raw "who" is
 * always inspectable even when the summary line hides an opaque id CSV. The label names what the ref
 * holds for each dimension; the value is the trimmed ref (or "—" when absent).
 *
 *   USER  → { label: "Recipient IDs", value: "3, 7, 9" }
 *   CITY  → { label: "City",          value: "London" }
 *   EVENT → { label: "Event IDs",     value: "12, 15" }
 *
 * @param {object} row
 * @returns {{label: string, value: string}}
 */
export function audienceRefDetail(row = {}) {
  const type = typeof row.audienceType === "string" ? row.audienceType.toUpperCase() : "";
  const value = cleanText(row.audienceRef) || "—";
  const label = type === "USER" ? "Recipient IDs" : type === "CITY" ? "City" : type === "EVENT" ? "Event IDs" : "Audience";
  return { label, value };
}

/**
 * A display descriptor for a campaign's delivery `status` — a label + a tone key the DOM maps onto the
 * shared `.tm-badge` tones (ok / off / info). A header row exists only for a committed send, and an
 * audience that resolves to nobody is rejected before the header is written (TM-441), so in practice
 * this is always SENT; EMPTY is derived defensively for a hypothetical zero-recipient header.
 *
 * RECALLED (TM-473) is a real, reachable status: recalling a campaign flips its status and the list query
 * doesn't filter recalled rows, so one reaches this view. It gets a first-class curated badge — the
 * friendly "Recalled" copy (mirroring RECALLED_LABEL used on the recall button / notification tombstone),
 * with the muted "off" tone rather than the generic "info" catch-all — so it never renders as the raw
 * all-caps `RECALLED` token (the bug this fixes, TM-560).
 *
 *   SENT     → { label: "Sent",          tone: "ok" }
 *   EMPTY    → { label: "No recipients", tone: "off" }
 *   RECALLED → { label: "Recalled",      tone: "off" }
 *   other    → { label: <raw|"—">,       tone: "info" }
 *
 * @param {unknown} status
 * @returns {{label: string, tone: "ok"|"off"|"info"}}
 */
export function statusBadge(status) {
  const key = typeof status === "string" ? status.toUpperCase() : "";
  if (key === "SENT") return { label: "Sent", tone: "ok" };
  if (key === "EMPTY") return { label: "No recipients", tone: "off" };
  if (key === "RECALLED") return { label: "Recalled", tone: "off" };
  return { label: cleanText(status) || "—", tone: "info" };
}

// --- paging math (over the shared PageResponse envelope) --------------------------------------

/** Coerce a value to a finite, non-negative integer, or `fallback` when it isn't one. */
function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/**
 * Normalise a raw GET /api/v1/admin/messages envelope into the safe, fully-numeric shape the view pages
 * over, so a missing/degraded field can never break the paging math (an absent `items` becomes `[]`, a
 * non-numeric `totalPages` becomes a value consistent with what we actually received). `totalPages` is
 * floored to at least 1 when there ARE items but the server omitted it, so the "Page 1 of N" indicator
 * never claims zero pages while showing rows.
 *
 * @param {object} [envelope] the raw `{ items, page, size, totalElements, totalPages }` from the API.
 * @param {{fallbackSize?: number}} [opts] fallback page size when the envelope omits `size`.
 * @returns {{items: object[], page: number, size: number, totalElements: number, totalPages: number}}
 */
export function normalisePageResponse(envelope = {}, { fallbackSize = DEFAULT_PAGE_SIZE } = {}) {
  const items = Array.isArray(envelope.items) ? envelope.items : [];
  const page = nonNegativeInt(envelope.page, 0);
  // Size must be a POSITIVE page length — a 0 / negative / non-numeric `size` is meaningless (a page
  // can't hold zero rows), so fall back to the default rather than floor a bogus 0 up to 1 (which would
  // desync the range math from reality).
  const rawSize = Number(envelope.size);
  const size = Number.isFinite(rawSize) && rawSize >= 1 ? Math.trunc(rawSize) : fallbackSize;
  const totalElements = nonNegativeInt(envelope.totalElements, items.length);
  // Prefer the server's totalPages; otherwise derive it from the total / size; never report 0 pages
  // while we're holding rows (that would make the pager say "Page 1 of 0").
  const derived = size > 0 ? Math.ceil(totalElements / size) : 0;
  const totalPages = Math.max(nonNegativeInt(envelope.totalPages, derived), items.length > 0 ? 1 : 0);
  return { items, page, size, totalElements, totalPages };
}

/**
 * Whether there's a previous page to go back to (the list is zero-based, so any page past the first has
 * one). Guards a non-numeric page as "no previous".
 * @param {unknown} page zero-based current page index.
 * @returns {boolean}
 */
export function hasPrevPage(page) {
  return nonNegativeInt(page, 0) > 0;
}

/**
 * Whether there's a next page to advance to — true only when the current (zero-based) page isn't the
 * last. Guards non-numeric inputs as "no next".
 * @param {unknown} page zero-based current page index.
 * @param {unknown} totalPages total number of pages.
 * @returns {boolean}
 */
export function hasNextPage(page, totalPages) {
  const p = nonNegativeInt(page, 0);
  const total = nonNegativeInt(totalPages, 0);
  return p + 1 < total;
}

/**
 * Keep a requested page index within `[0, totalPages - 1]`, so a stale "Next" (e.g. after the last row
 * on a page was the only one and the total shrank) can't ask for a page that doesn't exist. With zero
 * pages the clamp is 0 (the empty state renders regardless).
 * @param {unknown} page requested zero-based page.
 * @param {unknown} totalPages total number of pages.
 * @returns {number}
 */
export function clampPage(page, totalPages) {
  const total = nonNegativeInt(totalPages, 0);
  const p = nonNegativeInt(page, 0);
  if (total <= 0) return 0;
  return Math.min(p, total - 1);
}

/**
 * The "Page X of Y" indicator, one-based for humans (the wire is zero-based). Y is floored to at least 1
 * so it never reads "of 0". Clamps X into range so it can't overshoot Y.
 * @param {unknown} page zero-based current page.
 * @param {unknown} totalPages total number of pages.
 * @returns {string}
 */
export function pageIndicator(page, totalPages) {
  const total = Math.max(1, nonNegativeInt(totalPages, 1));
  const human = Math.min(nonNegativeInt(page, 0) + 1, total);
  return `Page ${human} of ${total}`;
}

/**
 * The "A–B of T" range indicator for the current page, e.g. "1–20 of 97". `itemsOnPage` (how many rows
 * actually came back on this page) sizes the end of the range, so a short last page reads correctly
 * ("81–97 of 97"), and an empty page reads "0 of 0". All inputs are guarded to non-negative integers.
 * @param {unknown} page zero-based current page.
 * @param {unknown} size page size.
 * @param {unknown} totalElements total rows across all pages.
 * @param {unknown} itemsOnPage rows returned on the current page.
 * @returns {string}
 */
export function rangeIndicator(page, size, totalElements, itemsOnPage) {
  const total = nonNegativeInt(totalElements, 0);
  const count = nonNegativeInt(itemsOnPage, 0);
  if (total === 0 || count === 0) return "0 of 0";
  const from = nonNegativeInt(page, 0) * Math.max(1, nonNegativeInt(size, DEFAULT_PAGE_SIZE)) + 1;
  const to = Math.min(total, from + count - 1);
  return `${from}–${to} of ${total}`;
}

/**
 * Distinguish a genuinely-empty history (nothing ever sent) from an empty page reached by paging past
 * the end. Only the FIRST page being empty means "no messages sent yet" (the empty-state CTA); an empty
 * later page is a paging artefact the view corrects by clamping back a page.
 * @param {object[]} items rows on the current page.
 * @param {unknown} page zero-based current page.
 * @returns {boolean}
 */
export function isEmptyHistory(items, page) {
  return Array.isArray(items) && items.length === 0 && nonNegativeInt(page, 0) === 0;
}
