// Firebase Auth bootstrap for the (framework-free) web app — TM-105 / 2.2.1.
//
// Loads the Firebase JS SDK from the gstatic CDN as ES modules, matching the no-bundler
// static setup (no build step, just files served by nginx / Firebase Hosting). Exposes a
// tiny auth helper; there is intentionally NO sign-in UI here (that's TM-106 / 2.2.3).
//
// Consumers:
//   - ES modules:  import { getIdToken, onAuthChanged, currentUser } from "./auth.js";
//   - classic <script>: the same helpers are mirrored on `window.tmAuth` for the
//     framework-free page code until a real bundler/framework lands.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  sendEmailVerification,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  RecaptchaVerifier,
  signInWithPhoneNumber,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { shouldUseRedirect } from "./auth-env.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Browser-e2e only (TM-134): when the runtime config points at a local Firebase Auth emulator,
// route all auth through it. `authEmulatorHost` is null in every real environment, so this is a
// no-op in dev/prod and production auth is untouched. Must run before any other auth call.
const emulatorHost = window.TEAMMARHABA_CONFIG && window.TEAMMARHABA_CONFIG.authEmulatorHost;
if (emulatorHost) {
  connectAuthEmulator(auth, `http://${emulatorHost}`, { disableWarnings: true });
}

// Keep the user signed in across reloads (best-effort; never block init on it).
setPersistence(auth, browserLocalPersistence).catch((err) =>
  console.warn("[auth] could not set persistence:", err?.code ?? err)
);

// Complete any redirect-based sign-in that's coming back to us (TM-230). On mobile / inside the
// Android WebView we use `signInWithRedirect` for OAuth providers (see `signInWithGoogle`), which
// navigates away to the auth handler and back; the result must be reclaimed on load or the user
// lands signed-out despite a successful round-trip ("Missing initial state"). `onAuthChanged` then
// fires with the user as normal, so the rest of the app needs no redirect-specific code. This is a
// no-op (resolves null) on a normal page load with no pending redirect, and harmless on desktop
// (which uses popup). Best-effort: a failure here must not break boot — it's surfaced to the
// console and (since onAuthChanged won't fire signed-in) the user simply sees the sign-in panel.
//
// `redirectResult` is exported (and wrapped by `awaitRedirectResult()`) so the sign-in UI (login.js)
// can await it and show any redirect-flow error inline instead of swallowing it.
export const redirectResult = getRedirectResult(auth).catch((err) => {
  console.warn("[auth] redirect sign-in did not complete:", err?.code ?? err);
  // Re-throw shape kept minimal; callers that care await `awaitRedirectResult()` which re-surfaces.
  throw err;
});

/**
 * Await completion of a pending redirect sign-in (TM-230). Resolves to the `UserCredential` when a
 * redirect just completed, `null` on a normal load (no redirect pending), and REJECTS with the
 * Firebase error if the redirect flow failed — so the UI can show it. Safe to call on every page
 * load; only the redirect-return load resolves to a credential.
 * @returns {Promise<import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").UserCredential|null>}
 */
export function awaitRedirectResult() {
  return redirectResult;
}

/** The currently signed-in Firebase user, or null when signed out. */
export function currentUser() {
  return auth.currentUser;
}

/**
 * Resolve a fresh Firebase ID token for the signed-in user (to send as a Bearer token,
 * TM-108), or null when signed out.
 * @param {boolean} [forceRefresh=false] force-refresh even if the cached token is valid.
 * @returns {Promise<string|null>}
 */
export function getIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  return user ? user.getIdToken(forceRefresh) : Promise.resolve(null);
}

/**
 * Subscribe to auth-state changes.
 * @param {(user: import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").User | null) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onAuthChanged(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Create a new account with email + password (signs the user in on success), then trigger a
 * Firebase verification email for the new address (TM-165). Firebase owns the email delivery and
 * the `emailVerified` flag — we never store it ourselves. Sending the email is best-effort: a
 * failure there (e.g. a transient mail hiccup) must not fail an otherwise-successful sign-up, and
 * the user can always re-request via `resendVerificationEmail` / the backend resend endpoint.
 * @returns {Promise<import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").UserCredential>}
 */
export async function signUp(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await sendEmailVerification(credential.user);
  } catch (err) {
    console.warn("[auth] could not send verification email on sign-up:", err?.code ?? err);
  }
  return credential;
}

/**
 * Re-send the verification email to the currently signed-in user via Firebase (TM-165). Used by the
 * client when it already holds the Firebase `User`; the backend also exposes
 * `POST /api/v1/me/resend-verification` (rate-limited) for callers that only have a Bearer token.
 * @returns {Promise<void>}
 */
export function resendVerificationEmail() {
  const user = auth.currentUser;
  return user ? sendEmailVerification(user) : Promise.reject(new Error("not signed in"));
}

/** Sign in with an existing email + password. */
export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/**
 * Complete a passwordless email-code sign-in (TM-234): exchange the Firebase **custom token** the
 * backend minted (after it verified the 6-digit code — see `verifyEmailCode` in api.js) for a real
 * Firebase session via `signInWithCustomToken`. From here on it's an ordinary Firebase session —
 * same ID tokens, same backend verification — so nothing else in the app needs to know how the user
 * signed in. The default front door; email+password still works unchanged.
 * @param {string} customToken the Firebase custom token from POST /auth/email-code/verify.
 * @returns {Promise<import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").UserCredential>}
 */
export function signInWithEmailCodeToken(customToken) {
  return signInWithCustomToken(auth, customToken);
}

/**
 * Begin an SMS phone sign-in (TM-234, the "try another way" option) using Firebase Phone Auth.
 * Renders an invisible reCAPTCHA into `containerEl` (Firebase requires it as the abuse guard), sends
 * the code to `phoneNumber` (E.164, e.g. "+15555550123"), and returns the `ConfirmationResult` whose
 * `.confirm(code)` finishes sign-in.
 *
 * <p>Real SMS needs the Firebase **Phone** provider enabled in the console (Blaze plan, paid per SMS)
 * — that's the separate human ticket **TM-239**; this path is built + tested now against the Auth
 * emulator's test numbers (no real SMS, no reCAPTCHA challenge), so enabling the provider later needs
 * no code change. We create a fresh verifier per attempt and clear any previous one so a retry can't
 * reuse a solved/expired widget.
 *
 * @param {string} phoneNumber E.164 phone number to text the code to.
 * @param {HTMLElement} containerEl element to host the invisible reCAPTCHA.
 * @returns {Promise<import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").ConfirmationResult>}
 */
export async function startPhoneSignIn(phoneNumber, containerEl) {
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      /* already cleared/never rendered — non-fatal. */
    }
  }
  recaptchaVerifier = new RecaptchaVerifier(auth, containerEl, { size: "invisible" });
  return signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier);
}

/** The live reCAPTCHA verifier for the in-flight phone sign-in, or null between attempts. */
let recaptchaVerifier = null;

/**
 * Sign in with Google (TM-230). Uses `signInWithRedirect` on mobile browsers and inside the Android
 * WebView — a popup is blocked/mis-handled on phones and impossible inside a WebView — and keeps the
 * snappier `signInWithPopup` on desktop. The redirect path navigates away to the Firebase auth
 * handler and back; `awaitRedirectResult()` (resolved at module load, above) reclaims the result, so
 * on redirect this function returns a promise that resolves to `undefined` AFTER the navigation
 * starts (the page is leaving), while on desktop it resolves to the popup `UserCredential`.
 *
 * Requires the Google provider enabled in the Firebase console (parked under TM-200) AND the auth
 * handler served first-party so Safari ITP / third-party-cookie blocking can't strand the redirect —
 * delivered via the `authDomain` → our Hosting origin in firebase-config.js + docs/agents/webview-auth-contract.md (TM-230).
 * @returns {Promise<import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js").UserCredential|void>}
 */
export function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  return shouldUseRedirect() ? signInWithRedirect(auth, provider) : signInWithPopup(auth, provider);
}

/** Sign the current user out. */
export function signOut() {
  return firebaseSignOut(auth);
}

/**
 * Resolve the caller's role from the verified ID token's custom claims (the `role` claim set in
 * TM-110 — the same value the backend authorizes on). Returns {@code "USER"} when signed out or
 * when no recognised claim is present, so the UI fails safe to the least-privileged view.
 * @param {boolean} [forceRefresh=false] force-refresh the token first (e.g. just after a promotion).
 * @returns {Promise<string>} the upper-cased role, e.g. {@code "ADMIN"} / {@code "USER"}.
 */
export function getRole(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) return Promise.resolve("USER");
  return user
    .getIdTokenResult(forceRefresh)
    .then((result) => {
      const role = result.claims && result.claims.role;
      return typeof role === "string" ? role.toUpperCase() : "USER";
    })
    .catch(() => "USER");
}

// Bridge for the framework-free page (classic scripts can't `import`). Lets the sign-in UI
// and ad-hoc console checks reach the helpers without a bundler.
if (typeof window !== "undefined") {
  window.tmAuth = {
    auth,
    currentUser,
    getIdToken,
    getRole,
    onAuthChanged,
    signUp,
    signIn,
    signInWithEmailCodeToken,
    startPhoneSignIn,
    signInWithGoogle,
    awaitRedirectResult,
    signOut,
    resendVerificationEmail,
  };
}

// `app` is exported so sibling SDK helpers (e.g. storage.js / TM-166) can reuse the single
// initialised Firebase app instead of calling initializeApp again.
export { app, auth };
