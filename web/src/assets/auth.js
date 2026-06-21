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
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

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

// Bridge for the framework-free page (classic scripts can't `import`). Lets TM-106's
// sign-in UI and ad-hoc console checks reach the helpers without a bundler.
if (typeof window !== "undefined") {
  window.tmAuth = { auth, currentUser, getIdToken, onAuthChanged };
}

export { auth };
