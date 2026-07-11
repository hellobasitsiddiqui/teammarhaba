// Membership tier management (TM-480, subscriptions TM-620) — view the caller's current tier,
// self-serve switch, and manage the recurring subscription behind a paid tier.
//
// Part of the Membership slice (contract TM-457, wave-0). This screen shows the caller's current
// membership tier, what each tier includes, and the right action per tier. Backed by the API TM-474
// owns: GET /api/v1/me/membership -> { tier, firstEventCreditAvailable } and
// POST /api/v1/me/membership/tier { tier } -> the same shape — plus, since TM-620, the subscription
// surface: GET /me/subscription (the manage panel), POST /me/subscription/cancel, and the Subscribe
// checkout screen at #/membership/subscribe/{TIER} (membership-subscribe.js) the paid tiers link to.
//
// SINCE TM-620 the paid tiers are REAL subscriptions (MONTHLY £9.99/mo, DIAMOND £19.99/mo): switching
// into one requires an active subscription (the backend answers 402 without one), so the paid tier
// cards now carry a Subscribe action that navigates to the Subscribe checkout instead of the old
// disabled "card step coming soon" placeholder; Diamond is live (all-access incl. premium), no longer
// coming-soon. Dropping back to the free base while a subscription still renews is blocked in favour
// of Cancel (the backend answers 409) — the manage panel owns the cancel.
//
// WHY the api namespace is read at RUNTIME off `window.tmApi` rather than a static namespace import of
// api.js (import-star), per contract TM-457:
//   • The contract mandates the frontend treat api as a NAMESPACE and resolve members at CALL time —
//     never a named import of a symbol (switchTier / getMembership) that TM-474 has not added on this
//     branch yet, which would be an ESM link error that white-screens the whole boot graph.
//   • api.js is not importable under Node (it transitively imports the Firebase SDK over an https URL,
//     which Node's ESM loader rejects). A static import would make this single file impossible to load
//     in the mandated `node --test` gate. api.js already publishes every helper on `window.tmApi`
//     ("Bridge for the framework-free page"), so reading that at call time is the node-safe,
//     fingerprint-safe way to honour "namespace + resolve at runtime": `getApi().switchTier` is simply
//     undefined until TM-474 lands, resolved when the user actually clicks — exactly the contract's
//     intent. The tests inject a mock api into the pure helpers directly, so no seam is needed there.
//
// The whole screen is gated behind `config.flags.membership` (shipped OFF). While the flag is off the
// app router never routes to `#/membership` and never calls enterMembershipTier(), so the screen is
// inert dead code until the flag flips (TM-606 wired entry through router.js; TM-478 flips the flag).
//
// DESIGN: all the decisions (tier catalogue, which switches are allowed now, the first-event-credit
// note) live in the PURE, DOM-free, api-free functions exported below and are exhaustively unit-tested
// (the AC's "pure parts tested"). The DOM half (renderMembership) only paints what those functions
// decide, via ui.js's XSS-safe el() (textContent only, never innerHTML), using theme tokens so it
// renders correctly under Paper + the per-user accent / sketchy toggle.

import { el, clear, toast, confirmDialog } from "./ui.js";
import {
  describeSubscription,
  normalizeSubscription,
  subscribeRoute,
  subscriptionPriceLabel,
} from "./membership-subscribe-core.js";

// --- Tier catalogue ------------------------------------------------------------------------------

/**
 * The three membership tiers (contract TM-457). PAY_PER_EVENT is the free, JIT-enrolled base every
 * caller starts on. Each entry carries everything the UI needs to render a tier card:
 *   • id        — the enum value persisted server-side + sent to POST .../membership/tier.
 *   • label     — the human name shown on the card.
 *   • tagline   — the one-line "what it is".
 *   • includes  — the bullet list of what the tier includes ("what it includes", AC1).
 *   • paid      — true for tiers that require payment (the card step, M5 / TM-479).
 *   • comingSoon — true for a not-yet-launched future tier (Diamond, AC3) — never switchable now.
 * Order is the display order; PAY_PER_EVENT first (the free base), then the upgrades.
 */
export const TIERS = Object.freeze([
  Object.freeze({
    id: "PAY_PER_EVENT",
    label: "Pay per event",
    tagline: "The free base — pay only for the events you go to.",
    includes: Object.freeze([
      "Free to join, no monthly fee",
      "Pay only when you attend an event",
      "Your first event is on us",
    ]),
    paid: false,
    comingSoon: false,
  }),
  Object.freeze({
    id: "MONTHLY",
    label: "Monthly",
    tagline: "Unlimited events for one flat monthly price.",
    includes: Object.freeze([
      "Unlimited events every month",
      "Priority off the waitlist",
      "Cancel anytime",
    ]),
    paid: true,
    comingSoon: false,
  }),
  Object.freeze({
    id: "DIAMOND",
    label: "Diamond",
    tagline: "All-access — every event, premium included.",
    includes: Object.freeze([
      "Everything in Monthly",
      "Premium events included, no surcharge",
      "Exclusive Diamond-only events",
    ]),
    paid: true,
    // Live since TM-620: Diamond is a real £19.99/mo subscription, no longer a future placeholder.
    comingSoon: false,
  }),
]);

/** The valid tier ids, in display order. */
export const TIER_IDS = Object.freeze(TIERS.map((t) => t.id));

/** The default / free base tier a brand-new (JIT-enrolled) caller is on. */
export const DEFAULT_TIER = "PAY_PER_EVENT";

/** True iff `tier` names one of the known tiers. */
export function isValidTier(tier) {
  return TIER_IDS.includes(tier);
}

/** The catalogue entry for `tier`, or the default (PAY_PER_EVENT) entry if `tier` is unknown. */
export function tierMeta(tier) {
  return TIERS.find((t) => t.id === tier) || TIERS.find((t) => t.id === DEFAULT_TIER);
}

// --- Membership response normalisation -----------------------------------------------------------

/**
 * Coerce a possibly-partial/invalid MembershipResponse to a safe shape. An unknown/absent tier falls
 * back to the free base; a non-boolean credit flag falls back to false. Never throws — the screen can
 * render off whatever the endpoint (or a stale cache) returns.
 * @param {{tier?: string, firstEventCreditAvailable?: boolean}|null|undefined} resp
 * @returns {{tier: string, firstEventCreditAvailable: boolean}}
 */
export function normalizeMembership(resp) {
  const tier = isValidTier(resp?.tier) ? resp.tier : DEFAULT_TIER;
  const firstEventCreditAvailable = resp?.firstEventCreditAvailable === true;
  return { tier, firstEventCreditAvailable };
}

// --- Switch availability (the heart of the AC) ---------------------------------------------------

/**
 * The five states a tier option can be in on this screen (TM-480, reshaped by TM-620):
 *   • CURRENT     — the tier the caller is already on (no switch, shown as the active plan).
 *   • SWITCHABLE  — can switch to it right now via the free tier-switch endpoint: the free base (when
 *                   no subscription still renews), or a paid tier the caller's subscription already
 *                   covers (e.g. switching back after a manual downgrade).
 *   • SUBSCRIBE   — a paid tier with no covering subscription: the action navigates to the Subscribe
 *                   checkout (#/membership/subscribe/{TIER}) — first charge + card save (TM-620).
 *   • BLOCKED     — the free base while a subscription still renews: dropping the paid tier without
 *                   cancelling would keep the billing — the manage panel's Cancel is the way out.
 *   • COMING_SOON — a future tier not yet launched. No current tier uses it (Diamond went live in
 *                   TM-620); kept for the next future tier.
 */
export const OptionState = Object.freeze({
  CURRENT: "current",
  SWITCHABLE: "switchable",
  SUBSCRIBE: "subscribe",
  BLOCKED: "blocked",
  COMING_SOON: "coming_soon",
});

/**
 * Whether the caller's subscription covers `tier` right now: subscribed to exactly that tier and not
 * yet lapsed (ACTIVE, dunning PAST_DUE, or CANCELED with paid time left — the client trusts the server
 * to have lapsed/downgraded an expired one; the backend gate is authoritative either way).
 */
function subscriptionCovers(subscription, tier) {
  const sub = normalizeSubscription(subscription);
  return sub.subscribed && sub.tier === tier;
}

/**
 * True iff a switch to `targetTier` can be performed via the free tier-switch endpoint RIGHT NOW
 * (TM-620): the free base — unless a subscription still renews (cancel first) — or a paid tier the
 * caller's subscription already covers. A paid tier without a covering subscription is NOT switchable
 * (the backend answers 402): it needs the Subscribe checkout. This is the single guard both the UI and
 * performSwitch key off.
 * @param {string} targetTier
 * @param {unknown} [subscription] the caller's GET /me/subscription state (absent = no subscription)
 */
export function isSwitchableNow(targetTier, subscription) {
  const sub = normalizeSubscription(subscription);
  if (targetTier === "PAY_PER_EVENT") {
    // Leaving a paid tier while still being billed is blocked in favour of cancel (backend: 409).
    return !(sub.subscribed && sub.renewing);
  }
  return subscriptionCovers(subscription, targetTier);
}

/**
 * Decide the OptionState for offering `targetTier` to a caller currently on `currentTier` with
 * `subscription` (TM-620). Precedence: the caller's current tier is always CURRENT; a future tier is
 * always COMING_SOON; then the switchability rule above decides SWITCHABLE, and what is not switchable
 * is SUBSCRIBE for a paid tier (go pay) or BLOCKED for the free base (go cancel).
 */
export function optionState(currentTier, targetTier, subscription) {
  if (targetTier === currentTier) return OptionState.CURRENT;
  if (tierMeta(targetTier).comingSoon) return OptionState.COMING_SOON;
  if (isSwitchableNow(targetTier, subscription)) return OptionState.SWITCHABLE;
  return targetTier === "PAY_PER_EVENT" ? OptionState.BLOCKED : OptionState.SUBSCRIBE;
}

/**
 * The full descriptor the UI renders for one tier option, given the caller's current membership and
 * subscription. Bundles the catalogue metadata with the resolved state + the action's label / disabled
 * flag / navigation target / secondary note, so the DOM half is a dumb painter.
 * @returns {{tier: string, label: string, tagline: string, includes: string[], state: string,
 *   isCurrent: boolean, actionLabel: string, disabled: boolean, note: string|null,
 *   price: string|null, subscribeHref: string|null}}
 */
export function switchOptionFor(currentTier, targetTier, subscription) {
  const meta = tierMeta(targetTier);
  const state = optionState(currentTier, targetTier, subscription);
  const price = meta.paid ? subscriptionPriceLabel(targetTier) : null;
  let actionLabel;
  let note = null;
  let subscribeHref = null;
  switch (state) {
    case OptionState.CURRENT:
      actionLabel = "Current plan";
      break;
    case OptionState.SWITCHABLE:
      actionLabel = "Switch to this plan";
      break;
    case OptionState.SUBSCRIBE:
      // The paid path (TM-620): navigate to the Subscribe checkout — first charge + card save.
      actionLabel = price ? `Subscribe · ${price}` : "Subscribe";
      subscribeHref = subscribeRoute(targetTier);
      note = "Billed monthly. Cancel anytime.";
      break;
    case OptionState.BLOCKED:
      actionLabel = "Cancel subscription to switch";
      note = "Cancel your subscription first — your paid tier stays until the period end.";
      break;
    case OptionState.COMING_SOON:
    default:
      actionLabel = "Coming soon";
      note = "This tier is launching soon.";
      break;
  }
  return {
    tier: meta.id,
    label: meta.label,
    tagline: meta.tagline,
    includes: meta.includes,
    state,
    isCurrent: state === OptionState.CURRENT,
    // SWITCHABLE runs the switch; SUBSCRIBE navigates (enabled link); the rest are shown, not clickable.
    actionLabel,
    disabled: state !== OptionState.SWITCHABLE && state !== OptionState.SUBSCRIBE,
    note,
    price,
    subscribeHref,
  };
}

/**
 * The list of tier-option descriptors to render, in catalogue order, for a given membership +
 * subscription (TM-620).
 * @param {{tier: string, firstEventCreditAvailable?: boolean}} membership
 * @param {unknown} [subscription] the caller's GET /me/subscription state
 */
export function tierOptions(membership, subscription) {
  const { tier } = normalizeMembership(membership);
  return TIER_IDS.map((id) => switchOptionFor(tier, id, subscription));
}

// --- First-event credit reflection ---------------------------------------------------------------

/**
 * Reflect `firstEventCreditAvailable` for PAY_PER_EVENT callers (the flag is meaningful only on the
 * free base). Returns null for paid tiers (the credit doesn't apply there), otherwise a note object:
 *   • available:true  → the free first-event credit is still available.
 *   • available:false → the caller has already used it.
 * @param {{tier: string, firstEventCreditAvailable?: boolean}} membership
 * @returns {{available: boolean, text: string}|null}
 */
export function firstEventCreditNote(membership) {
  const { tier, firstEventCreditAvailable } = normalizeMembership(membership);
  if (tier !== "PAY_PER_EVENT") return null;
  return firstEventCreditAvailable
    ? { available: true, text: "Your first event is on us — a free credit is available." }
    : { available: false, text: "You've used your first-event credit." };
}

// --- Runtime switch action (calls api.switchTier) ------------------------------------------------

/**
 * Perform a self-serve tier switch. Guards on isSwitchableNow so a non-switchable tier (a paid tier
 * with no covering subscription, or the free base while a subscription still renews — TM-620) never
 * hits the network, then calls `api.switchTier(targetTier)` and normalises the response. Best-effort
 * hooks let the DOM reflect progress without this function knowing anything about the DOM (so it's
 * unit testable with a mock api and no browser).
 * @param {{switchTier: (tier: string) => Promise<object>}} api the api namespace (mock in tests, `window.tmApi` at runtime)
 * @param {string} targetTier
 * @param {{onStart?: Function, onSuccess?: (m: object) => void, onError?: (e: unknown) => void}} [hooks]
 * @param {unknown} [subscription] the caller's GET /me/subscription state (absent = no subscription)
 * @returns {Promise<{ok: boolean, membership?: object, reason?: string, error?: unknown}>}
 */
export async function performSwitch(api, targetTier, hooks = {}, subscription) {
  const { onStart, onSuccess, onError } = hooks;
  if (!isSwitchableNow(targetTier, subscription)) {
    // Not free to switch (subscribe / cancel first) — never call the endpoint.
    const reason = "not-switchable";
    if (typeof onError === "function") onError(new Error(reason));
    return { ok: false, reason };
  }
  if (typeof onStart === "function") onStart();
  try {
    const resp = await api.switchTier(targetTier);
    const membership = normalizeMembership(resp);
    if (typeof onSuccess === "function") onSuccess(membership);
    return { ok: true, membership };
  } catch (error) {
    if (typeof onError === "function") onError(error);
    return { ok: false, error };
  }
}

// --- Cancel-confirmation copy (TM-629) -------------------------------------------------------------

/**
 * The confirm-dialog copy for cancelling a subscription, resolved from the describeSubscription() view
 * so the promise the dialog makes is TRUE for the state the caller is actually in.
 *
 * The TM-629 regression this encodes: the dialog used to show ONE reassuring message — "you keep your
 * current plan until the end of the period you've already paid for" — to every cancellable state. For
 * a PAST_DUE (dunning) subscription that promise is false: cancelling parks the next charge at the
 * period end, which is ALREADY in the past, so the next scheduler tick (minutes away) downgrades the
 * account immediately. A dunning user now gets honest copy instead of a promise the backend breaks
 * minutes later.
 *
 * @param {{paymentProblem?: boolean}} view a describeSubscription() view model.
 * @returns {{title: string, message: string}}
 */
export function cancelDialogCopy(view) {
  const title = "Cancel your subscription?";
  if (view && view.paymentProblem === true) {
    // PAST_DUE: the paid-for period is already over (that's why dunning is retrying) — no reassuring
    // "you keep your plan" promise; the downgrade lands on the next scheduler tick.
    return {
      title,
      message:
        "We couldn't collect your last payment, so your paid period has already ended — cancelling moves you to pay-per-event right away.",
    };
  }
  return {
    title,
    message:
      "Renewals stop immediately. You keep your current plan until the end of the period you've already paid for, then move to pay-per-event.",
  };
}

// --- DOM half (painter) --------------------------------------------------------------------------

/**
 * Build the "what it includes" bullet list for a tier.
 */
function includesList(includes) {
  return el(
    "ul",
    { class: "tm-tier-includes" },
    includes.map((line) => el("li", { text: line })),
  );
}

/**
 * Render one tier-option card into the options grid. A SUBSCRIBE option renders a NAVIGATION link to
 * the Subscribe checkout (styled as the primary button — the checkout takes the payment, TM-620);
 * everything else renders the switch button (enabled only for SWITCHABLE).
 * @param {object} option a descriptor from switchOptionFor()
 * @param {(tier: string) => void} onPick called when the (enabled) switch button is clicked
 */
function optionCard(option, onPick) {
  let action;
  if (option.state === OptionState.SUBSCRIBE) {
    action = el("a", {
      class: "tm-btn tm-btn-primary tm-tier-subscribe",
      href: option.subscribeHref,
      text: option.actionLabel,
    });
  } else {
    action = el("button", {
      type: "button",
      class: `tm-btn ${option.isCurrent ? "" : "tm-btn-primary"}`.trim(),
      text: option.actionLabel,
      onClick: () => onPick(option.tier),
    });
    action.disabled = option.disabled;
  }

  return el(
    "div",
    {
      class: `tm-tier-card${option.isCurrent ? " tm-tier-card-current" : ""}`,
      dataset: { tier: option.tier, state: option.state },
    },
    [
      el("div", { class: "tm-tier-card-head" }, [
        el("h3", { class: "tm-tier-name", text: option.label }),
        option.isCurrent ? el("span", { class: "tm-tier-badge", text: "Current" }) : null,
        option.state === OptionState.COMING_SOON
          ? el("span", { class: "tm-tier-badge tm-tier-badge-soon", text: "Coming soon" })
          : null,
      ]),
      el("p", { class: "tm-tier-tagline", text: option.tagline }),
      option.price ? el("p", { class: "tm-tier-price", text: option.price }) : null,
      includesList(option.includes),
      option.note ? el("p", { class: "tm-tier-note", text: option.note }) : null,
      el("div", { class: "tm-tier-actions" }, [action]),
    ],
  );
}

/**
 * The manage-subscription panel (TM-620): status, price, the renewal/end line, and Cancel while
 * renewals still run. Renders nothing when the caller has no subscription (the tier cards' Subscribe
 * actions are the entry point). Cancel asks for confirmation (the styled dialog, never native
 * confirm()), calls the API and re-renders through `onCancelled` with the fresh subscription state.
 * @param {unknown} subscription the GET /me/subscription state.
 * @param {{cancelSubscription?: () => Promise<object>}} api
 * @param {(subscription: object) => void} onCancelled re-render hook with the updated state.
 * @returns {HTMLElement|null}
 */
function subscriptionPanel(subscription, api, onCancelled) {
  const view = describeSubscription(subscription);
  if (!view.subscribed) return null;

  const children = [
    el("div", { class: "tm-subscription-head" }, [
      el("p", { class: "tm-subscription-title", text: "Your subscription" }),
      el("span", {
        class: `tm-subscription-status${view.paymentProblem ? " tm-subscription-status-problem" : ""}`,
        text: view.statusLabel,
      }),
    ]),
    view.priceLine
      ? el("p", { class: "tm-subscription-price", text: `${tierMeta(view.tier).label} · ${view.priceLine}` })
      : null,
    el("p", { class: "tm-subscription-renewal", text: view.renewalLine }),
  ];

  if (view.canCancel) {
    const cancelBtn = el("button", {
      type: "button",
      class: "tm-btn tm-subscription-cancel",
      text: "Cancel subscription",
      onClick: async () => {
        // The copy varies by state (TM-629): a PAST_DUE cancel downgrades right away, so the dialog
        // must not promise "you keep your plan until the period end". Pure + unit-tested above.
        const copy = cancelDialogCopy(view);
        const sure = await confirmDialog({
          title: copy.title,
          message: copy.message,
          confirmLabel: "Cancel subscription",
          cancelLabel: "Keep it",
          danger: true,
        });
        if (!sure) return;
        try {
          const updated = await api.cancelSubscription();
          toast("Subscription cancelled — your plan stays until the period end.", { type: "success" });
          onCancelled(updated);
        } catch (err) {
          toast(err?.message || "Couldn't cancel your subscription. Please try again.", { type: "error" });
        }
      },
    });
    children.push(el("div", { class: "tm-subscription-actions" }, [cancelBtn]));
  }

  return el("div", { class: "tm-subscription-panel tm-wobble" }, children);
}

/**
 * Paint the whole membership screen into `container`: the current tier summary (+ first-event-credit
 * reflection), the manage-subscription panel (TM-620, when subscribed) and the grid of tier options
 * with their Switch/Subscribe actions. Re-renders itself after a successful switch or cancel. `api` is
 * injected (mock in tests, resolved from `window.tmApi` at runtime).
 * @param {HTMLElement} container
 * @param {{membership: object, subscription?: object, api: {switchTier: Function,
 *   cancelSubscription?: Function}, onChange?: (m: object) => void}} opts
 */
export function renderMembership(container, { membership, subscription, api, onChange } = {}) {
  if (!container) return;
  const current = normalizeMembership(membership);
  clear(container);

  container.appendChild(el("h2", { class: "tm-membership-title", text: "Membership" }));

  const currentMeta = tierMeta(current.tier);
  const summary = el("div", { class: "tm-membership-current" }, [
    el("p", { class: "tm-membership-current-label", text: "Your plan" }),
    el("p", { class: "tm-membership-current-tier", text: currentMeta.label }),
    el("p", { class: "tm-membership-current-tagline", text: currentMeta.tagline }),
  ]);
  const credit = firstEventCreditNote(current);
  if (credit) {
    summary.appendChild(
      el("p", {
        class: `tm-membership-credit${credit.available ? " tm-membership-credit-on" : ""}`,
        text: credit.text,
      }),
    );
  }
  container.appendChild(summary);

  // Manage-subscription panel (TM-620): renewal date + cancel, only when a subscription exists. A
  // cancel re-renders the whole screen with the fresh state so the tier cards' actions follow suit.
  const panel = subscriptionPanel(subscription, api, (updated) =>
    renderMembership(container, { membership, subscription: updated, api, onChange }),
  );
  if (panel) container.appendChild(panel);

  // Clicking an enabled (SWITCHABLE) option's button runs the switch, then re-renders with the new
  // membership so the "Current" marker + credit note move to the new tier. (SUBSCRIBE options are
  // links to the Subscribe checkout and never come through here.)
  const onPick = async (tier) => {
    const result = await performSwitch(
      api,
      tier,
      { onError: () => toast("Couldn't change your plan. Please try again.", { type: "error" }) },
      subscription,
    );
    if (result.ok) {
      toast(`You're now on ${tierMeta(result.membership.tier).label}.`, { type: "success" });
      if (typeof onChange === "function") onChange(result.membership);
      renderMembership(container, { membership: result.membership, subscription, api, onChange });
    }
  };

  const grid = el(
    "div",
    { class: "tm-tier-grid" },
    tierOptions(current, subscription).map((option) => optionCard(option, onPick)),
  );
  container.appendChild(grid);
}

// --- Runtime mount (flag-gated; driven by router.js, inert while the flag is OFF) ----------------

const SCREEN_ID = "membership-tier-screen";
// The route this screen answers to. Exported so it's the single shared source of truth: router.js
// registers the SAME '#/membership' (its MEMBERSHIP constant) and the membership-checkout screen's
// "Upgrade to attend" action targets the SAME route (membership-checkout.js MEMBERSHIP_ROUTE) — the
// TM-606 route-agreement check, all three resolve to '#/membership'.
export const MEMBERSHIP_ROUTE = "#/membership";

/** The web runtime config (`window.TEAMMARHABA_CONFIG`), or an empty object off-DOM. */
function config() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
}

/** True iff the membership feature flag is ON. Shipped OFF (config.js). router.js imports this too, so
 *  the whole membership route is gated in ONE place off the single config flag. */
export function membershipEnabled() {
  const cfg = config();
  return !!(cfg.flags && cfg.flags.membership);
}

/** The api namespace, resolved at runtime from api.js's `window.tmApi` bridge (see file header). */
function getApi() {
  return (typeof window !== "undefined" && window.tmApi) || {};
}

/**
 * Enter the membership tier screen (TM-606): fetch the caller's membership and render it into the screen
 * section. Called by router.js on entry into #/membership — the app router now owns the screen's
 * show/hide + the mount-once lifecycle, so this module NO LONGER runs its own hashchange listener (that
 * self-managed listener was removed in TM-606; routing goes through router.js like every other screen).
 * Defensive on the network: a failed/absent membership read falls back to a fresh pay-per-event caller so
 * the screen still renders a sensible view rather than breaking.
 */
export async function enterMembershipTier() {
  if (typeof document === "undefined") return;
  const section = document.getElementById(SCREEN_ID);
  if (!section) return;
  let membership = { tier: DEFAULT_TIER, firstEventCreditAvailable: false };
  let subscription = { subscribed: false };
  const api = getApi();
  try {
    if (typeof api.getMembership === "function") membership = await api.getMembership();
  } catch (err) {
    // Fall back to a safe default view rather than failing the screen.
    console.warn("[membership-tier] GET /me/membership failed:", err?.message ?? err);
  }
  try {
    // The subscription state drives the paid tiers' Subscribe vs Switch actions and the manage panel
    // (TM-620). A failed read falls back to "no subscription" — the backend gate stays authoritative.
    if (typeof api.getSubscription === "function") subscription = await api.getSubscription();
  } catch (err) {
    console.warn("[membership-tier] GET /me/subscription failed:", err?.message ?? err);
  }
  renderMembership(section, { membership, subscription, api });
}
