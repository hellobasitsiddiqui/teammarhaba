// Subscribe checkout — DOM view (TM-620, epic group-membership).
//
// The dedicated paid flow behind the tier screen's Subscribe actions (#/membership/subscribe/{TIER}):
// shows the tier + the locked monthly price (£9.99 MONTHLY / £19.99 DIAMOND), takes the FIRST payment
// through the Revolut card widget with the card SAVED for merchant-initiated renewals
// (savePaymentMethodFor: "merchant" — the whole recurring mandate anchors on this SCA-authenticated
// first charge), and reflects the activation. The subscription itself is activated SERVER-SIDE by the
// verified payment webhook — this screen only polls GET /me/subscription afterwards to show it; a
// client can never talk itself into a paid tier.
//
// All the decisions (prices, route parsing, subscription state descriptions) live in the pure,
// node-tested membership-subscribe-core.js; this module is the thin Paper-themed DOM shell + the
// runtime network glue, exactly the core/view split the sibling membership screens use.
//
// Behind the OFF flag (config.flags.membership): router.js only treats #/membership/subscribe/* as a
// known route while the flag is on, so this module is inert dead code until the flag flips.
//
// api is imported as a NAMESPACE and called at runtime (contract TM-457) — `api.subscriptionCheckout`
// is resolved when the user clicks, and the static specifier lets the deploy fingerprinter (TM-144)
// rewrite `./api.js` to its hashed name. The Revolut SDK loader is shared with the per-event checkout
// (membership-checkout.js exports it since TM-620) so both screens mount the same widget the same way.
//
// Themed with theme tokens + the `.tm-wobble` hand-drawn edge only (no hard-coded colours). XSS-safe:
// every node via ui.js `el()` (textContent only, never innerHTML).

import * as api from "./api.js";
import { el, clear } from "./ui.js";
import { loadRevolutSdk } from "./membership-checkout.js";
import { formatPrice } from "./membership-checkout-core.js";
import {
  describeSubscription,
  subscriptionPricePence,
  tierFromSubscribeRoute,
} from "./membership-subscribe-core.js";
import { tierMeta, MEMBERSHIP_ROUTE } from "./membership-tier.js";

/** The screen container id (the `<section>` this module owns in index.html). */
const SCREEN_ID = "membership-subscribe-screen";

/** How the post-payment activation poll behaves: the webhook usually lands within a few seconds. */
const ACTIVATION_POLL_ATTEMPTS = 10;
const ACTIVATION_POLL_INTERVAL_MS = 1500;

/** True iff the membership feature flag is ON (config.flags.membership, shipped OFF). */
function membershipEnabled() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return Boolean(cfg.flags && cfg.flags.membership);
}

/** Read the client payment config (TM-478): the sandbox Revolut widget mode. */
function paymentsConfig() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return cfg.payments && typeof cfg.payments === "object" ? cfg.payments : {};
}

/** Set the screen's aria-live status line (progress / error copy). */
function setStatus(section, text) {
  const status = section.querySelector(".tm-subscribe-status");
  if (status) status.textContent = text;
}

/**
 * Reflect a completed subscription (or the pending-webhook state) in place of the card widget: a
 * success line + a link back to the membership screen where the manage panel now lives.
 */
function reflectDone(section, text) {
  const pay = section.querySelector(".tm-subscribe-pay");
  if (pay) clear(pay);
  setStatus(section, "");
  section.appendChild(el("p", { class: "tm-subscribe-done", text }));
  section.appendChild(
    el("a", { class: "tm-btn tm-btn-primary", href: MEMBERSHIP_ROUTE, text: "Back to membership" }),
  );
}

/**
 * Poll GET /me/subscription until the webhook-driven activation shows up (or attempts run out). The
 * payment ALREADY succeeded when this runs — the poll is purely cosmetic confirmation; running out of
 * attempts shows honest "activating" copy rather than an error.
 */
async function pollActivation(section, tier) {
  for (let attempt = 0; attempt < ACTIVATION_POLL_ATTEMPTS; attempt++) {
    try {
      const view = describeSubscription(await api.getSubscription());
      if (view.subscribed && view.tier === tier) {
        reflectDone(section, `You're subscribed! Your ${tierMeta(tier).label} membership is active.`);
        return;
      }
    } catch {
      // A transient read failure mid-poll is fine — try again on the next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_INTERVAL_MS));
  }
  reflectDone(
    section,
    "Payment received — your subscription is activating and will appear on your membership screen shortly.",
  );
}

/**
 * Run the Subscribe payment (TM-620): create the checkout server-side, then mount the Revolut card
 * field with the returned single-use token and charge on submit — with the card SAVED FOR MERCHANT
 * use, the one flag that makes the off-session renewals possible. Every failure renders an inline,
 * non-throwing status message — a payment hiccup must never white-screen the screen.
 */
async function startSubscribePayment(section, tier) {
  setStatus(section, "Starting secure card payment…");

  let checkout;
  try {
    checkout = await api.subscriptionCheckout(tier);
  } catch (err) {
    setStatus(section, `Could not start the checkout: ${err?.message ?? err}`);
    return;
  }
  const token = checkout && checkout.paymentToken;
  if (!token) {
    setStatus(section, "Checkout could not be initialised. Please try again.");
    return;
  }

  let RevolutCheckout;
  let instance;
  try {
    RevolutCheckout = await loadRevolutSdk();
    instance = await RevolutCheckout(token, paymentsConfig().revolutMode || "sandbox");
  } catch (err) {
    setStatus(section, `Payment is unavailable right now: ${err?.message ?? err}`);
    return;
  }

  const host = section.querySelector(".tm-subscribe-widget");
  if (host) clear(host);
  const amount = Number.isFinite(checkout.amountPence) ? checkout.amountPence : subscriptionPricePence(tier);
  const payBtn = el("button", {
    type: "button",
    class: "tm-btn tm-btn-primary tm-subscribe-pay-btn",
    text: `Subscribe · ${formatPrice(amount)}/month`,
  });

  // The card field, with the card saved for MERCHANT-initiated use — the documented widget flag for
  // subscription mandates (an API-shape assumption flagged for the live smoke test): the SCA/3DS
  // challenge runs in the widget on this first charge, and every renewal then charges off-session.
  const cardField = instance.createCardField({
    target: host,
    savePaymentMethodFor: "merchant",
    onSuccess: () => {
      setStatus(section, "Payment received — activating your subscription…");
      pollActivation(section, tier);
    },
    onError: (message) =>
      setStatus(section, `Payment failed: ${message?.message ?? message ?? "please try again"}`),
  });

  payBtn.addEventListener("click", () => {
    setStatus(section, "Processing payment…");
    cardField.submit();
  });

  const actions = section.querySelector(".tm-subscribe-actions");
  if (actions) {
    clear(actions);
    actions.appendChild(payBtn);
  }
}

/**
 * Paint the Subscribe checkout for `tier` into the screen section: what you're buying (tier + monthly
 * price + includes), the card widget host, and the Start button that opens the payment. Pure paint —
 * network only runs when the user acts.
 */
function renderSubscribe(section, tier) {
  clear(section);
  const meta = tierMeta(tier);
  const pence = subscriptionPricePence(tier);

  section.appendChild(el("h2", { class: "tm-subscribe-title", text: `Subscribe to ${meta.label}` }));
  section.appendChild(
    el("div", { class: "tm-subscribe-summary tm-wobble", dataset: { tier } }, [
      el("p", { class: "tm-subscribe-price", text: `${formatPrice(pence)}/month` }),
      el("p", { class: "tm-subscribe-tagline", text: meta.tagline }),
      el(
        "ul",
        { class: "tm-subscribe-includes" },
        meta.includes.map((line) => el("li", { text: line })),
      ),
      el("p", {
        class: "tm-subscribe-terms",
        text:
          "Billed monthly from today. Your card is saved securely with Revolut for renewals. Cancel anytime — you keep access until the end of the period you've paid for.",
      }),
    ]),
  );

  // The payment area: the widget host the Revolut card field mounts into, the action button, and an
  // aria-live status line for progress/errors.
  const start = el("button", {
    type: "button",
    class: "tm-btn tm-btn-primary tm-subscribe-start",
    text: "Continue to payment",
    onClick: () => startSubscribePayment(section, tier),
  });
  section.appendChild(
    el("div", { class: "tm-subscribe-pay", dataset: { provider: "revolut" } }, [
      el("div", { class: "tm-subscribe-widget" }),
      el("div", { class: "tm-subscribe-actions" }, [start]),
      el("p", { class: "tm-subscribe-status", "aria-live": "polite", text: "" }),
    ]),
  );

  section.appendChild(el("a", { class: "tm-subscribe-back", href: MEMBERSHIP_ROUTE, text: "Back to membership" }));
}

/**
 * Enter the Subscribe checkout (TM-620): parse the tier out of the current route and render. Called by
 * router.js on entry into #/membership/subscribe/* — the router owns show/hide, this module only
 * paints. If the caller is ALREADY actively subscribed the screen says so instead of re-selling (the
 * backend would 409 the checkout anyway); a failed subscription read just renders the checkout — the
 * server remains the authority.
 */
export async function enterMembershipSubscribe() {
  if (typeof document === "undefined" || !membershipEnabled()) return;
  const section = document.getElementById(SCREEN_ID);
  if (!section) return;
  const tier = tierFromSubscribeRoute(window.location.hash);
  if (!tier) return; // not a subscribe route (router.js should never send us here otherwise)

  try {
    const view = describeSubscription(await api.getSubscription());
    if (view.subscribed && view.canCancel) {
      // ACTIVE or PAST_DUE — there's a live subscription; manage it rather than double-subscribing.
      clear(section);
      section.appendChild(el("h2", { class: "tm-subscribe-title", text: "You're already subscribed" }));
      section.appendChild(
        el("p", {
          class: "tm-subscribe-done",
          text: `Your ${tierMeta(view.tier).label} subscription is ${String(view.statusLabel).toLowerCase()}. Manage it from your membership screen.`,
        }),
      );
      section.appendChild(
        el("a", { class: "tm-btn tm-btn-primary", href: MEMBERSHIP_ROUTE, text: "Manage subscription" }),
      );
      return;
    }
  } catch {
    // Can't read the subscription — render the checkout; the backend gate is authoritative.
  }
  renderSubscribe(section, tier);
}
