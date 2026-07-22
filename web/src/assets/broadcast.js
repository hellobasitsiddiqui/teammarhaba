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
//   - summariseBroadcast(): the BroadcastPushResponse → an honest one-line result summary;
//   - the user display-identity chain (TM-372): maskPhone / uidPrefix / displayIdentifier /
//     contactCell / searchHaystack — how the admin table + broadcast picker name and find an account
//     that has no email/display name (phone-auth sign-ins), so no row is ever blank or unsearchable;
//   - the full-account-set page walk (TM-370): fetchAllUsers / selectionCapMessage / coverageNote —
//     how the console loads EVERY page of the admin list (so select-all genuinely covers the whole
//     account set, not just the first 100) and what it tells the admin when it can't. fetchAllUsers
//     itself does no fetching — the page fetcher is injected — so it stays Node-testable.

/** Max title length — mirrors BroadcastPushRequest.MAX_TITLE_LENGTH (fits the DB column + PushMessage). */
export const MAX_TITLE = 200;
/** Max body length — mirrors BroadcastPushRequest.MAX_BODY_LENGTH. */
export const MAX_BODY = 1000;
/** Hard cap on recipients per broadcast — mirrors BroadcastPushRequest.MAX_RECIPIENTS. */
export const MAX_RECIPIENTS = 500;

/** The sentinel dropdown value for "no deep-link" (maps to a null `route` on the wire). */
export const NO_ROUTE = "";

// --- push-eligibility guard for the send-notification page (TM-427) ----------------------------
//
// The bug: an admin could pick a user who can't receive push (push not enabled, or no registered
// device) and the broadcast was silently lost. The admin list payload now carries a per-user
// `pushEligible` flag from the backend (the account's pref permits push AND it has a device token —
// mirroring the BroadcastService opt-out/no-device skip). These pure helpers are how the console
// SHOWS that status and REFUSES to select an ineligible user, so a push is never fired into the void.

/** Tooltip/hint shown on an ineligible user's disabled checkbox and its "No push" badge (TM-427). */
export const PUSH_INELIGIBLE_HINT =
  "This user can't receive push — they haven't enabled push, or have no registered device.";

/**
 * Whether a push could actually reach this user — the backend `pushEligible` flag. Defensive: only an
 * explicit `true` counts, so a row from an older payload without the field (or any non-boolean) is
 * treated as INELIGIBLE. Fail-safe by design — never let the UI select a user it can't confirm is
 * reachable.
 *
 * @param {{pushEligible?: unknown}} [user]
 * @returns {boolean}
 */
export function isPushEligible(user = {}) {
  return user?.pushEligible === true;
}

/** The push-status badge text for a user row: "Push" when reachable, "No push" when not (TM-427). */
export function pushStatusLabel(user = {}) {
  return isPushEligible(user) ? "Push" : "No push";
}

/**
 * Of `users`, only those a push can actually reach (TM-427) — what select-all and the recipient set
 * are built from, so an ineligible user can never enter the broadcast selection. Order preserved;
 * non-array input yields [].
 *
 * @param {Array<{pushEligible?: unknown}>} users
 * @returns {Array}
 */
export function eligibleRecipients(users) {
  return Array.isArray(users) ? users.filter(isPushEligible) : [];
}

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
 * Decide which {@link validateBroadcast} errors to actually DISPLAY, given which fields the admin has
 * touched (TM-976 / QA-roam A8). {@link validateBroadcast} still gates Send via `canSend` regardless of
 * this — this only suppresses the visible "required" errors on a pristine, untouched panel so it doesn't
 * shout a screenful of red before the admin has shown any intent.
 *
 * - `title` / `body` errors surface only once that field has been touched.
 * - the `recipients` error surfaces once the admin has ENGAGED at all (touched any field or the
 *   selection), so "Select at least one recipient." reads as guidance while composing rather than an
 *   accusation on first paint.
 *
 * @param {{title?: string, body?: string, recipients?: string}} validation - a {@link validateBroadcast} result
 * @param {{title?: boolean, body?: boolean, recipients?: boolean}} [touched]
 * @returns {{title: string, body: string, recipients: string}} the errors to render ("" = show nothing)
 */
export function composeErrorsToShow({ title = "", body = "", recipients = "" } = {}, touched = {}) {
  const engaged = Boolean(touched.title || touched.body || touched.recipients);
  return {
    title: touched.title ? title : "",
    body: touched.body ? body : "",
    recipients: engaged ? recipients : "",
  };
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
 * A friendly label for a deep-link route that has NO curated entry in a caller's ROUTE_LABELS map
 * (TM-617). Both admin route pickers (admin.js / admin-messages.js) previously fell back to the raw
 * hash token, so a backend route added without a matching label rendered as a bare "#/…" in the
 * dropdown — readable to a developer, opaque to the admin, and a silent trap. This humanises the token
 * instead: "#/event-detail" → "Event detail". It's the SHARED fallback both `routeLabel`s now use, so
 * the two curated maps can stay per-page while the unlabeled-route behaviour is fixed once, here, and
 * unit-tested (routeLabel itself lives in the browser-only admin files and can't be tested directly).
 *
 * Rules (defensive — any input yields a human string): drop a leading "#" then "/", treat "/", "-" and
 * "_" as word breaks, collapse whitespace, and sentence-case the first letter (matching curated labels
 * like "Admin console" / "Sign in", which capitalise only the first word). A token that humanises to
 * nothing — "#/", "" or a non-string — falls back to "App home", the app's default landing, so the
 * result is NEVER a raw token and never blank.
 *
 * @param {unknown} route the raw route token, e.g. "#/event-detail".
 * @returns {string} a readable label, e.g. "Event detail".
 */
export function humanizeRoute(route) {
  const slug = String(route ?? "")
    .replace(/^#/, "") // drop a leading hash …
    .replace(/^\//, "") // … then a leading slash → "event-detail" / "events/detail"
    .replace(/[/_-]+/g, " ") // path + word separators become spaces
    .trim()
    .replace(/\s+/g, " "); // collapse any run of whitespace to a single space
  if (slug === "") return "App home"; // "#/", "" or garbage → the app's default screen, never a token
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * An honest one-line summary of a broadcast result for the success toast. Post-TM-364 the response
 * carries the WHY behind every skip — `skippedOptedOut` / `skippedDisabled` / `skippedNotFound`
 * (BroadcastPushResponse) — so we no longer have to fold everything into a bare "no device" count: we
 * can, and do, report the real breakdown. The four sub-reasons sum to `skipped`; whatever `skipped`
 * doesn't attribute to opted-out / disabled / not-found is genuinely "no device", derived as the
 * residual (never trusted from a field that doesn't exist). Only the non-zero sub-parts are shown, so
 * a clean send stays terse and a mixed one is transparent.
 *
 * e.g. "Sent to 12 users · 18 devices delivered · 5 skipped (2 opted out, 3 no device)".
 *
 * @param {{sent?: number, skipped?: number, delivered?: number, requested?: number,
 *          skippedOptedOut?: number, skippedDisabled?: number, skippedNotFound?: number}} [r]
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
  if (skipped > 0) parts.push(`${skipped} skipped${skipReasons(r, skipped)}`);
  return parts.join(" · ");
}

/**
 * Build the parenthetical reason breakdown for the skipped count, e.g. " (2 opted out, 3 no device)".
 * "No device" isn't its own response field — it's the residual of `skipped` after the three named rails
 * (opted-out / disabled / not-found), so a recipient reached with no registered device is still
 * accounted for. Only non-zero reasons appear; if none can be attributed (all sub-counters zero /
 * absent), the whole residual falls to "no device" so the clause is never empty. Returns "" only when
 * there's nothing to say (caller already guards skipped > 0).
 */
function skipReasons(r, skipped) {
  const optedOut = Number(r.skippedOptedOut) || 0;
  const disabled = Number(r.skippedDisabled) || 0;
  const notFound = Number(r.skippedNotFound) || 0;
  const noDevice = Math.max(0, skipped - optedOut - disabled - notFound);
  const reasons = [];
  if (optedOut > 0) reasons.push(`${optedOut} opted out`);
  if (noDevice > 0) reasons.push(`${noDevice} no device`);
  if (disabled > 0) reasons.push(`${disabled} disabled`);
  if (notFound > 0) reasons.push(`${notFound} not found`);
  return reasons.length ? ` (${reasons.join(", ")})` : "";
}

/** Naive English pluraliser for the small set of nouns used above (user/device). */
function plural(n, noun) {
  return n === 1 ? noun : `${noun}s`;
}

// --- user display identity (TM-372) -----------------------------------------------------------
//
// A phone-auth account can have NO email and NO display name, so any admin surface that identifies
// users only by those renders it as a blank, unfindable row. These helpers are the single fallback
// chain every admin render/search path goes through instead:
//
//     displayName → email → masked auth phone → uid-prefix → "User #<db id>"
//
// The admin list payload carries `phoneNumber` (the verified auth phone, read live from Firebase by
// the backend — TM-372) but NOT the Firebase uid (deliberately withheld by UserResponse), so today
// the uid link only fires for objects that carry a `uid`/`firebaseUid` field; the guaranteed last
// resort for admin rows is the DB id, which the table already shows in its ID column.

/** Leading characters the masked phone keeps (international prefix + area, e.g. "+1650"). */
const PHONE_MASK_HEAD = 5;
/** Trailing digits the masked phone keeps (the part people recognise, e.g. "0100"). */
const PHONE_MASK_TAIL = 4;
/** Characters of a uid the uid-prefix fallback shows — enough to correlate, short enough for a cell. */
const UID_PREFIX_LENGTH = 8;

/** A trimmed string, or "" for anything that isn't a non-blank string. */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** The "User #<db id>" last-resort label, or "" when there's no id to point at. */
function idLabel(user) {
  return user.id == null || String(user.id).trim() === "" ? "" : `User #${user.id}`;
}

/**
 * Mask a phone number for table display: keep the head ("+1650") and the last four ("0100"), elide
 * the middle — "+16505550100" → "+1650…0100". Recognisable to an admin without printing a column of
 * full numbers; the raw number stays available for search (see searchHaystack) and the detail view.
 * A number too short to elide anything is returned as-is; non-string/blank input is "".
 */
export function maskPhone(phone) {
  const p = cleanText(phone);
  if (p.length <= PHONE_MASK_HEAD + PHONE_MASK_TAIL) return p;
  return `${p.slice(0, PHONE_MASK_HEAD)}…${p.slice(-PHONE_MASK_TAIL)}`;
}

/** The first characters of a uid + "…" (e.g. "jLz3NDaB…"); short uids pass through; non-string → "". */
export function uidPrefix(uid) {
  const u = cleanText(uid);
  if (u.length <= UID_PREFIX_LENGTH) return u;
  return `${u.slice(0, UID_PREFIX_LENGTH)}…`;
}

/**
 * THE display identifier for a user, anywhere one is rendered in the admin surfaces (checkbox
 * labels, confirm dialogs, the detail-modal title): the first non-blank link of the fallback chain
 * displayName → email → masked phone → uid-prefix → "User #id". Never returns "" — a totally bare
 * object still gets "Unknown user" rather than rendering nothing.
 *
 * @param {{displayName?: string, email?: string, phoneNumber?: string, uid?: string,
 *          firebaseUid?: string, id?: number|string}} [user]
 * @returns {string}
 */
export function displayIdentifier(user = {}) {
  return (
    cleanText(user.displayName) ||
    cleanText(user.email) ||
    maskPhone(user.phoneNumber) ||
    uidPrefix(user.uid ?? user.firebaseUid) ||
    idLabel(user) ||
    "Unknown user"
  );
}

/**
 * What the admin table's Email column shows for a user — email when there is one, otherwise the
 * best NON-NAME contact fallback so no row is ever blank end-to-end:
 *   - masked auth phone when present (useful contact info even for named accounts);
 *   - the uid-prefix / "User #id" tail ONLY when the account also has no display name (a named
 *     account is already identifiable by its Name cell — repeating "User #12" there is noise);
 *   - "—" when there's genuinely nothing to add.
 * `fallback: true` marks a non-email value so the cell can render it muted (visually "not an email").
 *
 * @returns {{text: string, fallback: boolean}}
 */
export function contactCell(user = {}) {
  const email = cleanText(user.email);
  if (email) return { text: email, fallback: false };
  const contact =
    maskPhone(user.phoneNumber) ||
    (cleanText(user.displayName) ? "" : uidPrefix(user.uid ?? user.firebaseUid) || idLabel(user));
  if (contact) return { text: contact, fallback: true };
  return { text: "—", fallback: false };
}

/**
 * Everything the admin search box should match for a user, lowercased: name, email, the auth phone
 * BOTH raw (so typing "+1650555" or "0100" finds it) and masked (so pasting the displayed
 * "+1650…0100" finds it), any uid, and the "User #id" label (so a degraded row is findable by its
 * id). The caller lowercases the query; substring match against this string.
 *
 * @returns {string}
 */
export function searchHaystack(user = {}) {
  return [
    user.displayName,
    user.email,
    user.phoneNumber,
    maskPhone(user.phoneNumber),
    user.uid ?? user.firebaseUid,
    idLabel(user),
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// --- full account-set fetch (TM-370) -----------------------------------------------------------
//
// The console used to load ONE page (page=0&size=100 — the server's max page size) and run all
// filtering/selection client-side over that, so with >100 accounts "select all matching" silently
// missed everyone beyond the first page. fetchAllUsers is the fix for the current scale (hundreds,
// not millions): walk the paginated endpoint until exhausted so the in-memory set — and therefore
// search, the stats bar and select-all — covers the WHOLE account list.
//
// The page fetcher is INJECTED (`(page, size) => Promise<envelope>`), which keeps this loop pure
// enough to unit-test in Node and is deliberately the seam for the next scale step: when the base
// outgrows fetch-all (thousands+), a server-side "select all matching the filter" replaces this
// walk at its single call site (admin.js loadUsers) without touching the selection model.

/** Per-request page size for the admin account walk — mirrors the server's MAX_PAGE_SIZE (TM-111). */
export const USERS_PAGE_SIZE = 100;

/**
 * Runaway guard on the page walk: at most this many requests per load (× {@link USERS_PAGE_SIZE} =
 * 5,000 accounts). Not a product limit — a circuit breaker against a pathological/looping server
 * response. Hitting it flags the fetch as partial so the coverage warning shows.
 */
export const MAX_USER_FETCH_PAGES = 50;

/**
 * Fetch the ENTIRE account list by walking the paginated admin endpoint page by page.
 *
 * `fetchPage(page, pageSize)` must resolve to the server's paged envelope
 * ({@code {items, totalElements, totalPages, …}}); this loop owns when to stop:
 *   - after the last page — trusting the server's `totalPages` when present (avoids a wasted empty
 *     request on an exact multiple of the page size), else when a short page comes back;
 *   - at `maxPages` (the runaway guard) — the result is then flagged incomplete;
 *   - on a failed page: a failure with NOTHING loaded yet is rethrown (a real load error for the
 *     caller to surface); a failure after some pages loaded keeps the partial set and flags it
 *     incomplete, so one blipped request degrades coverage (with a warning) instead of blanking
 *     the whole console.
 *
 * Rows are de-duplicated by `id`: accounts created/removed mid-walk can shift page boundaries, so
 * the same row may appear on two consecutive pages — selection is by id (TM-358), so a duplicate
 * would double-render but a dropped dupe loses nothing.
 *
 * @param {(page: number, pageSize: number) => Promise<{items?: unknown[], totalElements?: number,
 *          totalPages?: number}>} fetchPage resolves one page of the admin list.
 * @param {{pageSize?: number, maxPages?: number}} [options]
 * @returns {Promise<{users: object[], total: number, complete: boolean}>} every fetched row, the
 *          true account total (the server's count when known, never less than what was fetched),
 *          and whether the walk covered the whole list.
 */
export async function fetchAllUsers(fetchPage, { pageSize = USERS_PAGE_SIZE, maxPages = MAX_USER_FETCH_PAGES } = {}) {
  const users = [];
  const seen = new Set();
  let reportedTotal = 0;
  let complete = false;

  for (let page = 0; page < maxPages; page += 1) {
    let body;
    try {
      body = await fetchPage(page, pageSize);
    } catch (err) {
      if (users.length === 0) throw err; // nothing usable loaded — surface the load error
      break; // a later page blipped: keep the partial set; `complete` stays false → warning shows
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    for (const item of items) {
      const id = item?.id;
      if (id != null) {
        if (seen.has(id)) continue; // page-boundary duplicate (row shifted mid-walk)
        seen.add(id);
      }
      users.push(item);
    }

    const total = Number(body?.totalElements);
    if (Number.isFinite(total) && total > reportedTotal) reportedTotal = total;

    const totalPages = Number(body?.totalPages);
    const lastByServer = Number.isFinite(totalPages) && page + 1 >= totalPages;
    const lastByCount = items.length < pageSize; // a short (or empty) page ⇒ nothing beyond it
    if (lastByServer || lastByCount) {
      complete = true;
      break;
    }
  }

  return { users, total: Math.max(reportedTotal, users.length), complete };
}

/**
 * The warning to show when a selection has grown past the broadcast API's hard recipient cap
 * ({@link MAX_RECIPIENTS}, the server DTO's {@code @Size} on userIds). Selecting past the cap is
 * allowed — the admin may be mid-way through narrowing a cohort — but the Send-gate stays closed
 * (validateBroadcast) and this message says so the moment it happens. "" while within the cap.
 *
 * @param {number} selected how many recipients are selected.
 * @returns {string} the over-cap message, or "" when the selection is sendable (cap-wise).
 */
export function selectionCapMessage(selected) {
  const n = Number(selected) || 0;
  if (n <= MAX_RECIPIENTS) return "";
  return `${n} selected — a single broadcast can send to at most ${MAX_RECIPIENTS} recipients. `
    + "Unselect some (or narrow the filter and reselect) before sending.";
}

/**
 * The compose-panel coverage warning for a PARTIAL fetch (a page failed mid-walk, or the runaway
 * guard tripped): tells the admin exactly how many accounts are loaded vs the server's total, and
 * that select-all only reaches the loaded ones. On a complete fetch the caller shows nothing —
 * coverage is whole, there is no ceiling left to warn about (TM-370).
 *
 * @param {number} loaded how many accounts the console actually holds.
 * @param {number} total the server-reported account total (may equal `loaded` when unknown).
 * @returns {string}
 */
export function coverageNote(loaded, total) {
  const l = Math.max(0, Number(loaded) || 0);
  const t = Math.max(l, Number(total) || 0);
  const reach = "“Select all matching” only covers the loaded accounts — refresh to retry loading the rest.";
  if (t > l) return `Loaded ${l} of ${t} accounts. ${reach}`;
  return `Loaded the first ${l} accounts — more may exist. ${reach}`;
}
