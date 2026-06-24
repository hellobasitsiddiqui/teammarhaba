// Firebase WEB app configuration (TM-105).
//
// These values are PUBLIC by design — the Firebase web "apiKey" is a project identifier
// that ships in every client, not a secret. Security is enforced server-side (the backend
// verifies Firebase ID tokens) and by Firebase Auth/security rules, never by hiding this.
// See the gitleaks allowlist in /.gitleaks.toml.
//
// Kept in its own module (not inlined in auth.js) so it's the single config seam: a deploy
// can swap it per environment later without touching the auth logic. Source of truth is the
// Firebase console (Project settings → Your apps → Web) / `firebase apps:sdkconfig web`.
//
// authDomain — FIRST-PARTY auth handler (TM-230). We point `authDomain` at our own Hosting
// origin (`teammarhaba.web.app`) instead of the default `teammarhaba.firebaseapp.com`. Firebase
// Hosting reserves and serves the `/__/auth/**` + `/__/firebase/**` handler paths on EVERY
// Hosting site automatically (they're matched before user rewrites, so the `**`→/index.html SPA
// rewrite in firebase.json never swallows them — no extra rewrite needed). Serving the handler
// from the SAME origin the app runs on makes the redirect/reCAPTCHA round-trip first-party, so
// Safari ITP / Chrome third-party-cookie+storage blocking can't strand it with "Missing initial
// state". This is the path that matters for the parked social/OAuth redirect (TM-200) AND for the
// phone-auth reCAPTCHA fallback redirect inside the WebView (TM-230 scope-note comment). Email-code
// (custom token) and SMS confirm don't redirect, so they're unaffected either way.
//
// Requires `teammarhaba.web.app` to be in the Firebase Auth "Authorized domains" list (it is by
// default for the project's own Hosting site) and the browser API key to allow the auth endpoints —
// handled in TM-241 (Done). To roll back to the default handler, set this to
// "teammarhaba.firebaseapp.com".
export const firebaseConfig = {
  apiKey: "AIzaSyA9ldUUFAXiB1bS5p9yzclnqSjCwRCvNy4",
  authDomain: "teammarhaba.web.app",
  projectId: "teammarhaba",
  storageBucket: "teammarhaba.firebasestorage.app",
  messagingSenderId: "58443206078",
  appId: "1:58443206078:web:a84994905b5e62f4853def",
};
