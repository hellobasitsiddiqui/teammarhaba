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
  createRevolutSdkLoader,
  formatPrice,
  isValidCardholderName,
  normalizeCardholderName,
  CARDHOLDER_NAME_HINT,
  createCardSubmitController,
  summarizeCardValidation,
  PAYMENT_STUCK_HINT,
  PAYMENT_SUBMIT_STATE,
  CHECKOUT_MODE,
  PRICE_KIND,
  TIER,
} from "./membership-checkout-core.js";

/** The screen container id (the `<section>` this module owns in index.html). */
const SCREEN_ID = "membership-checkout-screen";
/** The Pay mount point id — the seam the Revolut checkout widget mounts into (TM-478). */
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
 * Build the Pay mount point — the seam the real Revolut card widget (TM-478) drops into. It carries a
 * charge line, an empty widget host the RevolutCheckout.js card field mounts into on demand, and an
 * aria-live status line for progress/errors. Empty + hidden until the caller chooses to pay (see
 * {@link startPayment}); the `data-provider="revolut"` marks the provider.
 *
 * The `amountPence` is SHOWN here (TM-606): the exact charge appears as a dedicated line so the Pay seam
 * states what the card step will take. A null/absent/zero amount (only the Free / Included / Upgrade
 * states carry none, and those never reveal this Pay seam) falls back to the generic copy.
 * @param {number|null} amountPence the charge to display alongside the card entry.
 * @returns {HTMLElement}
 */
function buildPayMount(amountPence) {
  const hasAmount = Number.isFinite(amountPence) && amountPence > 0;
  const priceText = hasAmount ? formatPrice(amountPence) : null;
  return el("div", { id: PAY_MOUNT_ID, class: "tm-checkout-pay-mount tm-wobble", dataset: { provider: "revolut" } }, [
    el("p", { class: "tm-checkout-pay-note", text: hasAmount ? `Pay ${priceText} by card` : "Pay by card" }),
    // The RevolutCheckout.js card field is mounted into this host on demand (startPayment).
    el("div", { class: "tm-checkout-pay-widget" }),
    // Progress / error copy — polite live region so a screen reader announces status changes.
    el("p", { class: "tm-checkout-pay-status", "aria-live": "polite", text: "" }),
  ]);
}

/**
 * Build the primary checkout action for a resolved price state (AC 2):
 *   • CONFIRM → a "Reserve my place" button (no payment);
 *   • PAY     → a "Continue to payment" button that reveals the Pay mount (TM-478 placeholder);
 *   • UPGRADE → an "Upgrade to attend" link to the membership/tier screen (TM-480).
 * PAY runs the real Revolut checkout (TM-478): {@link startPayment} creates the order server-side and
 * mounts the card widget with the returned token. CONFIRM's frictionless RSVP wiring is future work (the
 * screen is not routed yet), so it exposes the payload; UPGRADE navigates.
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
      if (isPay) {
        // Real Revolut checkout (TM-478): create the order server-side, then mount the card widget.
        startPayment(event, state);
        return;
      }
      // CONFIRM's frictionless RSVP call lands in a later ticket; expose the payload for that wiring.
      console.info("[membership-checkout] checkout intent:", checkoutPayload(event, state));
    },
  });
}

/** Read the client payment config (TM-478): the sandbox Revolut PUBLIC key + widget mode + SDK URL. */
function paymentsConfig() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return cfg.payments && typeof cfg.payments === "object" ? cfg.payments : {};
}

// The one shared, memoised SDK loader — built by the node-tested core factory (TM-629) with the real
// browser reads injected. The memoisation/retry contract lives (and is unit-tested) in
// membership-checkout-core.js: an in-flight load is shared, but NO failure path memoises its rejection
// — previously only `script.onerror` cleared the memo, so a missing config URL or a script that loaded
// without exposing `RevolutCheckout` left a permanently-cached rejection and "try again" could never
// succeed until a full page reload.
const revolutSdkLoader = createRevolutSdkLoader({
  getGlobal: () => (typeof window !== "undefined" ? window : undefined),
  getDocument: () => (typeof document !== "undefined" ? document : undefined),
  getScriptUrl: () => paymentsConfig().revolutScriptUrl,
});

/**
 * Load the Revolut checkout SDK (embed.js) from the configured sandbox CDN, once. Injects a PLAIN
 * external <script> — not a fingerprinted local ES module, so the deploy fingerprinter (TM-144) leaves
 * it untouched — and resolves with the global `RevolutCheckout(token, mode)` once available. The load
 * promise is memoised while in flight; EVERY failure (missing config URL, load error, SDK loaded but
 * unusable) leaves the loader retryable rather than caching the rejection (TM-629). Rejects if the URL
 * is absent or the script fails to load.
 *
 * Exported since TM-620: the Subscribe checkout screen (membership-subscribe.js) mounts the same
 * widget for the first subscription charge, so both screens share this one memoised loader.
 * @returns {Promise<Function>} the global RevolutCheckout loader.
 */
export function loadRevolutSdk() {
  return revolutSdkLoader();
}

/**
 * Read the Paper theme values for the Revolut card field's `styles` option (TM-639). The card number /
 * expiry / CVC inputs render INSIDE Revolut's own iframe, so our stylesheet can never reach them — they
 * can only be themed through this object. We read the RESOLVED theme custom properties at runtime (so
 * dark mode + the per-user accent are honoured) with hard-coded Paper-ink fallbacks, and pin a 16px size
 * (comfortable, and it stops iOS zooming the page on focus). The hand-drawn Paper body font isn't loaded
 * inside the cross-origin iframe, so we pass a rounded system-font stack rather than a face that would
 * silently fall back to Times. Exported so the Subscribe checkout (membership-subscribe.js) themes its
 * card field identically.
 * @returns {object} a RevolutCheckout.js card-field `styles` object.
 */
export function revolutCardFieldStyles() {
  const read = (name, fallback) => {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    } catch {
      return fallback;
    }
  };
  return {
    default: {
      color: read("--fg", "#2b2b2b"),
      "font-family": '"Patrick Hand", "Comic Sans MS", ui-rounded, system-ui, sans-serif',
      "font-size": "16px",
      "::placeholder": { color: read("--muted", "#6b6b6b") },
    },
    invalid: { color: read("--danger", "#b00020") },
  };
}

/**
 * Build the "Name on card" field both payment views render (TM-639). Revolut rejects a one-word
 * cardholder name AND the card field renders no name input of its own, so both the per-event Pay flow and
 * the Subscribe checkout drop this required text input ABOVE the card iframe, pre-filled with the caller's
 * profile display name (a best-effort convenience — the field is editable and the profile read never
 * blocks the charge). Returns the wrapper plus direct handles to the input and the inline (aria-live)
 * error node, so the caller can read the value, focus it, and set the hint without re-querying the DOM.
 * XSS-safe: built with ui.js `el()` (textContent only). Themed by the shared `.tm-cardholder-*` rules in
 * membership-checkout.css (the `.tm-input` base + hand-drawn wobble come from styles.css).
 * @param {string} [displayName] the value to pre-fill (the caller's profile display name).
 * @returns {{field: HTMLElement, input: HTMLInputElement, error: HTMLElement}}
 */
export function buildCardholderNameField(displayName = "") {
  const input = el("input", {
    type: "text",
    class: "tm-input tm-cardholder-input",
    name: "cardholder-name",
    autocomplete: "cc-name",
    placeholder: "Name on card",
    required: true,
  });
  // Pre-fill the DOM value property (not a value attribute) so an editable, well-formed field starts
  // populated; a single-word display name (e.g. "Basit") is left as-is and simply fails validation on
  // submit, prompting the user to add a surname — never sent to Revolut.
  if (typeof displayName === "string" && displayName.trim()) input.value = displayName;
  const error = el("p", { class: "tm-cardholder-error", "aria-live": "polite", text: "" });
  const field = el("div", { class: "tm-cardholder-field" }, [
    el("label", { class: "tm-cardholder-label" }, [
      el("span", { class: "tm-cardholder-label-text", text: "Name on card" }),
      input,
    ]),
    error,
  ]);
  return { field, input, error };
}

/** Set the Pay mount's aria-live status line (progress / error copy). No-op if the mount is gone. */
function setPayStatus(mount, text) {
  const status = mount && mount.querySelector(".tm-checkout-pay-status");
  if (status) status.textContent = text;
}

/**
 * Reflect a settled payment in the Pay mount (TM-478): the RSVP is confirmed server-side by the payment
 * webhook, so the client just replaces the card widget with a paid confirmation. Purely cosmetic.
 */
function reflectPaid(mount, text) {
  if (!mount) return;
  clear(mount);
  mount.append(el("p", { class: "tm-checkout-pay-status tm-checkout-pay-paid", "aria-live": "polite", text }));
}

/**
 * Run the PAY flow (TM-478): create the checkout order server-side (`api.checkout`), then mount the
 * Revolut card field with the returned order token and charge on submit. On success the RSVP is confirmed
 * server-side by the payment webhook; the client reflects the paid state. Every failure renders an inline,
 * NON-throwing status message — a payment hiccup must never white-screen the checkout screen.
 * @param {object} event the event being paid for.
 * @param {object} state the resolved price state (carries amountPence for the button label).
 */
async function startPayment(event, state) {
  const mount = typeof document !== "undefined" ? document.getElementById(PAY_MOUNT_ID) : null;
  if (!mount) return;
  mount.hidden = false;
  setPayStatus(mount, "Starting secure card payment…");

  let result;
  try {
    result = await api.checkout(event?.id);
  } catch (err) {
    console.warn("[membership] event checkout start failed:", err?.status ?? "", err?.message ?? err);
    setPayStatus(mount, "Couldn't start payment. Please try again.");
    return;
  }

  // A frictionless confirm slipped through (e.g. an entitlement change) — reflect it, no card needed.
  if (result && result.paymentRequired === false) {
    reflectPaid(mount, "You're confirmed for this event.");
    return;
  }
  const token = result && result.paymentToken;
  if (!token) {
    setPayStatus(mount, "Payment could not be initialised. Please try again.");
    return;
  }

  try {
    await mountRevolutCard(mount, token, state);
  } catch (err) {
    setPayStatus(mount, `Payment is unavailable right now: ${err?.message ?? err}`);
  }
}

/**
 * Mount the Revolut card field into the Pay mount and wire a Pay button that submits it (TM-478). Loads
 * the SDK, initialises it with the order `token` + configured sandbox mode, renders the card field into
 * the widget host, and charges on the Pay button. `onSuccess` reflects the paid state; `onError` surfaces
 * the reason inline. Built against the documented sandbox RevolutCheckout.js card-field contract — the
 * exact success/submit callback shape is an API-shape assumption flagged for the live smoke test.
 * @param {HTMLElement} mount the Pay mount element.
 * @param {string} token the Revolut order token from checkout.
 * @param {object} state the resolved price state (amountPence for the button label).
 */
async function mountRevolutCard(mount, token, state) {
  const RevolutCheckout = await loadRevolutSdk();
  const mode = paymentsConfig().revolutMode || "sandbox";
  const instance = await RevolutCheckout(token, mode);

  const host = mount.querySelector(".tm-checkout-pay-widget");
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
  // Render the name field ABOVE the card iframe so the box reads top-to-bottom: name → card → Pay.
  if (host) mount.insertBefore(nameField, host);

  const priceText =
    Number.isFinite(state?.amountPence) && state.amountPence > 0 ? formatPrice(state.amountPence) : null;
  const payBtn = el("button", {
    type: "button",
    class: "tm-btn tm-checkout-pay-btn",
    text: priceText ? `Pay ${priceText}` : "Pay",
  });

  // Tracks the last card-field validity the widget reported (null = it never told us — treat as unknown
  // and let the submit proceed; the timeout backstop covers a genuinely stuck attempt). Set by onValidation.
  let cardValid = null;

  // The stuck-payment backstop (TM-642): a card the widget rejects/declines client-side sometimes calls
  // NEITHER onSuccess NOR onError, so before this the Pay button sat disabled on "Processing payment…"
  // forever. The node-tested controller owns the submit lifecycle (IDLE→PENDING→success|error|timeout)
  // and arms a real setTimeout backstop; onChange drives the DOM per state, and it swallows a late
  // onSuccess/onError after the attempt already settled (the double-fire guard).
  const submitCtl = createCardSubmitController({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    onChange: (state, detail) => {
      switch (state) {
        case PAYMENT_SUBMIT_STATE.PENDING:
          payBtn.disabled = true;
          setPayStatus(mount, "Processing payment…");
          break;
        case PAYMENT_SUBMIT_STATE.SUCCESS:
          reflectPaid(mount, "Payment received — you're confirmed for this event.");
          break;
        case PAYMENT_SUBMIT_STATE.ERROR:
          setPayStatus(mount, `Payment failed: ${detail?.message ?? detail ?? "please try again"}`);
          payBtn.disabled = false; // let the user retry the charge after a decline (TM-642)
          break;
        case PAYMENT_SUBMIT_STATE.TIMEOUT:
          // The backstop fired: no callback within the window. Clear "Processing payment…", show the
          // shared retryable hint, and re-enable so the button never stays stuck (TM-642).
          setPayStatus(mount, PAYMENT_STUCK_HINT);
          payBtn.disabled = false;
          break;
        default:
          break;
      }
    },
  });

  // The card field, themed to the Paper look via `styles` (TM-639): the number / expiry / CVC inputs live
  // in Revolut's iframe, so they can only be styled through this object, never our CSS.
  const cardField = instance.createCardField({
    target: host,
    styles: revolutCardFieldStyles(),
    // Feed the widget callbacks into the controller — it decides whether each is the FIRST settle for
    // the attempt (applies the effect) or a late no-op after the timeout already fired (TM-642).
    onSuccess: () => submitCtl.success(),
    onError: (message) => submitCtl.error(message),
    // Inline validation feedback if the SDK offers it (TM-642): surface an obviously-invalid card
    // (number/expiry/CVC) BEFORE submit so the Pay button ideally never enters the stuck state. Degrades
    // gracefully — an unknown payload shape is treated as "no verdict", leaving the timeout as backstop.
    onValidation: (payload) => {
      const { valid, message } = summarizeCardValidation(payload);
      cardValid = valid;
      // Don't stomp the live "Processing payment…" line while a charge is in flight; otherwise restore the
      // entry prompt when the card reads valid, or surface the inline hint (always present when invalid).
      if (submitCtl.getState() !== PAYMENT_SUBMIT_STATE.PENDING) {
        setPayStatus(mount, valid ? "Enter your card details to pay." : message);
      }
    },
  });

  payBtn.addEventListener("click", () => {
    // In-flight guard (TM-642): ignore a double-click while a charge is already processing. The
    // controller re-enables the button on error/timeout so a genuine retry still works.
    if (payBtn.disabled) return;
    // Cardholder-name gate (TM-639): never submit a name Revolut will reject — require two words and show
    // the inline hint instead of charging. The card field submits only once a valid two-word name is set.
    const name = nameInput.value;
    if (!isValidCardholderName(name)) {
      nameError.textContent = CARDHOLDER_NAME_HINT;
      nameInput.focus();
      return;
    }
    // Obviously-invalid card gate (TM-642): if the widget has explicitly told us the card is invalid,
    // surface it inline instead of submitting into the stuck state. `null`/valid → proceed.
    if (cardValid === false) {
      const { message } = summarizeCardValidation({ valid: false });
      setPayStatus(mount, message);
      return;
    }
    nameError.textContent = "";
    // begin() moves to PENDING (disables the button + sets "Processing payment…" via onChange) and arms
    // the timeout backstop; only then do we submit. begin() returns false only if already succeeded.
    if (!submitCtl.begin()) return;
    cardField.submit({ name: normalizeCardholderName(name) });
  });
  if (host) host.append(payBtn);
  setPayStatus(mount, "Enter your card details to pay.");
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
