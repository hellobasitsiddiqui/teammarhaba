// Admin broadcast-compose logic (TM-365, epic TM-358) — the pure, browser-free half of the admin
// broadcast UI, split out of admin.js for the same reason push-deeplink.js was split out of push.js:
// it's the part that is unit-testable WITHOUT a browser, the Capacitor runtime, or the Firebase SDK.
// admin.js transitively imports the Firebase SDK (via auth.js) from a gstatic CDN URL the Node test
// runner can't load, so these rules would be untestable if they lived there. Here they're pure
// functions of their inputs, so `node --test web/tools/*.test.mjs` (the CI gate) can assert them.
//
// WHAT LIVES HERE (all pure — no DOM, no fetch):
//   - the length caps, mirrored 1:1 from the backend DTO (BroadcastPushRequest) so the browser fails
//     fast with the SAME limits the server enforces;
//   - validateBroadcast(): title/body/selection → per-field errors + a canSend flag (the Send-gate);
//   - routeOptionsFrom(): the { routes: [...] } push-routes response → a safe, de-duped, sorted list
//     of dropdown values (defensive: tolerates a bad/absent body and falls back to a caller-supplied
//     known list, so the picker is never empty);
//   - summariseBroadcast(): the BroadcastPushResponse → an honest one-line result summary.

/** Max title length — mirrors BroadcastPushRequest.MAX_TITLE_LENGTH (fits the DB column + PushMessage). */
export const MAX_TITLE = 200;
/** Max body length — mirrors BroadcastPushRequest.MAX_BODY_LENGTH. */
export const MAX_BODY = 1000;
/** Hard cap on recipients per broadcast — mirrors BroadcastPushRequest.MAX_RECIPIENTS. */
export const MAX_RECIPIENTS = 500;

/** The sentinel dropdown value for "no deep-link" (maps to a null `route` on the wire). */
export const NO_ROUTE = "";

/**
 * Validate a compose draft against the same rules the backend enforces, so we fail fast in the
 * browser AND only ever POST something the server will accept. Returns per-field error messages
 * ("" = valid) plus `canSend` — title + body non-blank and within their caps AND at least one (and
 * no more than MAX_RECIPIENTS) recipient selected. The error copy mirrors profile.js's
 * "Must be N characters or fewer." pattern for a consistent voice.
 *
 * @param {{title?: string, body?: string, selectionSize?: number}} draft
 * @returns {{title: string, body: string, recipients: string, canSend: boolean}}
 */
export function validateBroadcast({ title = "", body = "", selectionSize = 0 } = {}) {
  const t = (title ?? "").trim();
  const b = (body ?? "").trim();
  const n = Number(selectionSize) || 0;

  const errors = { title: "", body: "", recipients: "" };
  if (t === "") errors.title = "Title is required.";
  else if (t.length > MAX_TITLE) errors.title = `Must be ${MAX_TITLE} characters or fewer.`;

  if (b === "") errors.body = "Message is required.";
  else if (b.length > MAX_BODY) errors.body = `Must be ${MAX_BODY} characters or fewer.`;

  if (n === 0) errors.recipients = "Select at least one recipient.";
  else if (n > MAX_RECIPIENTS) errors.recipients = `Choose at most ${MAX_RECIPIENTS} recipients.`;

  const canSend = !errors.title && !errors.body && !errors.recipients;
  return { ...errors, canSend };
}

/**
 * Turn the GET /api/v1/admin/users/push-routes response ({@code {"routes":[...]}}) into a clean list
 * of dropdown values: strings only, trimmed, de-duped, sorted for a stable order. This is the SINGLE
 * source of truth for the deep-link picker (never free text) — but it's defensive: on a missing /
 * malformed body it falls back to `fallback` (the client KNOWN_ROUTES) so the picker is never empty
 * and the admin can still pick a valid route. The caller adds the leading "No deep-link" option; that
 * is a UI concern and intentionally not part of this list.
 *
 * @param {unknown} payload the parsed response body (expected `{ routes: string[] }`).
 * @param {string[]} [fallback] routes to use when the payload carries none (e.g. client KNOWN_ROUTES).
 * @returns {string[]} sorted, de-duped route strings.
 */
export function routeOptionsFrom(payload, fallback = []) {
  const raw = payload && Array.isArray(payload.routes) ? payload.routes : null;
  const source = raw && raw.length ? raw : fallback;
  const seen = new Set();
  for (const r of source) {
    if (typeof r === "string" && r.trim() !== "") seen.add(r.trim());
  }
  return [...seen].sort();
}

/**
 * An honest one-line summary of a broadcast result for the success toast. Reads only the fields the
 * response actually carries (BroadcastPushResponse: sent / skipped / delivered over recipients) — it
 * does NOT invent an "opted-out" number, because v1's `skipped` folds together "no device now" and
 * (once TM-364 lands) opted-out, and the projection can't tell them apart client-side. So we report
 * what's true: recipients we sent to, devices delivered, and recipients skipped (reached no device).
 *
 * e.g. "Sent to 12 users · 18 devices delivered · 3 skipped (no device)".
 *
 * @param {{sent?: number, skipped?: number, delivered?: number, requested?: number}} [r]
 * @returns {string}
 */
export function summariseBroadcast(r = {}) {
  const sent = Number(r.sent) || 0;
  const skipped = Number(r.skipped) || 0;
  const delivered = Number(r.delivered) || 0;
  const parts = [
    `Sent to ${sent} ${plural(sent, "user")}`,
    `${delivered} ${plural(delivered, "device")} delivered`,
  ];
  if (skipped > 0) parts.push(`${skipped} skipped (no device)`);
  return parts.join(" · ");
}

/** Naive English pluraliser for the small set of nouns used above (user/device). */
function plural(n, noun) {
  return n === 1 ? noun : `${noun}s`;
}
