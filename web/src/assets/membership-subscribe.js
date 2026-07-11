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
import { loadRevolutSdk, revolutCardFieldStyles, buildCardholderNameField } from "./membership-checkout.js";
import {
  formatPrice,
  isValidCardholderName,
  normalizeCardholderName,
  CARDHOLDER_NAME_HINT,
} from "./membership-checkout-core.js";
import {
  describeSubscription,
  pollSubscriptionActivation,
  subscriptionPricePence,
  tierFromSubscribeRoute,
  ACTIVATION_POLL_ATTEMPTS,
  ACTIVATION_POLL_INTERVAL_MS,
} from "./membership-subscribe-core.js";
import { tierMeta, MEMBERSHIP_ROUTE } from "./membership-tier.js";

/** The screen container id (the `<section>` this module owns in index.html). */
const SCREEN_ID = "membership-subscribe-screen";

// Mount generation (TM-629): bumped on every enterMembershipSubscribe() so async work started for an
// EARLIER mount (the activation poll, the widget mount) can tell it has gone stale. The router only
// hides this section on navigation — it never cancels our async work — so before this existed a poll
// started on one visit would later paint "You're subscribed!" into a re-rendered / hidden screen
// (e.g. after hopping to the OTHER tier's subscribe route, which re-mounts and clears the section).
let mountGeneration = 0;

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
 *
 * The loop itself is the node-tested pollSubscriptionActivation (TM-629). Two regressions it fixes:
 *   • success now requires a genuinely ACTIVATED subscription (subscriptionActivatedFor — canCancel,
 *     i.e. ACTIVE/PAST_DUE): a re-subscriber's stale CANCELED same-tier row used to satisfy the old
 *     `subscribed && tier` check on the FIRST tick, declaring success before the webhook activated
 *     anything (and even if it never did);
 *   • the poll is tied to its mount generation: navigating away / re-mounting the screen makes it
 *     "stale" and it renders nothing, instead of painting success copy into the re-rendered section.
 */
async function pollActivation(section, tier, generation) {
  const outcome = await pollSubscriptionActivation({
    fetchSubscription: () => api.getSubscription(),
    tier,
    attempts: ACTIVATION_POLL_ATTEMPTS,
    sleep: () => new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_INTERVAL_MS)),
    isStale: () => generation !== mountGeneration,
  });
  if (outcome === "stale") return; // the mount is gone — never touch the section
  if (outcome === "active") {
    reflectDone(section, `You're subscribed! Your ${tierMeta(tier).label} membership is active.`);
    return;
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
async function startSubscribePayment(section, tier, generation) {
  // In-flight guard (TM-629): the Continue-to-payment button used to stay clickable while the checkout
  // POST + SDK load ran, so an impatient double-click created TWO server-side checkouts and mounted the
  // widget twice. Disabled for the duration; re-enabled on every failure path so "try again" works.
  const startBtn = section.querySelector(".tm-subscribe-start");
  if (startBtn) {
    if (startBtn.disabled) return; // a checkout is already in flight
    startBtn.disabled = true;
  }
  const failStart = (text) => {
    setStatus(section, text);
    if (startBtn) startBtn.disabled = false;
  };
  setStatus(section, "Starting secure card payment…");

  let checkout;
  try {
    checkout = await api.subscriptionCheckout(tier);
  } catch (err) {
    failStart(`Could not start the checkout: ${err?.message ?? err}`);
    return;
  }
  const token = checkout && checkout.paymentToken;
  if (!token) {
    failStart("Checkout could not be initialised. Please try again.");
    return;
  }

  let RevolutCheckout;
  let instance;
  try {
    RevolutCheckout = await loadRevolutSdk();
    instance = await RevolutCheckout(token, paymentsConfig().revolutMode || "sandbox");
  } catch (err) {
    failStart(`Payment is unavailable right now: ${err?.message ?? err}`);
    return;
  }

  const host = section.querySelector(".tm-subscribe-widget");
  if (host) clear(host);

  // The "Name on card" field (TM-639): Revolut rejects the charge unless the cardholder name is at least
  // two words, and the card field renders no name input of its own — so we render our own, pre-filled with
  // the caller's profile display name (best-effort; editable; its read never blocks the charge) and pass
  // the validated value to cardField.submit({ name }) below.
  let displayName = "";
  try {
    const me = await api.getMe();
    if (me && typeof me.displayName === "string") displayName = me.displayName;
  } catch {
    // No profile read — the field just starts empty and the user types their name.
  }
  const { field: nameField, input: nameInput, error: nameError } = buildCardholderNameField(displayName);
  const pay = section.querySelector(".tm-subscribe-pay");
  // Render the name field ABOVE the card-number widget host so the box reads top-to-bottom: name → card
  // → Subscribe button.
  if (pay && host) pay.insertBefore(nameField, host);

  const amount = Number.isFinite(checkout.amountPence) ? checkout.amountPence : subscriptionPricePence(tier);
  const payBtn = el("button", {
    type: "button",
    class: "tm-btn tm-btn-primary tm-subscribe-pay-btn",
    text: `Subscribe · ${formatPrice(amount)}/month`,
  });

  // The card field, themed to the Paper look via `styles` (TM-639: the number / expiry / CVC inputs live
  // in Revolut's iframe, so they can only be styled through this object, never our CSS). The card is saved
  // for MERCHANT-initiated renewals: per the RevolutCheckout.js contract that flag — like the cardholder
  // `name` — is SUBMIT-time metadata, so it is passed to cardField.submit() below. It was moved off
  // createCardField in TM-639, where the contract silently ignored it (so the mandate may never actually
  // have been saved). The SCA/3DS challenge still runs on this first charge; renewals then charge off-session.
  const cardField = instance.createCardField({
    target: host,
    styles: revolutCardFieldStyles(),
    onSuccess: () => {
      setStatus(section, "Payment received — activating your subscription…");
      pollActivation(section, tier, generation);
    },
    onError: (message) => {
      setStatus(section, `Payment failed: ${message?.message ?? message ?? "please try again"}`);
      payBtn.disabled = false; // let the user retry the charge after a decline (TM-629)
    },
  });

  payBtn.addEventListener("click", () => {
    // In-flight guard (TM-629): a double-click used to submit the card field twice while the first
    // charge was still processing. Re-enabled in onError above so a declined card can be retried.
    if (payBtn.disabled) return;
    // Cardholder-name gate (TM-639): never send a name Revolut will reject — require two words and show
    // the inline hint instead of submitting. The button stays ENABLED so the user can fix it and retry.
    const name = nameInput.value;
    if (!isValidCardholderName(name)) {
      nameError.textContent = CARDHOLDER_NAME_HINT;
      nameInput.focus();
      return;
    }
    nameError.textContent = "";
    payBtn.disabled = true;
    setStatus(section, "Processing payment…");
    cardField.submit({ name: normalizeCardholderName(name), savePaymentMethodFor: "merchant" });
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
function renderSubscribe(section, tier, generation) {
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
    onClick: () => startSubscribePayment(section, tier, generation),
  });
  section.appendChild(
    el("div", { class: "tm-subscribe-pay tm-wobble", dataset: { provider: "revolut" } }, [
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
  // A fresh mount: anything still running for an earlier visit (the activation poll) is now stale.
  const generation = ++mountGeneration;
  const tier = tierFromSubscribeRoute(window.location.hash);
  if (!tier) {
    // router.js accepts ANY suffix under #/membership/subscribe/ (tier validity is this screen's job),
    // so a mistyped/garbage tier (#/membership/subscribe/GOLD) lands here. This used to `return`
    // silently, leaving the VISIBLE section empty — a blank screen with no copy and no way back
    // (TM-629). Render an honest "choose a plan" fallback with the way back instead.
    clear(section);
    section.appendChild(el("h2", { class: "tm-subscribe-title", text: "Choose a plan" }));
    section.appendChild(
      el("p", {
        class: "tm-subscribe-unknown-tier",
        text: "That subscription link isn't one of our plans — pick one from the membership screen.",
      }),
    );
    section.appendChild(
      el("a", { class: "tm-btn tm-btn-primary", href: MEMBERSHIP_ROUTE, text: "See membership plans" }),
    );
    return;
  }

  try {
    const view = describeSubscription(await api.getSubscription());
    if (generation !== mountGeneration) return; // re-mounted while the read was in flight (TM-629)
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
  renderSubscribe(section, tier, generation);
}
