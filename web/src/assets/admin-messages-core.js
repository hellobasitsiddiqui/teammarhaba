// Admin compose — the pure, browser-free half (TM-443, epic TM-432, group-admin-messaging).
//
// This is the "validation / payload-build split + unit tests" the ticket calls for, carved out of the
// DOM module (admin-messages.js) for the SAME reason broadcast.js was split out of admin.js and
// event-form.js out of admin-events.js: the DOM module transitively imports the Firebase SDK (via
// api.js → auth.js) from a gstatic CDN URL the Node test runner can't load, so anything that lives
// there is untestable on the PR gate. Everything here is a pure function of its inputs — no DOM, no
// fetch, no Firebase — so `node --test web/tools/*.test.mjs` can assert it.
//
// WHAT LIVES HERE (all pure):
//   - the field caps + audience caps, mirrored 1:1 from the backend DTO (AdminMessageRequest, TM-441)
//     so the browser fails fast with the SAME limits the server enforces;
//   - the ~50-recipient confirmation threshold (the AC's "confirm when the resolved audience exceeds
//     ~50 recipients") and the copy that surfaces the count before an irreversible send;
//   - validateAdminMessage(): the whole compose form → per-field errors + a canSend flag, mirroring
//     the API's Bean Validation (required/length) AND its cross-field "exactly one target type" rule;
//   - buildAdminMessagePayload(): a form draft → the JSON body POST /api/v1/admin/messages accepts
//     (AdminMessageRequest shape), emitting ONLY the single targeted audience dimension;
//   - summariseSend(): an AdminMessageResponse → the honest one-line success toast.
//
// THE DRAFT SHAPE (what the DOM reads off the live inputs and passes here):
//   {
//     title:      string,
//     body:       string,
//     deepLink:   string,                 // "" = no deep-link
//     targetType: "user" | "city" | "event",
//     userIds:    Array<number|string>,   // the USER dimension (the searchable user picker)
//     city:       string,                 // the CITY dimension (a single city)
//     eventIds:   Array<number|string>,   // the EVENT dimension (the event multi-select)
//   }
//
// TARGETING (the product rule, TM-441 + the pinned clarification): a send targets exactly ONE type —
// a user OR a city OR event(s), never a combination. The UI's target-type toggle is the single source
// of truth for which dimension is live, so `targetType` drives both validation and the payload: only
// that dimension is read, the others are ignored even if they carry a stale selection. This is what
// makes "exactly one target type" structural here rather than a check the caller must remember to run.

// --- field caps (mirror AdminMessageRequest, TM-441) ------------------------------------------

/** Title cap — mirrors AdminMessageRequest.title @Size(max = 120). */
export const MAX_TITLE = 120;
/** Body cap — mirrors AdminMessageRequest.body @Size(max = 5000); an in-app message, not a push blast. */
export const MAX_BODY = 5000;
/** Explicit-recipient cap per send — mirrors AdminMessageRequest.userIds @Size(max = 500). */
export const MAX_USER_IDS = 500;
/** Cities cap per send — mirrors AdminMessageRequest.cities @Size(max = 50). */
export const MAX_CITIES = 50;
/** Events cap per send — mirrors AdminMessageRequest.eventIds @Size(max = 50). */
export const MAX_EVENT_IDS = 50;

/** The three audience dimensions, one of which a send targets (the target-type toggle's values). */
export const TARGET_TYPES = Object.freeze(["user", "city", "event"]);

/** Empty-selection sentinel for the deep-link picker (mirrors broadcast.js NO_ROUTE). */
export const NO_ROUTE = "";

/**
 * Above this resolved-recipient count a send gets the heightened "large audience" confirmation that
 * surfaces the count before it goes out (the AC's "~50 recipients"). A send is irreversible, so the
 * DOM confirms EVERY send; this threshold only decides whether the confirm shouts the size. An audience
 * whose size the client can't know before sending (a city / an event guest list — resolved server-side)
 * is treated as potentially-large, so it always gets the heightened confirm too.
 */
export const CONFIRM_THRESHOLD = 50;

// --- small helpers ----------------------------------------------------------------------------

/** A trimmed string, or "" for anything that isn't a non-blank string (mirrors event-form cleanText). */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalise an id list to finite numbers, de-duplicated, insertion-order preserved. Form values arrive
 * as strings (a data-attribute / option value), so each is coerced through Number; anything non-finite
 * (blank, NaN) is dropped. Mirrors AudienceSpec's server-side normalisation so the client sends exactly
 * what the resolver would keep.
 * @param {Array<number|string>} [ids]
 * @returns {number[]}
 */
function normaliseIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const n = Number(raw);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** The draft's target type if it's one of the three known dimensions, otherwise null (nothing chosen). */
function targetTypeOf(draft) {
  const t = draft && draft.targetType;
  return TARGET_TYPES.includes(t) ? t : null;
}

/** English pluraliser for the small set of nouns used in the copy below (person/event). */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

// --- resolved count + confirmation ------------------------------------------------------------

/**
 * The recipient count the CLIENT can know before sending, or null when only the server can resolve it.
 *  - USER: exact — the number of distinct picked account ids;
 *  - CITY / EVENT: null — the audience is resolved server-side at send time (a city's residents / an
 *    event's GOING attendees), a snapshot the client can't take, so its size is genuinely unknown here.
 * @param {object} draft
 * @returns {?number}
 */
export function resolvedRecipientCount(draft = {}) {
  return targetTypeOf(draft) === "user" ? normaliseIds(draft.userIds).length : null;
}

/**
 * Whether a send should get the heightened "large audience" confirmation (surface the count / warn).
 * True when the known count exceeds {@link CONFIRM_THRESHOLD}, OR when the count is unknown (a city /
 * event send whose size only the server resolves — treated as potentially-large so it's never sent
 * silently). A small, known audience (≤ threshold) returns false — it still gets a confirm, just the
 * plain one.
 * @param {object} draft
 * @returns {boolean}
 */
export function isLargeAudience(draft = {}) {
  const n = resolvedRecipientCount(draft);
  return n === null || n > CONFIRM_THRESHOLD;
}

/**
 * A human description of who a send targets, for the confirm dialog + the compose summary line. Reads
 * ONLY the targeted dimension (the product's one-target-type rule). Returns "" when nothing valid is
 * targeted yet. A caller may pass a friendlier user/city label (e.g. the picked user's name) via
 * {@code opts}; without it the description falls back to counts.
 *
 *   user  → "1 person"            (a single picked recipient — the pinned clarification's "a single user")
 *           "12 people"           (if the picker ever allows several — the wire supports up to 500)
 *   city  → "everyone in London"
 *   event → "the attendees of 1 event" / "the attendees of 3 events"
 *
 * @param {object} draft
 * @param {{userLabel?: string, cityLabel?: string}} [opts]
 * @returns {string}
 */
export function describeAudience(draft = {}, opts = {}) {
  switch (targetTypeOf(draft)) {
    case "user": {
      const n = normaliseIds(draft.userIds).length;
      if (n === 0) return "";
      if (n === 1 && cleanText(opts.userLabel)) return cleanText(opts.userLabel);
      return `${n} ${plural(n, "person", "people")}`;
    }
    case "city": {
      const city = cleanText(opts.cityLabel) || cleanText(draft.city);
      return city ? `everyone in ${city}` : "";
    }
    case "event": {
      const n = normaliseIds(draft.eventIds).length;
      return n === 0 ? "" : `the attendees of ${n} ${plural(n, "event", "events")}`;
    }
    default:
      return "";
  }
}

/**
 * The message shown in the pre-send confirm dialog. A send is irreversible (there is no un-send of a
 * delivered notification), so this is always shown; the copy adapts to the audience:
 *   - known count over the threshold  → names the exact count ("… will be delivered to 84 people.");
 *   - unknown count (city / event)    → warns it's resolved at send and could be large;
 *   - small, known count              → the plain, reassuring line.
 * Every branch ends with the irreversibility note, so an admin always confirms with eyes open.
 * @param {object} draft
 * @param {{userLabel?: string, cityLabel?: string}} [opts]
 * @returns {string}
 */
export function confirmCopy(draft = {}, opts = {}) {
  const who = describeAudience(draft, opts);
  const count = resolvedRecipientCount(draft);
  const tail = " This can't be undone.";
  if (count !== null && count > CONFIRM_THRESHOLD) {
    return `This message will be delivered to ${count} people — a large audience.${tail}`;
  }
  if (count === null) {
    // City / event: the exact number is a server-side snapshot at send time, so we can't show it yet.
    return `This message will be delivered to ${who || "the resolved audience"}. The exact number of ` +
      `recipients is calculated when you send, and could be large.${tail}`;
  }
  return `This message will be delivered to ${who}.${tail}`;
}

// --- validation (mirrors the API's Bean Validation + the one-target-type rule) ----------------

/**
 * Validate a compose draft against the SAME rules POST /api/v1/admin/messages enforces
 * (AdminMessageRequest, TM-441) so the browser fails fast with the server's limits and only ever POSTs
 * something it will accept. Returns a per-field error map ("" = valid) plus `canSend` (no field in
 * error). Required text mirrors @NotBlank; the length caps mirror @Size; and the single `audience`
 * error mirrors the cross-field @AssertTrue "provide exactly one target type" — checked against the
 * chosen `targetType` (the toggle), so a stale selection in an un-chosen dimension can't leak in.
 *
 * @param {object} draft the raw form values (see the DRAFT SHAPE note at the top of the file).
 * @returns {{title: string, body: string, audience: string, canSend: boolean}}
 */
export function validateAdminMessage(draft = {}) {
  const title = cleanText(draft.title);
  const body = cleanText(draft.body);

  const errors = { title: "", body: "", audience: "" };

  if (title === "") errors.title = "Title is required.";
  else if (title.length > MAX_TITLE) errors.title = `Must be ${MAX_TITLE} characters or fewer.`;

  if (body === "") errors.body = "Message is required.";
  else if (body.length > MAX_BODY) errors.body = `Must be ${MAX_BODY} characters or fewer.`;

  errors.audience = audienceError(draft);

  const canSend = !errors.title && !errors.body && !errors.audience;
  return { ...errors, canSend };
}

/**
 * The audience error for the CHOSEN target type ("" when valid): each dimension must have a non-empty
 * selection within its cap. A missing/unknown target type is "choose who to send to" (the toggle sits
 * on nothing). Only the targeted dimension is inspected — the one-target-type rule made structural.
 * @param {object} draft
 * @returns {string}
 */
function audienceError(draft) {
  switch (targetTypeOf(draft)) {
    case "user": {
      const n = normaliseIds(draft.userIds).length;
      if (n === 0) return "Pick at least one recipient.";
      if (n > MAX_USER_IDS) return `Choose at most ${MAX_USER_IDS} recipients.`;
      return "";
    }
    case "city": {
      const city = cleanText(draft.city);
      if (city === "") return "Enter a city to send to.";
      return "";
    }
    case "event": {
      const n = normaliseIds(draft.eventIds).length;
      if (n === 0) return "Pick at least one event.";
      if (n > MAX_EVENT_IDS) return `Choose at most ${MAX_EVENT_IDS} events.`;
      return "";
    }
    default:
      return "Choose who to send to.";
  }
}

// --- payload building (draft → the API body) --------------------------------------------------

/**
 * Turn a (validated) draft into the JSON body POST /api/v1/admin/messages accepts (AdminMessageRequest
 * shape, TM-441): the trimmed title + body, an optional `deepLink` (omitted entirely when blank — the
 * server treats absent as "no deep-link", and an off-list route it would 400 anyway), and EXACTLY ONE
 * audience dimension keyed off `targetType`:
 *   - user  → `userIds`  (coerced to numbers, de-duped)
 *   - city  → `cities`   (the single chosen city as a one-element list — the wire accepts several)
 *   - event → `eventIds` (coerced to numbers, de-duped)
 * The other two dimensions are never emitted, so the request always satisfies the server's
 * exactly-one-target-type rule (isExactlyOneTargetType). Returns a minimal body — only the targeted
 * dimension plus the message fields — so there is no ambiguity about intent on the wire.
 *
 * @param {object} draft the raw form values.
 * @returns {{title: string, body: string, deepLink?: string, userIds?: number[], cities?: string[], eventIds?: number[]}}
 */
export function buildAdminMessagePayload(draft = {}) {
  const body = {
    title: cleanText(draft.title),
    body: cleanText(draft.body),
  };
  const deepLink = cleanText(draft.deepLink);
  if (deepLink !== "") body.deepLink = deepLink;

  switch (targetTypeOf(draft)) {
    case "user":
      body.userIds = normaliseIds(draft.userIds);
      break;
    case "city": {
      const city = cleanText(draft.city);
      // A single chosen city goes out as a one-element list — the endpoint's `cities` dimension takes a
      // list (up to MAX_CITIES); the UI picks one, but the wire shape is the list either way.
      body.cities = city === "" ? [] : [city];
      break;
    }
    case "event":
      body.eventIds = normaliseIds(draft.eventIds);
      break;
    default:
      // No target chosen: emit nothing for the audience. validateAdminMessage already blocks Send here,
      // so this is only reached by a caller that skipped validation; the server would 400 it cleanly.
      break;
  }
  return body;
}

// --- result summary (AdminMessageResponse → the success toast) --------------------------------

/**
 * An honest one-line summary of an admin-send result for the success toast, read off the
 * AdminMessageResponse (TM-441): `recipientCount` (durable inbox rows — everyone reached), plus the
 * push breakdown `pushDelivered` / `pushSkipped`. The durable inbox is the real delivery (every active
 * recipient gets it regardless of push preference); push is best-effort on top, so the copy leads with
 * the recipient count and only adds the push parts when there's something to say.
 *
 *   "Sent to 42 people · 30 pushed · 12 not pushed"
 *   "Sent to 1 person"                                   (a single recipient, nobody to push-note)
 *
 * @param {{recipientCount?: number, pushDelivered?: number, pushSkipped?: number}} [result]
 * @returns {string}
 */
export function summariseSend(result = {}) {
  const recipients = Number(result.recipientCount) || 0;
  const delivered = Number(result.pushDelivered) || 0;
  const skipped = Number(result.pushSkipped) || 0;
  const parts = [`Sent to ${recipients} ${plural(recipients, "person", "people")}`];
  if (delivered > 0) parts.push(`${delivered} pushed`);
  if (skipped > 0) parts.push(`${skipped} not pushed`);
  return parts.join(" · ");
}
