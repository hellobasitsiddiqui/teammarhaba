// Sign-out subscription glue (TM-720) — a Firebase-free seam for "run this when the user signs out".
//
// Several view modules must reset per-user state on sign-out (events.js's listing cache, the
// notification-center foreground-push inbox, the open notification panel). They can't `import` auth.js
// at module top-level, because auth.js statically imports the Firebase SDK from an `https://` gstatic
// URL — which the Node test runner (`node --test web/tools/*.test.mjs`, the CI web gate) can't load,
// so any DOM module a test imports directly (e.g. notification-center-bell-gate.test.mjs) would break
// on the transitive Firebase import.
//
// This module keeps the static graph Firebase-free by DYNAMICALLY importing auth.js and subscribing to
// onAuthChanged only in a real browser. Under `node --test` the dynamic import rejects (no Firebase)
// and is swallowed — the callback simply never fires, which is exactly right for a headless unit test.
// It also degrades to the `window.tmAuth` bridge if that's already present, avoiding a second SDK load.

import { isSignedOut } from "./session-guard-core.js";

/**
 * Register `callback` to run whenever auth changes to a signed-out (no active user) state. Best-effort
 * and browser-only: outside a browser (or if Firebase can't load) it's an inert no-op. Returns nothing;
 * the subscription lives for the page's lifetime (these are module-level resets, never torn down).
 * @param {() => void} callback invoked on each auth change to signed-out.
 */
export function onSignedOut(callback) {
  if (typeof window === "undefined") return;
  const subscribe = (onAuthChanged) => {
    onAuthChanged((user) => {
      if (isSignedOut(user)) {
        try {
          callback();
        } catch (err) {
          console.warn("[auth-signout] sign-out handler failed:", err?.message ?? err);
        }
      }
    });
  };
  // Prefer the already-initialised bridge (no second SDK load); else dynamically import auth.js.
  const bridge = window.tmAuth;
  if (bridge && typeof bridge.onAuthChanged === "function") {
    subscribe(bridge.onAuthChanged);
    return;
  }
  import("./auth.js")
    .then((mod) => subscribe(mod.onAuthChanged))
    .catch((err) => console.warn("[auth-signout] auth unavailable; sign-out reset disabled:", err?.message ?? err));
}
