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
export const firebaseConfig = {
  apiKey: "AIzaSyA9ldUUFAXiB1bS5p9yzclnqSjCwRCvNy4",
  authDomain: "teammarhaba.firebaseapp.com",
  projectId: "teammarhaba",
  storageBucket: "teammarhaba.firebasestorage.app",
  messagingSenderId: "58443206078",
  appId: "1:58443206078:web:a84994905b5e62f4853def",
};
