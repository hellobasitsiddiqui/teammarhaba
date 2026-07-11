// Pure, framework-free pricing/checkout logic for the membership feature (TM-479, epic
// group-membership / contract TM-457). No DOM, no fetch, no browser globals at module scope, so
// Node's test runner can import it directly — the SAME split the rest of the web app already uses
// (events-core.js ↔ events.js, event-form.js ↔ admin-events.js, notification-panel-core.js ↔
// notification-panel.js). It has to be a separate module because the DOM view (membership-checkout.js)
// statically imports api.js, which transitively imports the Firebase SDK from a gstatic CDN URL that
// `node --test web/tools/*.test.mjs` cannot load; keeping this logic here makes it unit-testable while
// the view stays a thin, browser-only shell.
//
// WHAT LIVES HERE (all pure functions of their inputs):
//   • resolvePriceState(): (MembershipResponse, event) → the single price state the checkout screen
//     renders — one of Free / Included / £5 (or the premium price) to Pay (AC 1), derived from the
//     caller's membership tier + first-event credit and the event's price/premium fields (TM-475:
//     `pricePence` in minor units GBP, `premium` boolean). Since TM-618 it never returns the reserved
//     UPGRADE state: a Monthly member on a premium event PAYs the premium price, matching the backend;
//   • checkoutPayload(): (event, priceState) → the request body the RSVP/checkout action sends — a
//     no-charge confirm for Free/Included, a charge for Pay, an upgrade intent for Upgrade (AC 2);
//   • formatPrice(): pence (minor units) → a "£5" / "£2.50" display string, the house money convention
//     (integer pence, exact, maps 1:1 onto what a payment provider charges — TM-475);
//   • normalizeTier(): a defensive tier reader that defaults unknown/missing values to PAY_PER_EVENT
//     (the JIT-enrolled default in the TM-457 contract), so a partial/absent MembershipResponse never
//     throws.

/**
 * The three membership tiers from the TM-457 contract. PAY_PER_EVENT is the default a caller is
 * JIT-enrolled onto on first read; MONTHLY covers standard events; DIAMOND covers everything
 * (including premium events).
 */
export const TIER = Object.freeze({
  PAY_PER_EVENT: "PAY_PER_EVENT",
  MONTHLY: "MONTHLY",
  DIAMOND: "DIAMOND",
});

/**
 * The default ticket price in pence when an event does not carry an explicit one — £5.00 = 500.
 * Mirrors the backend `Event.DEFAULT_PRICE_PENCE` / migration V22 `price_pence DEFAULT 500`, so the
 * client shows the same fallback the server would apply.
 */
export const DEFAULT_PRICE_PENCE = 500;

/**
 * The kind of price state resolvePriceState() returns — what the caller ultimately pays for THIS
 * event. Drives the badge copy and colour; distinct from CHECKOUT_MODE (which drives the action).
 */
export const PRICE_KIND = Object.freeze({
  FREE: "FREE", // no charge — the event is free, or their first-event credit covers it
  INCLUDED: "INCLUDED", // no charge — their membership tier already covers it
  PAY: "PAY", // must pay the event's price (£5 default, or the premium price)
  // Reserved contract value only — since TM-618 no resolvePriceState branch produces UPGRADE (a Monthly
  // member on a premium event now PAYs the premium price, matching the TM-476 backend, which likewise
  // yields no UPGRADE). Kept for wire/contract compatibility, mirroring the backend EntitlementDecision.
  UPGRADE: "UPGRADE",
});

/**
 * How the RSVP → checkout step behaves for a given price state (AC 2):
 *   • CONFIRM — Free / Included: a single confirm, no payment;
 *   • PAY     — a card step (wired to the Revolut widget in TM-478; a disabled "coming soon" mount
 *               point until then);
 *   • UPGRADE — reserved: send the user to membership/tier management to upgrade before they can attend.
 *               No resolvePriceState result carries this mode since TM-618 (Monthly-on-premium now PAYs,
 *               matching the backend), so checkoutPayload keeps the branch only for contract compatibility.
 */
export const CHECKOUT_MODE = Object.freeze({
  CONFIRM: "CONFIRM",
  PAY: "PAY",
  UPGRADE: "UPGRADE",
});

/**
 * Read a tier value defensively. Trims/upper-cases a string and only accepts the known tiers;
 * anything else (undefined, null, a typo, a future tier this build doesn't know) falls back to
 * PAY_PER_EVENT — the safe default that charges per event rather than accidentally granting access.
 * @param {unknown} tier
 * @returns {string} one of TIER.*
 */
export function normalizeTier(tier) {
  const t = typeof tier === "string" ? tier.trim().toUpperCase() : "";
  return t === TIER.MONTHLY || t === TIER.DIAMOND ? t : TIER.PAY_PER_EVENT;
}

/**
 * Normalize an event's `pricePence` to a non-negative integer. A missing/invalid/negative value
 * falls back to the £5 default (mirroring the DB backstop), so the UI is always well-defined; an
 * explicit 0 is preserved (a genuinely free event).
 * @param {unknown} value
 * @returns {number} pence, integer ≥ 0
 */
function normalizePence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PRICE_PENCE;
  return Math.round(n);
}

/**
 * Format a price in pence (minor units, GBP) as a short display string. Whole pounds render without
 * decimals ("£5"), part-pounds to two places ("£2.50"). Defensive: a non-finite/negative input
 * formats as "£0" rather than throwing.
 * @param {number} pence
 * @returns {string}
 */
export function formatPrice(pence) {
  const n = Number(pence);
  const safe = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const pounds = safe / 100;
  return `£${safe % 100 === 0 ? String(pounds) : pounds.toFixed(2)}`;
}

/** Build a frozen price-state record (the single return shape of resolvePriceState). */
function priceState(kind, label, detail, amountPence, checkout) {
  return Object.freeze({ kind, label, detail, amountPence, checkout });
}

/**
 * Resolve what an event costs THIS caller, and how checkout should behave — the heart of AC 1/2.
 *
 * Precedence (first match wins):
 *   1. A genuinely free event (admin priced it at £0) — free for everyone, consumes no credit.
 *   2. Tier coverage → "Included": Diamond covers every event; Monthly covers standard (non-premium).
 *   3. A pay-per-event caller whose first-event credit is still available, on a STANDARD event → "Free"
 *      (their first is on us). Premium events are NEVER free (product decision 2026-07-10): the credit is
 *      standard-only, so a credit + a premium event skips this and falls through to Pay — matching the
 *      authoritative TM-476 backend resolver (EntitlementResolver).
 *   4. Otherwise → "Pay" the event's price (£5 default, or the premium price the admin set). This covers
 *      pay-per-event with no credit AND — since TM-618 — a MONTHLY member on a PREMIUM event: Monthly does
 *      not cover premium, so they PAY the premium price rather than being shown "Upgrade to attend". That
 *      matches the backend EntitlementResolver rule "any tier below Diamond PAYs for a premium event", so
 *      the checkout screen and the server can never disagree. No branch yields UPGRADE any more (the
 *      backend produces none either); UPGRADE stays a reserved contract value only.
 *
 * @param {{tier?: string, firstEventCreditAvailable?: boolean}} [membership] the MembershipResponse
 *   from GET /api/v1/me/membership (TM-474). Read defensively — a partial/absent object is treated as
 *   a fresh PAY_PER_EVENT caller with no credit.
 * @param {{id?: (string|number), pricePence?: number, premium?: boolean}} [event] the event's
 *   price/premium fields (TM-475 EventResponse).
 * @returns {{kind: string, label: string, detail: string, amountPence: (number|null), checkout: string}}
 */
export function resolvePriceState(membership, event) {
  const tier = normalizeTier(membership?.tier);
  const creditAvailable = Boolean(membership?.firstEventCreditAvailable);
  const premium = Boolean(event?.premium);
  const pricePence = normalizePence(event?.pricePence);

  // 1. Genuinely free event (£0) — free for anyone, no credit consumed, a simple confirm.
  if (pricePence === 0) {
    return priceState(PRICE_KIND.FREE, "Free", "This event is free to attend.", null, CHECKOUT_MODE.CONFIRM);
  }

  // 2. Tier coverage → "Included" (no charge).
  if (tier === TIER.DIAMOND) {
    return priceState(
      PRICE_KIND.INCLUDED,
      "Included",
      "Included with your Diamond membership.",
      null,
      CHECKOUT_MODE.CONFIRM,
    );
  }
  if (tier === TIER.MONTHLY && !premium) {
    return priceState(
      PRICE_KIND.INCLUDED,
      "Included",
      "Included with your Monthly membership.",
      null,
      CHECKOUT_MODE.CONFIRM,
    );
  }

  // A MONTHLY member on a PREMIUM event is intentionally NOT handled here: before TM-618 this branch
  // returned "Upgrade to attend", but the authoritative TM-476 backend EntitlementResolver maps any tier
  // below Diamond on a premium event to PAY the premium price (product decision 2026-07-10). We therefore
  // let a Monthly-on-premium caller fall through to the Pay branch below so the client charge matches what
  // the backend would charge; the `&& !premium` guard on the credit branch keeps that from short-circuiting
  // to Free. No branch produces UPGRADE any more — it mirrors the backend, which yields none either.

  // 3. Pay-per-event with a first-event credit still available, on a STANDARD event → their first event
  // is on us. Premium events are NEVER free (product decision 2026-07-10): the first-event credit is
  // standard-only and does NOT apply to a premium event, so the `&& !premium` guard makes a credit-holding
  // caller on a PREMIUM event fall through to the Pay branch below (the admin-set premium price) rather
  // than being shown Free. This aligns the client display with the authoritative TM-476 backend resolver
  // (EntitlementResolver: any tier below Diamond PAYs for a premium event; the credit is neither applied
  // nor consumed), so the checkout screen and the server can never disagree.
  if (creditAvailable && !premium) {
    return priceState(PRICE_KIND.FREE, "Free", "Your first event is on us.", null, CHECKOUT_MODE.CONFIRM);
  }

  // 4. Pay the event's price (£5 default, or the premium price). Reached by a pay-per-event caller with no
  // credit AND by a MONTHLY member on a premium event (Monthly does not cover premium — see the note above).
  return priceState(
    PRICE_KIND.PAY,
    formatPrice(pricePence),
    premium ? "Premium event." : "Pay to attend.",
    pricePence,
    CHECKOUT_MODE.PAY,
  );
}

/**
 * Build the request body the RSVP/checkout action sends for a resolved price state (AC 2). Kept pure
 * and separate from the network call so it is unit-testable and so the future payment wiring (TM-478)
 * has one canonical payload shape to send.
 *   • CONFIRM (Free / Included) → a no-charge RSVP;
 *   • PAY                        → an RSVP that must be paid for, carrying the exact charge in pence;
 *   • UPGRADE                    → an upgrade intent (no event charge — routed to tier management).
 * @param {{id?: (string|number)}} [event]
 * @param {{checkout?: string, amountPence?: (number|null)}} [state] a resolvePriceState() result.
 * @returns {object} the checkout payload.
 */
export function checkoutPayload(event, state) {
  const eventId = event?.id ?? null;
  const mode = state?.checkout;
  if (mode === CHECKOUT_MODE.PAY) {
    return { eventId, action: "PAY", chargePence: state?.amountPence ?? 0, currency: "GBP" };
  }
  if (mode === CHECKOUT_MODE.UPGRADE) {
    return { action: "UPGRADE" };
  }
  // CONFIRM (Free / Included): a no-charge RSVP.
  return { eventId, action: "RSVP", chargePence: 0 };
}

// --- Cardholder name (TM-639) ----------------------------------------------------------------------

/**
 * The inline hint shown when the "Name on card" field fails validation (TM-639). Kept here so BOTH
 * payment views — the per-event checkout (membership-checkout.js) and the Subscribe checkout
 * (membership-subscribe.js) — show the exact same copy, and the tests assert against one source of truth.
 */
export const CARDHOLDER_NAME_HINT = "Enter the full name on the card (first and last).";

/**
 * Split a cardholder name into its non-empty, whitespace-separated words. The shared primitive behind
 * {@link isValidCardholderName} and {@link normalizeCardholderName}: trims the ends, splits on ANY run
 * of whitespace (spaces, tabs), and drops empty parts so runs of whitespace never count as words.
 * @param {unknown} name
 * @returns {string[]}
 */
function cardholderNameWords(name) {
  if (typeof name !== "string") return [];
  return name.trim().split(/\s+/).filter(Boolean);
}

/**
 * Is a cardholder name acceptable to Revolut? The Revolut card field rejects the charge with
 * "Cardholder name must be at least two words" unless the name on the card is at least a first AND a
 * last name (TM-639). We enforce the SAME rule client-side so an invalid name is never sent to Revolut:
 * the trimmed value must contain at least TWO whitespace-separated words. A single word, a blank string,
 * or a non-string all fail.
 * @param {unknown} name the raw value of the "Name on card" input.
 * @returns {boolean} true iff the name has two or more words.
 */
export function isValidCardholderName(name) {
  return cardholderNameWords(name).length >= 2;
}

/**
 * Collapse a cardholder name to one tidy line before it is SENT to Revolut — trim the ends and squeeze
 * every internal run of whitespace to a single space ("  John   Smith " → "John Smith"). Independent of
 * {@link isValidCardholderName}: a one-word input normalises to itself (the view validates first, so a
 * value this returns has already been checked).
 * @param {unknown} name
 * @returns {string} the normalised name, or "" for a non-string / blank input.
 */
export function normalizeCardholderName(name) {
  return cardholderNameWords(name).join(" ");
}

// --- Card submit lifecycle + stuck backstop (TM-642) -----------------------------------------------
//
// THE BUG: on the checkout, a card that Revolut rejects or declines CLIENT-side sometimes makes
// `cardField.submit()` call NEITHER `onSuccess` NOR `onError` — and there is no timeout. The Pay /
// Subscribe button had been disabled and the status set to "Processing payment…" the instant we
// submitted, so with no callback it stays disabled saying "Processing payment…" forever: no feedback,
// no retry (found in the payment e2e — a non-Revolut card number left it permanently stuck).
//
// THE FIX (this pure core + the two view wirings): model one card submit as a tiny state machine —
//   IDLE → (submit) → PENDING → (first of success | error | timeout) → a terminal state —
// and arm a client-side TIMEOUT backstop when we enter PENDING. If neither callback fires within the
// window the timeout settles the attempt to a RETRYABLE state, so the view can clear "Processing
// payment…", re-enable the button and show a "try again" hint. Everything that decides transitions +
// which state re-enables the button lives HERE (DOM-free, node-tested); the views only own the DOM
// effects + the real timer. The machine is also the double-fire GUARD the ticket asks for: once an
// attempt has settled, a LATE callback from that same attempt is a no-op (see the precedence note on
// nextPaymentSubmitState), so a success that arrives after the timeout can't clobber the shown error.

/**
 * The retryable copy shown when a card submit gets STUCK — the client-side timeout elapsed with no
 * onSuccess/onError from the widget (TM-642). Shared by BOTH payment views (per-event checkout +
 * Subscribe) so the wording is identical and the tests assert one source of truth. Deliberately blames
 * the card details (the overwhelmingly likely cause of a rejected/declined submit) and invites a retry.
 */
export const PAYMENT_STUCK_HINT = "Payment didn't go through — check your card details and try again.";

/**
 * How long the view waits for a submit callback before declaring the attempt stuck (TM-642). 30s is
 * comfortably longer than a real Revolut round-trip (incl. the 3DS/SCA challenge) yet short enough that
 * a user is not left staring at "Processing payment…" indefinitely. The views inject the real timer;
 * this is the default window.
 */
export const PAYMENT_SUBMIT_TIMEOUT_MS = 30000;

/**
 * The states one card submit moves through (TM-642):
 *   • IDLE     — nothing submitted yet;
 *   • PENDING  — submit() called; awaiting onSuccess / onError / the timeout backstop (button disabled);
 *   • SUCCESS  — onSuccess fired first — terminal and LOCKED (a payment is never "un-succeeded");
 *   • ERROR    — onError fired first — terminal, RETRYABLE (re-enable the button so the user can retry);
 *   • TIMEOUT  — neither callback fired within the window — terminal, RETRYABLE (the stuck-state fix).
 * ERROR and TIMEOUT are the two retryable terminals; SUCCESS is the one non-retryable terminal.
 */
export const PAYMENT_SUBMIT_STATE = Object.freeze({
  IDLE: "IDLE",
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
  TIMEOUT: "TIMEOUT",
});

/** The lifecycle events that drive {@link nextPaymentSubmitState}. */
export const PAYMENT_SUBMIT_EVENT = Object.freeze({
  SUBMIT: "SUBMIT", // the user pressed Pay/Subscribe and we called cardField.submit()
  SUCCESS: "SUCCESS", // the widget's onSuccess fired
  ERROR: "ERROR", // the widget's onError fired
  TIMEOUT: "TIMEOUT", // our client-side backstop elapsed with no callback
});

/** The terminal states — an attempt in one of these has settled. */
const SETTLED_STATES = new Set([
  PAYMENT_SUBMIT_STATE.SUCCESS,
  PAYMENT_SUBMIT_STATE.ERROR,
  PAYMENT_SUBMIT_STATE.TIMEOUT,
]);

/** The retryable terminals — settled, but the button should re-enable so the user can try again. */
const RETRYABLE_STATES = new Set([PAYMENT_SUBMIT_STATE.ERROR, PAYMENT_SUBMIT_STATE.TIMEOUT]);

/** Has this submit reached a terminal state (success / error / timeout)? */
export function isPaymentSettled(state) {
  return SETTLED_STATES.has(state);
}

/** Is this a settled state the user can retry from (error / timeout — NOT success)? */
export function isPaymentRetryable(state) {
  return RETRYABLE_STATES.has(state);
}

/** Is a submit currently in flight (button should stay disabled)? */
export function isPaymentPending(state) {
  return state === PAYMENT_SUBMIT_STATE.PENDING;
}

/**
 * The pure transition function for one card submit (TM-642) — `(current, event) → next`. It is the
 * single place the "who wins" precedence is decided, so it can be exhaustively unit-tested without a
 * DOM or a timer:
 *
 *   • from IDLE:        SUBMIT → PENDING; a stray callback before any submit is ignored (stays IDLE).
 *   • from PENDING:     the FIRST of SUCCESS / ERROR / TIMEOUT wins and becomes the terminal state;
 *                       a redundant SUBMIT stays PENDING (the button already guards double-clicks).
 *   • from SUCCESS:     LOCKED — a payment is never un-succeeded, so a late ERROR/TIMEOUT is ignored,
 *                       and SUBMIT does NOT restart (there is nothing left to pay).
 *   • from ERROR/TIMEOUT (the retryable terminals): a fresh SUBMIT (the user pressing the re-enabled
 *                       button) starts a NEW attempt → PENDING; but a LATE SUCCESS/ERROR/TIMEOUT from
 *                       the ORIGINAL, already-settled attempt is IGNORED.
 *
 * THE CHOSEN PRECEDENCE (TM-642): the FIRST terminal event of an attempt wins; later callbacks from
 * that same attempt are no-ops. In particular a SUCCESS that arrives AFTER a TIMEOUT does NOT override
 * the shown "try again" error — we have already told the user it did not go through and re-enabled the
 * button (they may even have retried), so silently flipping to success would be more confusing than the
 * honest, server-authoritative outcome (the payment webhook is the real source of truth; the next
 * screen visit reflects any charge that actually landed). Only the user pressing Pay again (a SUBMIT)
 * moves a retryable terminal onward.
 *
 * @param {string} current a PAYMENT_SUBMIT_STATE value (an unknown value is treated as IDLE).
 * @param {string} event a PAYMENT_SUBMIT_EVENT value.
 * @returns {string} the next PAYMENT_SUBMIT_STATE.
 */
export function nextPaymentSubmitState(current, event) {
  const state =
    current === PAYMENT_SUBMIT_STATE.PENDING || SETTLED_STATES.has(current) ? current : PAYMENT_SUBMIT_STATE.IDLE;

  switch (event) {
    case PAYMENT_SUBMIT_EVENT.SUBMIT:
      // A locked SUCCESS never re-submits; every other state (IDLE, PENDING, or a retryable terminal)
      // (re)enters PENDING — the retry path for ERROR/TIMEOUT.
      return state === PAYMENT_SUBMIT_STATE.SUCCESS ? state : PAYMENT_SUBMIT_STATE.PENDING;
    case PAYMENT_SUBMIT_EVENT.SUCCESS:
      // Only an in-flight (PENDING) attempt can succeed. A success after we already settled is ignored.
      return state === PAYMENT_SUBMIT_STATE.PENDING ? PAYMENT_SUBMIT_STATE.SUCCESS : state;
    case PAYMENT_SUBMIT_EVENT.ERROR:
      return state === PAYMENT_SUBMIT_STATE.PENDING ? PAYMENT_SUBMIT_STATE.ERROR : state;
    case PAYMENT_SUBMIT_EVENT.TIMEOUT:
      return state === PAYMENT_SUBMIT_STATE.PENDING ? PAYMENT_SUBMIT_STATE.TIMEOUT : state;
    default:
      return state;
  }
}

/**
 * Build the stateful controller both payment views drive one card submit through (TM-642). It owns the
 * {@link nextPaymentSubmitState} machine PLUS the client-side timeout backstop, but stays DOM-free and
 * node-testable by taking its timer + its state-change sink as injected dependencies — the same
 * dependency-injection seam createRevolutSdkLoader uses. The view constructs one with the real
 * setTimeout/clearTimeout + an `onChange` that applies the DOM effects; the unit tests construct one
 * with a fake timer + a recording sink.
 *
 * `onChange(state, detail)` fires exactly once per REAL transition (never for an ignored late callback),
 * so the view can react per state: PENDING → "Processing payment…" + disable; SUCCESS → the paid/activate
 * effect; ERROR → show the decline reason + re-enable; TIMEOUT → show PAYMENT_STUCK_HINT + re-enable. The
 * `detail` is passed straight through (e.g. the onError message).
 *
 * @param {{setTimer?: (fn: Function, ms: number) => *, clearTimer?: (handle: *) => void,
 *   timeoutMs?: number, onChange?: (state: string, detail?: unknown) => void}} [deps]
 * @returns {{getState: () => string, begin: () => boolean, success: (d?: unknown) => (string|null),
 *   error: (d?: unknown) => (string|null), timeout: (d?: unknown) => (string|null)}}
 */
export function createCardSubmitController({ setTimer, clearTimer, timeoutMs = PAYMENT_SUBMIT_TIMEOUT_MS, onChange } = {}) {
  let state = PAYMENT_SUBMIT_STATE.IDLE;
  let handle = null;
  const emit = typeof onChange === "function" ? onChange : () => {};

  // Cancel the backstop timer if one is armed. Safe to call when there is none.
  const cancelTimer = () => {
    if (handle != null && typeof clearTimer === "function") clearTimer(handle);
    handle = null;
  };

  // Apply one lifecycle event. Returns the NEW state when the event actually moved the machine (the
  // caller/emit then reacts), or null when it was a no-op — a stray/late callback after the attempt
  // already settled, which must be swallowed so a late onSuccess/onError can't double-fire (TM-642).
  function apply(event, detail) {
    const next = nextPaymentSubmitState(state, event);
    if (next === state) return null; // ignored: nothing changed (the double-fire guard)
    state = next;
    if (next !== PAYMENT_SUBMIT_STATE.PENDING) cancelTimer(); // settled → the backstop is no longer needed
    emit(next, detail);
    return next;
  }

  return {
    /** The current PAYMENT_SUBMIT_STATE. */
    getState: () => state,
    /**
     * Start (or retry) a submit: move to PENDING and arm the timeout backstop. Returns false ONLY when
     * the attempt already succeeded (locked) so the caller must not submit again; true otherwise.
     */
    begin() {
      apply(PAYMENT_SUBMIT_EVENT.SUBMIT);
      if (state !== PAYMENT_SUBMIT_STATE.PENDING) return false; // locked at SUCCESS — nothing to submit
      cancelTimer();
      if (typeof setTimer === "function") {
        handle = setTimer(() => apply(PAYMENT_SUBMIT_EVENT.TIMEOUT), timeoutMs);
      }
      return true;
    },
    /** Feed the widget's onSuccess. No-op (returns null) if the attempt already settled. */
    success(detail) {
      return apply(PAYMENT_SUBMIT_EVENT.SUCCESS, detail);
    },
    /** Feed the widget's onError. No-op (returns null) if the attempt already settled. */
    error(detail) {
      return apply(PAYMENT_SUBMIT_EVENT.ERROR, detail);
    },
    /** Fire the backstop manually (the injected timer normally does this). No-op once settled. */
    timeout(detail) {
      return apply(PAYMENT_SUBMIT_EVENT.TIMEOUT, detail);
    },
  };
}

// --- Card-field inline validation feedback (TM-642) ------------------------------------------------

/** The generic inline hint when the card field reports an unspecified validation problem (TM-642). */
export const CARD_VALIDATION_HINT = "Check your card number, expiry and CVC.";

/** Best-effort: pull a human message out of the first entry of a Revolut validation-error array. */
function firstCardValidationMessage(errors) {
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (typeof first === "string" && first.trim()) return first.trim();
  if (first && typeof first === "object") {
    for (const key of ["message", "text", "type"]) {
      if (typeof first[key] === "string" && first[key].trim()) return first[key].trim();
    }
  }
  return null;
}

/**
 * Defensively interpret whatever Revolut's `createCardField` `onValidation` hands us into a simple
 * `{ valid, message }` verdict (TM-642). The callback name/shape is NOT guaranteed across embed.js
 * versions, so this reads the common shapes and — crucially — treats anything it can't understand as
 * VALID (no verdict), so an unknown payload never wrongly blocks the user: the timeout backstop remains
 * the guaranteed safety net. `valid` is FALSE only when we can clearly see an error; `message` is a
 * short inline hint when invalid, else null.
 *
 * Shapes handled: an array of errors (empty = valid); `{ errors: [...] }`; `{ valid: boolean, message? }`;
 * `{ message: string }`; a bare boolean validity. Everything else → valid, no message.
 * @param {unknown} payload the argument onValidation was called with.
 * @returns {{valid: boolean, message: (string|null)}}
 */
export function summarizeCardValidation(payload) {
  if (Array.isArray(payload)) {
    return payload.length === 0
      ? { valid: true, message: null }
      : { valid: false, message: firstCardValidationMessage(payload) || CARD_VALIDATION_HINT };
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.errors)) {
      return payload.errors.length === 0
        ? { valid: true, message: null }
        : { valid: false, message: firstCardValidationMessage(payload.errors) || CARD_VALIDATION_HINT };
    }
    if (typeof payload.valid === "boolean") {
      if (payload.valid) return { valid: true, message: null };
      const own = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : null;
      return { valid: false, message: own || CARD_VALIDATION_HINT };
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return { valid: false, message: payload.message.trim() };
    }
  }
  if (typeof payload === "boolean") {
    return { valid: payload, message: payload ? null : CARD_VALIDATION_HINT };
  }
  // Unknown / absent → no verdict; never block (the timeout is the guaranteed backstop).
  return { valid: true, message: null };
}

// --- Revolut SDK loader (TM-629) -------------------------------------------------------------------

/**
 * Build the memoised Revolut checkout SDK loader both payment screens share (the per-event checkout in
 * membership-checkout.js and the TM-620 subscribe screen). The DOM view constructs ONE loader with the
 * real `window`/`document`/config reads injected; the unit tests construct it with fakes — the same
 * dependency-injection seam the other cores use, because the DOM view itself statically imports api.js
 * (→ the Firebase CDN) and can never be loaded under `node --test`.
 *
 * Memoisation contract (the TM-629 regression this encodes):
 *   • a load already IN FLIGHT is shared — concurrent pay attempts inject exactly one <script>;
 *   • the resolved global short-circuits — once the SDK is present no further script is injected;
 *   • a REJECTION is NEVER memoised. The original implementation only cleared the memo in
 *     `script.onerror`, so the two other failure paths — a missing/unconfigured script URL, and a
 *     script that loads without exposing `RevolutCheckout` — left the REJECTED promise cached: every
 *     later payment attempt (both screens share this loader) instantly re-rejected with the stale
 *     error until a full page reload. "Try again" could never succeed. Every failure path now leaves
 *     the loader ready to retry.
 *
 * @param {{getGlobal?: () => (object|undefined), getDocument?: () => (object|undefined),
 *   getScriptUrl?: () => (string|undefined)}} deps injected reads: the global that carries
 *   `RevolutCheckout`, the document to inject the <script> into, and the configured SDK URL.
 * @returns {() => Promise<Function>} the shared load() function.
 */
export function createRevolutSdkLoader({ getGlobal, getDocument, getScriptUrl } = {}) {
  // The one in-flight load promise, shared across callers. Null whenever there is nothing pending —
  // including after ANY failure, so the next attempt retries instead of replaying a stale rejection.
  let pending = null;

  return function load() {
    const globalObj = typeof getGlobal === "function" ? getGlobal() : undefined;
    // Already available (a previous load resolved, or the page embedded it) — no script needed.
    if (globalObj && typeof globalObj.RevolutCheckout === "function") {
      return Promise.resolve(globalObj.RevolutCheckout);
    }
    // A load is already in flight — share it rather than injecting a second <script>.
    if (pending) return pending;

    // Resolve the injection prerequisites BEFORE creating (and memoising) the promise: rejecting
    // synchronously without ever touching `pending` is what keeps a config-shaped failure retryable
    // (the config may be populated by the time the user tries again).
    const src = typeof getScriptUrl === "function" ? getScriptUrl() : undefined;
    const doc = typeof getDocument === "function" ? getDocument() : undefined;
    if (!src || !doc) {
      return Promise.reject(new Error("Revolut checkout SDK is not configured."));
    }

    pending = new Promise((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        const now = typeof getGlobal === "function" ? getGlobal() : undefined;
        if (now && typeof now.RevolutCheckout === "function") {
          resolve(now.RevolutCheckout);
          return;
        }
        pending = null; // loaded but unusable — allow a retry (never memoise the rejection)
        reject(new Error("Revolut checkout SDK loaded but RevolutCheckout is unavailable."));
      };
      script.onerror = () => {
        pending = null; // transient CDN failure — allow a retry
        reject(new Error("Could not load the Revolut checkout SDK."));
      };
      doc.head.appendChild(script);
    });
    return pending;
  };
}
