// Pure, framework-free subscription logic for the membership feature (TM-620, epic group-membership).
// No DOM, no fetch, no browser globals at module scope, so Node's test runner can import it directly —
// the SAME core/view split the rest of the web app uses (membership-checkout-core.js ↔
// membership-checkout.js). The DOM shell lives in membership-subscribe.js; the tier screen
// (membership-tier.js) also imports these helpers so the two screens can never disagree on a price or
// a subscription state.
//
// WHAT LIVES HERE (all pure functions of their inputs):
//   • SUBSCRIPTION_PRICE_PENCE / subscriptionPricePence(): the LOCKED monthly prices (product decision
//     2026-07-10: MONTHLY £9.99, DIAMOND £19.99) — a client-side mirror of the backend
//     SubscriptionPricing table, display-only (the server prices the actual charge);
//   • normalizeSubscription(): defensive reader for the GET /me/subscription response — a partial /
//     absent / error payload collapses to the safe none-state, so the screens never throw;
//   • describeSubscription(): subscription → the manage-panel view model (status label + renewal line
//     + whether Cancel applies) — the single source for the "Renews on …" / "Ends on …" copy;
//   • subscribeRoute()/tierFromSubscribeRoute(): the #/membership/subscribe/{TIER} route helpers shared
//     by the tier screen (links), the subscribe screen (parse) and router.js (predicate);
//   • formatChargeDate(): ISO instant → a short human date for renewal/end copy.

import { formatPrice } from "./membership-checkout-core.js";

/** The subscribable paid tiers (the free base has nothing to subscribe to). */
export const PAID_TIERS = Object.freeze(["MONTHLY", "DIAMOND"]);

/**
 * The locked monthly prices in pence (minor units, GBP) — the client mirror of the backend
 * `SubscriptionPricing` (TM-620, product decision 2026-07-10). Display-only: the server resolves the
 * real charge from its own table, so a tampered client can never change what is billed.
 */
export const SUBSCRIPTION_PRICE_PENCE = Object.freeze({
  MONTHLY: 999,
  DIAMOND: 1999,
});

/** The subscription statuses the backend contract defines (TM-620). */
export const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELED: "CANCELED",
});

/**
 * The monthly price of a paid tier in pence, or null for anything unknown/free — callers branch on
 * null rather than rendering "£NaN".
 * @param {unknown} tier
 * @returns {number|null}
 */
export function subscriptionPricePence(tier) {
  const t = typeof tier === "string" ? tier.trim().toUpperCase() : "";
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PRICE_PENCE, t) ? SUBSCRIPTION_PRICE_PENCE[t] : null;
}

/** "£9.99/month" — the price line both screens show for a paid tier; null when the tier has no price. */
export function subscriptionPriceLabel(tier) {
  const pence = subscriptionPricePence(tier);
  return pence == null ? null : `${formatPrice(pence)}/month`;
}

/**
 * Coerce a possibly-partial/invalid GET /me/subscription response to a safe shape. Anything that isn't
 * a well-formed subscribed payload collapses to the none-state `{ subscribed: false }` — the screens
 * then render the "not subscribed" view rather than throwing on a stale cache or an error body.
 * @param {unknown} resp
 * @returns {{subscribed: boolean, tier: string|null, status: string|null, currentPeriodStart: string|null,
 *   currentPeriodEnd: string|null, renewing: boolean, amountPence: number|null}}
 */
export function normalizeSubscription(resp) {
  const none = {
    subscribed: false,
    tier: null,
    status: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    renewing: false,
    amountPence: null,
  };
  if (!resp || typeof resp !== "object" || resp.subscribed !== true) return none;
  const status =
    typeof resp.status === "string" && Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUS, resp.status)
      ? resp.status
      : null;
  const tier = typeof resp.tier === "string" && PAID_TIERS.includes(resp.tier) ? resp.tier : null;
  if (!status || !tier) return none; // a "subscribed" payload without a usable status/tier is unusable
  const amount = Number(resp.amountPence);
  return {
    subscribed: true,
    tier,
    status,
    currentPeriodStart: typeof resp.currentPeriodStart === "string" ? resp.currentPeriodStart : null,
    currentPeriodEnd: typeof resp.currentPeriodEnd === "string" ? resp.currentPeriodEnd : null,
    renewing: resp.renewing === true,
    amountPence: Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : subscriptionPricePence(tier),
  };
}

/**
 * Format an ISO instant as a short human date ("10 Aug 2026") for renewal/end copy. Defensive: an
 * unparseable/absent value returns null so callers fall back to date-less copy rather than "Invalid Date".
 * @param {unknown} iso
 * @returns {string|null}
 */
export function formatChargeDate(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Build the manage-subscription view model (TM-620) — everything the panel renders, resolved in one
 * pure place so the "Renews on …" / "Ends on …" / dunning copy can be exhaustively unit-tested:
 *   • ACTIVE    → "Active", renews on the period end, Cancel offered;
 *   • PAST_DUE  → payment-problem copy (dunning is retrying), Cancel still offered (tier is kept);
 *   • CANCELED  → "Cancelled", access until the period end, no Cancel (already done);
 *   • none      → not subscribed, no panel actions.
 * @param {unknown} resp a GET /me/subscription response (raw — normalised here).
 * @returns {{subscribed: boolean, tier: string|null, statusLabel: string|null, renewalLine: string|null,
 *   priceLine: string|null, canCancel: boolean, paymentProblem: boolean}}
 */
export function describeSubscription(resp) {
  const sub = normalizeSubscription(resp);
  if (!sub.subscribed) {
    return {
      subscribed: false,
      tier: null,
      statusLabel: null,
      renewalLine: null,
      priceLine: null,
      canCancel: false,
      paymentProblem: false,
    };
  }
  const endDate = formatChargeDate(sub.currentPeriodEnd);
  let statusLabel;
  let renewalLine;
  let paymentProblem = false;
  switch (sub.status) {
    case SUBSCRIPTION_STATUS.PAST_DUE:
      statusLabel = "Payment problem";
      renewalLine = "We couldn't take your last payment — we'll retry over the next few days.";
      paymentProblem = true;
      break;
    case SUBSCRIPTION_STATUS.CANCELED:
      statusLabel = "Cancelled";
      renewalLine = endDate ? `Your membership ends on ${endDate}.` : "Your membership ends at the period end.";
      break;
    case SUBSCRIPTION_STATUS.ACTIVE:
    default:
      statusLabel = "Active";
      renewalLine = endDate ? `Renews on ${endDate}.` : "Renews monthly.";
      break;
  }
  return {
    subscribed: true,
    tier: sub.tier,
    statusLabel,
    renewalLine,
    priceLine: subscriptionPriceLabel(sub.tier),
    // Cancel applies while renewals still run (ACTIVE or dunning); a cancelled sub is already done.
    canCancel: sub.status !== SUBSCRIPTION_STATUS.CANCELED,
    paymentProblem,
  };
}

// --- Subscribe route helpers ----------------------------------------------------------------------

/** The subscribe checkout route prefix. The full route is `#/membership/subscribe/{TIER}`. */
export const SUBSCRIBE_ROUTE_PREFIX = "#/membership/subscribe";

/** The subscribe route for a paid tier — what the tier screen's Subscribe buttons link to. */
export function subscribeRoute(tier) {
  return `${SUBSCRIBE_ROUTE_PREFIX}/${tier}`;
}

/**
 * Parse the tier out of a subscribe route hash. `#/membership/subscribe/MONTHLY` → "MONTHLY";
 * a bare `#/membership/subscribe` defaults to MONTHLY (a sensible landing); anything else → null
 * (not a subscribe route at all — router.js uses null-ness as the route predicate).
 * @param {unknown} hash
 * @returns {"MONTHLY"|"DIAMOND"|null}
 */
export function tierFromSubscribeRoute(hash) {
  if (typeof hash !== "string") return null;
  if (hash === SUBSCRIBE_ROUTE_PREFIX) return "MONTHLY";
  if (!hash.startsWith(`${SUBSCRIBE_ROUTE_PREFIX}/`)) return null;
  const tier = hash.slice(SUBSCRIBE_ROUTE_PREFIX.length + 1).toUpperCase();
  return PAID_TIERS.includes(tier) ? tier : null;
}

// --- Post-payment activation (TM-629) ---------------------------------------------------------------

/**
 * Has the webhook-driven activation actually landed for `tier`? The subscribe screen polls
 * GET /me/subscription after a successful first charge, and this is the predicate one poll tick
 * evaluates.
 *
 * The TM-629 regression this encodes: the old check was `subscribed && tier === tier`, which a
 * re-subscriber's STALE row satisfies immediately — a CANCELED subscription for the SAME tier still
 * reports `subscribed: true` (paid time may remain), so the very first poll declared "You're
 * subscribed!" before the webhook had activated anything; if the activation webhook then never landed
 * (e.g. a misconfigured signing secret ⇒ 401s), the user saw success for a charge that activated
 * nothing. An actually-activated subscription is one whose renewals run: ACTIVE (or dunning PAST_DUE)
 * — exactly `describeSubscription().canCancel` — never CANCELED.
 *
 * @param {unknown} resp a raw GET /me/subscription response.
 * @param {unknown} tier the paid tier the user just paid for.
 * @returns {boolean}
 */
export function subscriptionActivatedFor(resp, tier) {
  const view = describeSubscription(resp);
  return view.subscribed && view.tier === tier && view.canCancel;
}

/** How the activation poll behaves by default: the webhook usually lands within a few seconds. */
export const ACTIVATION_POLL_ATTEMPTS = 10;
export const ACTIVATION_POLL_INTERVAL_MS = 1500;

/**
 * Drive the post-payment activation poll (TM-620 screen, loop extracted here in TM-629 so it is
 * node-testable): call `fetchSubscription()` up to `attempts` times, `sleep()`ing between ticks, until
 * {@link subscriptionActivatedFor} reports the webhook-driven activation for `tier`.
 *
 * Outcomes:
 *   • "active"  — the activation landed (a genuinely ACTIVE/PAST_DUE subscription on the right tier;
 *                 a stale CANCELED same-tier row NEVER satisfies it — the TM-629 regression above);
 *   • "pending" — attempts ran out; the payment already succeeded, so the caller shows honest
 *                 "activating…" copy rather than an error;
 *   • "stale"   — `isStale()` reported the mount is gone (the user navigated away / the screen
 *                 re-mounted for another tier). The TM-629 regression this encodes: the old loop
 *                 polled on regardless and then painted "You're subscribed!" into whatever the section
 *                 held by then — the caller must render NOTHING on "stale". Checked before every fetch
 *                 and again after every sleep, so a stale mount also stops generating network reads.
 *
 * A rejected `fetchSubscription()` is a transient read failure mid-poll: tolerated, retried next tick.
 *
 * @param {{fetchSubscription: () => Promise<unknown>, tier: unknown, attempts?: number,
 *   sleep?: () => Promise<void>, isStale?: () => boolean}} opts
 * @returns {Promise<"active"|"pending"|"stale">}
 */
export async function pollSubscriptionActivation({ fetchSubscription, tier, attempts, sleep, isStale } = {}) {
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : ACTIVATION_POLL_ATTEMPTS;
  const stale = typeof isStale === "function" ? isStale : () => false;
  const rest = typeof sleep === "function" ? sleep : () => Promise.resolve();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (stale()) return "stale";
    try {
      if (subscriptionActivatedFor(await fetchSubscription(), tier)) {
        // The activation landed — but if the mount died while the read was in flight, the caller
        // must still not paint into the re-rendered/hidden section.
        return stale() ? "stale" : "active";
      }
    } catch {
      // A transient read failure mid-poll is fine — try again on the next tick.
    }
    await rest();
  }
  return stale() ? "stale" : "pending";
}
