// Auth UI controller (TM-106; reworked for passwordless email-code login in TM-234) — framework-free.
//
// Wires the signed-out panel in index.html to the Firebase auth module (TM-105) and the backend
// email-code endpoints (TM-234, via api.js). The DEFAULT front door is a 6-digit EMAIL code:
//   enter email → "Email me a code" → enter code → signed in (with a rate-limited Resend).
// "Try another way" reveals SMS (Firebase Phone Auth) + the existing email+password — nothing was
// removed, no user migration. Reflects auth state, surfaces errors, disables controls in flight.

import {
  onAuthChanged,
  signIn,
  signUp,
  signInWithGoogle,
  signOut,
  signInWithEmailCodeToken,
  startPhoneSignIn,
  awaitRedirectResult,
} from "./auth.js";
import { requestEmailCode, verifyEmailCode } from "./api.js";
import { isWebViewEnv } from "./auth-env.js";
import { authErrorMessage } from "./login-error.js";
import { attachOtpInput } from "./otp-input.js";
import { makeSingleFlight } from "./otp-input-core.js";

const $ = (id) => document.getElementById(id);

const els = {
  // The signed-out panel IS the <form> (id="auth-signed-out") — same element, two roles.
  form: $("auth-signed-out"),
  email: $("email"),
  // Email-code flow.
  emailStep: $("emailcode-step-email"),
  codeStep: $("emailcode-step-code"),
  sentTo: $("emailcode-sent-to"),
  codeGroup: $("emailcode-otp"), // TM-867: the six-box OTP group (was the single #emailcode-code input)
  sendCode: $("emailcode-send-btn"),
  verifyCode: $("emailcode-verify-btn"),
  resendCode: $("emailcode-resend-btn"),
  backToEmail: $("emailcode-back-btn"),
  // "Try another way" disclosure.
  tryAnother: $("try-another-btn"),
  alternatives: $("auth-alternatives"),
  // SMS flow.
  phone: $("phone"),
  smsPhoneStep: $("sms-step-phone"),
  smsCodeStep: $("sms-step-code"),
  smsCodeGroup: $("sms-otp"), // TM-867: the six-box OTP group (was the single #sms-code input)
  smsSend: $("sms-send-btn"),
  smsVerify: $("sms-verify-btn"),
  recaptcha: $("recaptcha-container"),
  // Existing email+password.
  password: $("password"),
  signIn: $("signin-btn"),
  signUp: $("signup-btn"),
  google: $("google-btn"),
  // Shared.
  error: $("auth-error"),
  signedIn: $("auth-signed-in"),
  userEmail: $("user-email"),
  signOut: $("signout-btn"),
};

// TM-867: the six-box OTP widgets (otp-input.js) over the static boxes in index.html. Typing the
// 6th digit / pasting a full code / a programmatic setValue (the TM-407 native-autofill seam) all
// land in onComplete, which auto-submits through the SAME single-flight `run()` wrapper as the
// visible "Sign in" buttons — one verify path, shared busy/error handling, no double-submit.
// (`run` / the verify functions are declared below; they're only *called* at event time, so the
// forward references are safe.) The visible buttons stay as an a11y / JS-edge-case fallback.
const emailOtp = attachOtpInput({ group: els.codeGroup, onComplete: () => run(verifyAndSignIn) });
const smsOtp = attachOtpInput({ group: els.smsCodeGroup, onComplete: () => run(verifySms) });

function showError(err) {
  // Friendly-message resolution lives in login-error.js: coded Firebase errors map by code (with a
  // generic fallback for unmapped codes — never the raw Firebase string), backend ApiErrors keep
  // their own human message, and a falsy err clears the banner.
  const msg = authErrorMessage(err);
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

// Every interactive control, disabled together while a request is in flight. The OTP boxes are
// spread in (TM-867) so a verify in flight greys out all twelve digit boxes with everything else.
function controls() {
  return [
    els.email,
    ...(emailOtp?.boxes ?? []),
    els.sendCode,
    els.verifyCode,
    els.resendCode,
    els.backToEmail,
    els.phone,
    ...(smsOtp?.boxes ?? []),
    els.smsSend,
    els.smsVerify,
    els.password,
    els.signIn,
    els.signUp,
    els.google,
  ];
}

function setBusy(busy) {
  controls().forEach((el) => {
    if (el) el.disabled = busy;
  });
  els.form?.setAttribute("aria-busy", String(busy));
}

// Deferred focus (TM-867 review fix): focus() on a DISABLED input is a spec-mandated no-op, and
// while an action runs inside run() every control — including all twelve OTP boxes — is disabled
// by setBusy(true). So actions never focus directly; they QUEUE a focus request here and run()
// applies it right after setBusy(false) re-enables the controls. The step-visibility guard stops
// a stale request from stealing focus if the user has already navigated away (e.g. tapped "Use a
// different email" the instant the request landed).
let pendingFocus = null; // () => void, applied once by run() after the busy window closes

function requestFocus(widget, stepEl) {
  pendingFocus = () => {
    if (stepEl?.hidden) return; // the step changed under us — don't yank focus somewhere stale
    widget?.focus(); // first box, selected — ready to (re)type the code
  };
}

// Run an auth action with shared error/loading handling. Single-flight (TM-867): the OTP widget's
// auto-submit can fire while a verify is already running (e.g. a paste races a click on the visible
// button, or a re-completed code after an error) — makeSingleFlight silently drops the re-entrant
// call, so a second request can never leave the door. setBusy's disabling already stops most
// double-triggers at the DOM; this guards the programmatic/synthetic paths it can't.
const run = makeSingleFlight(async (action) => {
  showError(null);
  setBusy(true);
  pendingFocus = null; // a fresh action owns the focus outcome — drop anything stale
  try {
    await action();
  } catch (err) {
    showError(err);
    // A FAILED verify disabled the very box the user was typing in (dropping focus to <body> and,
    // on iOS, dismissing the keyboard). Put focus back on the offending widget so a keyboard or
    // screen-reader user can immediately retype the code instead of tabbing back from the top.
    if (action === verifyAndSignIn) requestFocus(emailOtp, els.codeStep);
    else if (action === verifySms) requestFocus(smsOtp, els.smsCodeStep);
  } finally {
    setBusy(false);
    // Only now are the boxes enabled again — apply whatever focus the action (or the catch above)
    // queued. Cleared before calling so a re-entrant run can't double-apply it.
    const focusNow = pendingFocus;
    pendingFocus = null;
    focusNow?.();
  }
});

// ---- Email-code flow (default) -------------------------------------------------------------

let pendingEmail = null; // the address a code was sent to, used by verify + resend.

function showCodeStep(email) {
  pendingEmail = email;
  if (els.sentTo) els.sentTo.textContent = email;
  els.emailStep.hidden = true;
  els.codeStep.hidden = false;
  // Queued, not immediate: this runs inside run()'s busy window where the boxes are disabled and
  // a direct focus() would silently no-op (TM-867 review fix — the e2e spec pins this focus).
  requestFocus(emailOtp, els.codeStep);
}

function showEmailStep() {
  pendingEmail = null;
  els.codeStep.hidden = true;
  els.emailStep.hidden = false;
  emailOtp?.clear(); // a stale half-typed code must not survive into the next attempt
}

async function sendEmailCode() {
  const email = els.email.value.trim();
  await requestEmailCode(email);
  showCodeStep(email);
}

async function verifyAndSignIn() {
  // TM-867: the code is assembled from the six boxes by the widget (digits only by construction).
  const code = emailOtp?.value() ?? "";
  const customToken = await verifyEmailCode(pendingEmail, code);
  await signInWithEmailCodeToken(customToken);
}

// Submitting the form (the default action) sends the code; the verify button confirms it.
els.form?.addEventListener("submit", (e) => {
  e.preventDefault();
  // Only step 1 (email) is a submit; once on the code step the submit is inert.
  if (!els.emailStep.hidden) run(sendEmailCode);
});
els.verifyCode?.addEventListener("click", () => run(verifyAndSignIn));
els.resendCode?.addEventListener("click", () => run(() => requestEmailCode(pendingEmail)));
els.backToEmail?.addEventListener("click", () => {
  showError(null);
  showEmailStep();
});

// ---- "Try another way" disclosure ----------------------------------------------------------

els.tryAnother?.addEventListener("click", () => {
  const open = els.alternatives.hidden;
  els.alternatives.hidden = !open;
  els.tryAnother.setAttribute("aria-expanded", String(open));
});

// ---- SMS flow (Firebase Phone Auth) --------------------------------------------------------

let smsConfirmation = null; // ConfirmationResult from startPhoneSignIn; .confirm(code) finishes it.

async function sendSms() {
  const phone = els.phone.value.trim();
  smsConfirmation = await startPhoneSignIn(phone, els.recaptcha);
  els.smsPhoneStep.hidden = true;
  els.smsCodeStep.hidden = false;
  requestFocus(smsOtp, els.smsCodeStep); // deferred past the busy window, same as the email step
}

async function verifySms() {
  if (!smsConfirmation) throw new Error("Please request an SMS code first.");
  // TM-867: code assembled from the six SMS boxes (same widget as the email step).
  await smsConfirmation.confirm(smsOtp?.value() ?? "");
}

els.smsSend?.addEventListener("click", () => run(sendSms));
els.smsVerify?.addEventListener("click", () => run(verifySms));

// ---- Existing email + password (kept working, nothing removed) -----------------------------

els.signIn?.addEventListener("click", () => run(() => signIn(els.email.value.trim(), els.password.value)));
els.signUp?.addEventListener("click", () => run(() => signUp(els.email.value.trim(), els.password.value)));
els.google?.addEventListener("click", () => run(() => signInWithGoogle()));
els.signOut?.addEventListener("click", () => run(() => signOut()));

// Hide Google sign-in inside the Android WebView (TM-275). Google deliberately BLOCKS its OAuth
// flow inside embedded WebViews ("disallowed_useragent"), so the button can only ever error there —
// email-code, SMS, and email+password all work in the WebView, so we simply don't offer Google.
// Google stays available on desktop and mobile-browser (non-WebView) where it works. `isWebViewEnv`
// reads the native shell's signal (`window.TEAMMARHABA_WEBVIEW` / the JS bridge); on a normal page
// load it's false, so this is inert there. Interim measure until a native Google Sign-In path
// exists; the canonical fix is tracked separately.
if (isWebViewEnv()) {
  els.google?.closest(".auth-alt-google")?.remove();
}

// Complete a redirect-based sign-in coming back into the page (TM-230). On mobile / inside the
// Android WebView, Google sign-in uses `signInWithRedirect` (auth.js), so the user returns to a
// fresh page load after the auth handler round-trip. `onAuthChanged` already reflects a successful
// return; this only has to surface a FAILED redirect (e.g. the auth handler couldn't restore state —
// the "Missing initial state" error when third-party storage is blocked) so it doesn't fail
// silently. Resolves to null on a normal load with no pending redirect, so this is inert then.
awaitRedirectResult().catch((err) => showError(err));

// Reflect identity / reset on auth change. View visibility (which panel shows) is owned by the
// router/guard (TM-109); this only updates the form's own concerns: the displayed email, clearing
// errors, and resetting the flow back to the default email step on sign-out.
//
// The reset runs ONLY on an actual sign-OUT transition (was signed in → now not), NOT on the
// initial boot event — onAuthChanged fires once with user=null after Firebase initialises, and
// resetting then would wipe anything already typed during a slow auth boot and collapse the flow
// back to step 1 (TM-229: that boot reset raced the mobile e2e fill, submitting an empty email).
let wasSignedIn = false;
onAuthChanged((user) => {
  showError(null);
  const signedIn = Boolean(user);
  if (signedIn && els.userEmail) {
    els.userEmail.textContent = user.email ?? user.phoneNumber ?? user.displayName ?? user.uid;
  }
  if (!signedIn && wasSignedIn) {
    els.form?.reset();
    // form.reset() blanks the box ELEMENTS but not the widgets' internal state — clear both so a
    // stale code can't be resubmitted by the next completion (TM-867). showEmailStep() already
    // clears the email widget; the SMS one is ours to clear here.
    smsOtp?.clear();
    showEmailStep();
    if (els.alternatives) els.alternatives.hidden = true;
    els.tryAnother?.setAttribute("aria-expanded", "false");
    els.smsPhoneStep.hidden = false;
    els.smsCodeStep.hidden = true;
    smsConfirmation = null;
  }
  wasSignedIn = signedIn;
});
