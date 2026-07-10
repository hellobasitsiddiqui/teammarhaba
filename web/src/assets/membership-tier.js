// Membership tier management (TM-480) — view the caller's current tier + self-serve switch.
//
// Part of the Membership slice (contract TM-457, wave-0). This screen shows the caller's current
// membership tier, what each tier includes, and a Switch action per tier. Backed by the API TM-474
// owns: GET /api/v1/me/membership -> { tier, firstEventCreditAvailable } and
// POST /api/v1/me/membership/tier { tier } -> the same shape. This ticket owns ONLY this module, its
// CSS (membership-tier.css), its test (web/tools/membership-tier.test.mjs), its bits of index.html
// (a <link>, a <section id="membership-tier-screen">, a nav hook) and — as the flag owner — the
// `flags.membership` key in the web config (config.js). It does NOT touch api.js / openapi / styles.css
// / membership-checkout.* (other tickets own those).
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

import { el, clear, toast } from "./ui.js";

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
    tagline: "Everything in Monthly, plus concierge perks.",
    includes: Object.freeze([
      "Everything in Monthly",
      "Concierge event picks",
      "Exclusive Diamond-only events",
    ]),
    paid: true,
    comingSoon: true,
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
 * The four states a tier option can be in on this screen:
 *   • CURRENT     — the tier the caller is already on (no switch, shown as the active plan).
 *   • SWITCHABLE  — can switch to it right now with no payment (the free base, PAY_PER_EVENT). AC2.
 *   • GATED       — a paid upgrade: SHOWN but disabled until the card step (M5 / TM-479) lands. AC2.
 *   • COMING_SOON — a future tier not yet launched (Diamond). AC3. Never switchable.
 */
export const OptionState = Object.freeze({
  CURRENT: "current",
  SWITCHABLE: "switchable",
  GATED: "gated",
  COMING_SOON: "coming_soon",
});

/**
 * True iff a switch to `targetTier` can be performed self-serve RIGHT NOW (no payment). In this slice
 * only the free base is switchable without the card step — paid upgrades wait for M5 (TM-479) and the
 * Revolut flow (TM-478). This is the single guard both the UI and performSwitch key off.
 */
export function isSwitchableNow(targetTier) {
  return targetTier === "PAY_PER_EVENT";
}

/**
 * Decide the OptionState for offering `targetTier` to a caller currently on `currentTier`.
 * Precedence: the caller's current tier is always CURRENT; a future tier is always COMING_SOON (even
 * though it's also paid); the free base is SWITCHABLE now; any other paid tier is GATED behind M5.
 */
export function optionState(currentTier, targetTier) {
  if (targetTier === currentTier) return OptionState.CURRENT;
  if (tierMeta(targetTier).comingSoon) return OptionState.COMING_SOON;
  if (isSwitchableNow(targetTier)) return OptionState.SWITCHABLE;
  return OptionState.GATED; // a paid upgrade, shown but gated until the card step lands
}

/**
 * The full descriptor the UI renders for one tier option, given the caller's current membership.
 * Bundles the catalogue metadata with the resolved state + the action button's label / disabled flag /
 * secondary note, so the DOM half is a dumb painter.
 * @returns {{tier: string, label: string, tagline: string, includes: string[], state: string,
 *   isCurrent: boolean, actionLabel: string, disabled: boolean, note: string|null}}
 */
export function switchOptionFor(currentTier, targetTier) {
  const meta = tierMeta(targetTier);
  const state = optionState(currentTier, targetTier);
  let actionLabel;
  let note = null;
  switch (state) {
    case OptionState.CURRENT:
      actionLabel = "Current plan";
      break;
    case OptionState.SWITCHABLE:
      // Reachable now: from a paid tier back down to the free base (or staying free is CURRENT).
      actionLabel = "Switch to this plan";
      break;
    case OptionState.GATED:
      actionLabel = "Add a card to upgrade";
      note = "Card payment is coming soon.";
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
    // Only the SWITCHABLE option has an enabled button; everything else is shown but not clickable.
    actionLabel,
    disabled: state !== OptionState.SWITCHABLE,
    note,
  };
}

/**
 * The list of tier-option descriptors to render, in catalogue order, for a given membership.
 * @param {{tier: string, firstEventCreditAvailable?: boolean}} membership
 */
export function tierOptions(membership) {
  const { tier } = normalizeMembership(membership);
  return TIER_IDS.map((id) => switchOptionFor(tier, id));
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
 * Perform a self-serve tier switch. Guards on isSwitchableNow so a gated / coming-soon tier never hits
 * the network, then calls `api.switchTier(targetTier)` and normalises the response. Best-effort hooks
 * let the DOM reflect progress without this function knowing anything about the DOM (so it's unit
 * testable with a mock api and no browser).
 * @param {{switchTier: (tier: string) => Promise<object>}} api the api namespace (mock in tests, `window.tmApi` at runtime)
 * @param {string} targetTier
 * @param {{onStart?: Function, onSuccess?: (m: object) => void, onError?: (e: unknown) => void}} [hooks]
 * @returns {Promise<{ok: boolean, membership?: object, reason?: string, error?: unknown}>}
 */
export async function performSwitch(api, targetTier, hooks = {}) {
  const { onStart, onSuccess, onError } = hooks;
  if (!isSwitchableNow(targetTier)) {
    // A paid / coming-soon tier can't be switched to in this slice — never call the endpoint.
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
 * Render one tier-option card into the options grid.
 * @param {object} option a descriptor from switchOptionFor()
 * @param {(tier: string) => void} onPick called when the (enabled) switch button is clicked
 */
function optionCard(option, onPick) {
  const button = el("button", {
    type: "button",
    class: `tm-btn ${option.isCurrent ? "" : "tm-btn-primary"}`.trim(),
    text: option.actionLabel,
    onClick: () => onPick(option.tier),
  });
  button.disabled = option.disabled;

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
      includesList(option.includes),
      option.note ? el("p", { class: "tm-tier-note", text: option.note }) : null,
      el("div", { class: "tm-tier-actions" }, [button]),
    ],
  );
}

/**
 * Paint the whole membership screen into `container`: the current tier summary (+ first-event-credit
 * reflection) and the grid of tier options with their Switch actions. Re-renders itself after a
 * successful switch. `api` is injected (mock in tests, resolved from `window.tmApi` at runtime).
 * @param {HTMLElement} container
 * @param {{membership: object, api: {switchTier: Function}, onChange?: (m: object) => void}} opts
 */
export function renderMembership(container, { membership, api, onChange } = {}) {
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

  // Clicking an enabled (SWITCHABLE) option's button runs the switch, then re-renders with the new
  // membership so the "Current" marker + credit note move to the new tier.
  const onPick = async (tier) => {
    const result = await performSwitch(api, tier, {
      onError: () => toast("Couldn't change your plan. Please try again.", { type: "error" }),
    });
    if (result.ok) {
      toast(`You're now on ${tierMeta(result.membership.tier).label}.`, { type: "success" });
      if (typeof onChange === "function") onChange(result.membership);
      renderMembership(container, { membership: result.membership, api, onChange });
    }
  };

  const grid = el(
    "div",
    { class: "tm-tier-grid" },
    tierOptions(current).map((option) => optionCard(option, onPick)),
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
  try {
    const api = getApi();
    if (typeof api.getMembership === "function") membership = await api.getMembership();
  } catch (err) {
    // Fall back to a safe default view rather than failing the screen.
    console.warn("[membership-tier] GET /me/membership failed:", err?.message ?? err);
  }
  renderMembership(section, { membership, api: getApi() });
}
