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
  sendEmailVerification,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

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

/** Sign in with Google (popup). Requires the Google provider enabled in the Firebase console. */
export function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
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
    signInWithGoogle,
    signOut,
    resendVerificationEmail,
  };
}

export { auth };
