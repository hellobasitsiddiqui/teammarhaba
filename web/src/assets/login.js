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

const $ = (id) => document.getElementById(id);

const els = {
  // The signed-out panel IS the <form> (id="auth-signed-out") — same element, two roles.
  form: $("auth-signed-out"),
  email: $("email"),
  // Email-code flow.
  emailStep: $("emailcode-step-email"),
  codeStep: $("emailcode-step-code"),
  sentTo: $("emailcode-sent-to"),
  code: $("emailcode-code"),
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
  smsCode: $("sms-code"),
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

// Firebase / backend error code -> friendly message; fall back to the raw message.
const MESSAGES = {
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-password": "Please enter a password.",
  "auth/weak-password": "Password is too weak (at least 6 characters).",
  "auth/email-already-in-use": "That email is already registered — try signing in.",
  "auth/user-not-found": "No account for that email — try signing up.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/too-many-requests": "Too many attempts — please try again later.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/invalid-phone-number": "That phone number looks invalid — include the country code (e.g. +1…).",
  "auth/invalid-verification-code": "That code is not valid.",
  "auth/code-expired": "That code has expired — request a new one.",
  "auth/operation-not-allowed":
    "This sign-in method isn't enabled for the project (enable it in the Firebase console).",
};

function showError(err) {
  // ApiError (from the backend) and "" both already carry a human message; Firebase errors map by code.
  const msg = err ? MESSAGES[err.code] ?? err.message ?? String(err) : "";
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

// Every interactive control, disabled together while a request is in flight.
function controls() {
  return [
    els.email,
    els.code,
    els.sendCode,
    els.verifyCode,
    els.resendCode,
    els.backToEmail,
    els.phone,
    els.smsCode,
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

// Run an auth action with shared error/loading handling.
async function run(action) {
  showError(null);
  setBusy(true);
  try {
    await action();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

// ---- Email-code flow (default) -------------------------------------------------------------

let pendingEmail = null; // the address a code was sent to, used by verify + resend.

function showCodeStep(email) {
  pendingEmail = email;
  if (els.sentTo) els.sentTo.textContent = email;
  els.emailStep.hidden = true;
  els.codeStep.hidden = false;
  els.code?.focus();
}

function showEmailStep() {
  pendingEmail = null;
  els.codeStep.hidden = true;
  els.emailStep.hidden = false;
  if (els.code) els.code.value = "";
}

async function sendEmailCode() {
  const email = els.email.value.trim();
  await requestEmailCode(email);
  showCodeStep(email);
}

async function verifyAndSignIn() {
  const code = (els.code.value || "").trim();
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
  els.smsCode?.focus();
}

async function verifySms() {
  if (!smsConfirmation) throw new Error("Request an SMS code first.");
  await smsConfirmation.confirm((els.smsCode.value || "").trim());
}

els.smsSend?.addEventListener("click", () => run(sendSms));
els.smsVerify?.addEventListener("click", () => run(verifySms));

// ---- Existing email + password (kept working, nothing removed) -----------------------------

els.signIn?.addEventListener("click", () => run(() => signIn(els.email.value.trim(), els.password.value)));
els.signUp?.addEventListener("click", () => run(() => signUp(els.email.value.trim(), els.password.value)));
els.google?.addEventListener("click", () => run(() => signInWithGoogle()));
els.signOut?.addEventListener("click", () => run(() => signOut()));

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
    showEmailStep();
    if (els.alternatives) els.alternatives.hidden = true;
    els.tryAnother?.setAttribute("aria-expanded", "false");
    els.smsPhoneStep.hidden = false;
    els.smsCodeStep.hidden = true;
    smsConfirmation = null;
  }
  wasSignedIn = signedIn;
});
