// Auth UI controller (TM-106 / 2.2.2) — framework-free.
//
// Wires the sign-up / sign-in (email + Google) / sign-out controls in index.html to the
// Firebase auth module (TM-105). Reflects auth state, surfaces errors, and disables the
// form while a request is in flight. Firebase owns password rules / reset / verification.

import { onAuthChanged, signIn, signUp, signInWithGoogle, signOut } from "./auth.js";

const $ = (id) => document.getElementById(id);

const els = {
  // The signed-out panel IS the <form> (id="auth-signed-out") — same element, two roles.
  form: $("auth-signed-out"),
  email: $("email"),
  password: $("password"),
  signIn: $("signin-btn"),
  signUp: $("signup-btn"),
  google: $("google-btn"),
  error: $("auth-error"),
  signedOut: $("auth-signed-out"),
  signedIn: $("auth-signed-in"),
  userEmail: $("user-email"),
  signOut: $("signout-btn"),
};

// Firebase error code -> friendly message; fall back to the raw message.
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
  "auth/operation-not-allowed":
    "This sign-in method isn't enabled for the project (enable it in the Firebase console).",
};

function showError(err) {
  const msg = err ? MESSAGES[err.code] ?? err.message ?? String(err) : "";
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

function setBusy(busy) {
  [els.signIn, els.signUp, els.google, els.email, els.password].forEach((el) => {
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

els.form?.addEventListener("submit", (e) => {
  e.preventDefault();
  run(() => signIn(els.email.value.trim(), els.password.value));
});
els.signUp?.addEventListener("click", () =>
  run(() => signUp(els.email.value.trim(), els.password.value))
);
els.google?.addEventListener("click", () => run(() => signInWithGoogle()));
els.signOut?.addEventListener("click", () => run(() => signOut()));

// Reflect signed-in / signed-out state (also restores it across reloads).
onAuthChanged((user) => {
  showError(null);
  const signedIn = Boolean(user);
  if (els.signedOut) els.signedOut.hidden = signedIn;
  if (els.signedIn) els.signedIn.hidden = !signedIn;
  if (signedIn && els.userEmail) {
    els.userEmail.textContent = user.email ?? user.displayName ?? user.uid;
  }
  if (!signedIn && els.form) els.form.reset();
});
