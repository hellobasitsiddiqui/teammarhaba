// Membership pricing / checkout — DOM view (TM-479, epic group-membership / contract TM-457).
//
// The per-event price screen: it shows the caller what an event costs THEM — Free (their first) /
// Included (their tier) / £5 (or the premium price) / Upgrade to attend — and offers the matching
// checkout action (a confirm for Free/Included, a card step for Pay, an upgrade link for Upgrade,
// AC 1/2). All the price/label/payload rules live in the pure, node-tested membership-checkout-core.js;
// this module is the thin Paper-themed DOM shell + the runtime network glue.
//
// Behind the OFF flag (config.flags.membership, owned by TM-480 which adds it to config.js — this
// module only READS it). Until that flag is turned on the screen never renders and nothing here runs,
// so this PR is inert dead code that is safe to merge ahead of the rest of the membership epic.
//
// api is imported as a NAMESPACE and called at runtime (never `import { getMembership }`): on this
// branch api.js does not yet carry getMembership() (TM-474 adds it), and a named import of a missing
// export is a hard module-link error that would white-screen the whole SPA. A namespace import always
// links — `api.getMembership` is simply `undefined` until TM-474 lands — and it is only ever called
// inside the flag-gated path, which never runs while the flag is OFF. The static specifier also lets
// the deploy fingerprinter (TM-144) rewrite `./api.js` to its hashed name; a dynamic import would not
// be rewritten and would 404 in prod.
//
// Themed with theme tokens + the `.tm-wobble` hand-drawn edge only (no hard-coded colours), so the
// clean/sketchy Paper axes (TM-529) both render it natively. XSS-safe: every node via ui.js `el()`
// (textContent only, never innerHTML).

import * as api from "./api.js";
import { el, clear } from "./ui.js";
import {
  resolvePriceState,
  checkoutPayload,
  CHECKOUT_MODE,
  PRICE_KIND,
  TIER,
} from "./membership-checkout-core.js";

/** The screen container id (the `<section>` this module owns in index.html). */
const SCREEN_ID = "membership-checkout-screen";
/** The placeholder Pay mount point id — the seam the Revolut widget (TM-478) will fill. */
const PAY_MOUNT_ID = "membership-checkout-pay-mount";
/** Where the "Upgrade to attend" action sends the user — the membership/tier screen (TM-480). */
const MEMBERSHIP_ROUTE = "#/membership";

/**
 * Is the membership feature turned on? Reads `window.TEAMMARHABA_CONFIG.flags.membership` (added by
 * TM-480). Defaults to OFF whenever the flag object is absent — which is the case on this branch and
 * in every environment until the epic ships — so the screen stays hidden and inert.
 * @returns {boolean}
 */
function membershipEnabled() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return Boolean(cfg.flags && cfg.flags.membership);
}

/**
 * Map a price-state kind to the badge's modifier class, so the CSS can colour Free/Included calmly and
 * Pay/Upgrade as an action. Purely cosmetic — the copy already tells the whole story.
 */
function badgeModifier(kind) {
  if (kind === PRICE_KIND.PAY) return "tm-checkout-badge-pay";
  if (kind === PRICE_KIND.UPGRADE) return "tm-checkout-badge-upgrade";
  return "tm-checkout-badge-free"; // FREE + INCLUDED both read as "no charge"
}

/**
 * Build the placeholder Pay mount point — the disabled, "coming soon" seam the Revolut card widget
 * (TM-478) drops into. It is a real disabled control (not a dead link), announced unavailable via
 * aria-disabled, mirroring the "Coming soon" store-badge pattern. TM-478 replaces the mount's children
 * with the live widget and enables payment; the `data-provider="revolut"` marks the intended provider.
 * @param {number|null} amountPence the charge to display alongside the (future) card entry.
 * @returns {HTMLElement}
 */
function buildPayMount(amountPence) {
  return el("div", { id: PAY_MOUNT_ID, class: "tm-checkout-pay-mount tm-wobble", dataset: { provider: "revolut" } }, [
    el("p", { class: "tm-checkout-pay-note", text: "Card payment is coming soon." }),
    el("button", {
      type: "button",
      class: "tm-btn tm-checkout-pay-btn",
      disabled: true,
      "aria-disabled": "true",
      text: "Pay by card",
    }),
  ]);
}

/**
 * Build the primary checkout action for a resolved price state (AC 2):
 *   • CONFIRM → a "Reserve my place" button (no payment);
 *   • PAY     → a "Continue to payment" button that reveals the Pay mount (TM-478 placeholder);
 *   • UPGRADE → an "Upgrade to attend" link to the membership/tier screen (TM-480).
 * The handler builds the canonical checkout payload from the core; the actual RSVP/charge network call
 * is wired by a later ticket (the checkout screen is not routed yet), so CONFIRM/PAY only log + expose
 * the payload for now while UPGRADE navigates.
 * @param {object} state a resolvePriceState() result.
 * @param {object} event the event being checked out.
 * @returns {HTMLElement}
 */
function buildAction(state, event) {
  if (state.checkout === CHECKOUT_MODE.UPGRADE) {
    return el("a", {
      class: "tm-btn tm-checkout-action tm-checkout-action-upgrade",
      href: MEMBERSHIP_ROUTE,
      text: "Upgrade to attend",
    });
  }

  const isPay = state.checkout === CHECKOUT_MODE.PAY;
  return el("button", {
    type: "button",
    class: "tm-btn tm-checkout-action",
    text: isPay ? "Continue to payment" : "Reserve my place",
    onClick: () => {
      const payload = checkoutPayload(event, state);
      if (isPay) {
        // Reveal the Pay mount (Revolut placeholder until TM-478). The RSVP+charge call is future work.
        const mount = document.getElementById(PAY_MOUNT_ID);
        if (mount) mount.hidden = false;
      }
      // The RSVP/checkout network call lands in a later ticket; expose the payload for that wiring.
      console.info("[membership-checkout] checkout intent:", payload);
    },
  });
}

/**
 * Render the price state + checkout action for one event into `container` (AC 1/2). Pure DOM built
 * from data — takes the already-fetched MembershipResponse + event, so it is trivial to exercise with
 * a mock in the unit tests without any network.
 * @param {HTMLElement} container
 * @param {{membership: object, event: object}} data
 */
export function renderInto(container, { membership, event } = {}) {
  if (!container) return;
  clear(container);

  const state = resolvePriceState(membership, event);
  const card = el("div", { class: "tm-checkout-card tm-wobble" }, [
    el("h2", { class: "tm-checkout-title", text: event?.heading || "Attend this event" }),
    el("div", { class: "tm-checkout-price" }, [
      el("span", { class: `tm-checkout-badge ${badgeModifier(state.kind)}`, text: state.label }),
      el("span", { class: "tm-checkout-detail", text: state.detail }),
    ]),
    el("div", { class: "tm-checkout-actions" }, [buildAction(state, event)]),
    buildPayMount(state.amountPence),
  ]);

  // The Pay mount only shows once the user chooses to pay; hidden until then (and never for a
  // non-Pay state).
  const mount = card.querySelector(`#${PAY_MOUNT_ID}`);
  if (mount) mount.hidden = true;

  container.append(card);
  container.hidden = false;
}

/**
 * Open the checkout screen for a given event: fetch the caller's membership, then render. No-op when
 * the feature flag is OFF or the container is absent, so it is inert until the epic ships and the
 * screen is routed. Defensive on the network — a failed/absent membership read falls back to a fresh
 * pay-per-event caller so the screen still renders a sensible price rather than breaking.
 * @param {object} event the event to check out.
 * @returns {Promise<void>}
 */
export async function open(event) {
  const container = typeof document !== "undefined" ? document.getElementById(SCREEN_ID) : null;
  if (!container || !membershipEnabled()) return;

  let membership = { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: false };
  try {
    if (typeof api.getMembership === "function") {
      membership = await api.getMembership();
    }
  } catch (err) {
    console.warn("[membership-checkout] could not load membership:", err?.message ?? err);
  }
  renderInto(container, { membership, event });
}

// Self-register the open-seam on the window (like notification-panel.js's `window.tmNotificationPanel`),
// so the events screen can open the checkout without importing this module — keeping the two decoupled.
// Guarded for the non-browser (test) environment.
if (typeof window !== "undefined") {
  window.tmMembershipCheckout = { open, renderInto, isEnabled: membershipEnabled };
}
