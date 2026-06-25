// Push-notifications client (TM-279, epic TM-277) — registers the native device with FCM on login
// and hands its registration token to the backend so the send-push service (TM-284) can target it.
//
// WHERE THIS RUNS. The web app is a no-bundler static SPA served from teammarhaba.web.app and loaded
// either by a normal browser OR inside the Capacitor Android shell (TM-278), which loads the SAME
// hosted URL via `server.url`. So this one file ships to every surface; it must be INERT on the web
// and only do real work inside the native shell. Two gates enforce that:
//   1. `isWebViewEnv()` (auth-env.js) — the shell signals itself (window.TEAMMARHABA_WEBVIEW / the
//      TeamMarhabaWebView bridge), same signal auth uses for redirect-vs-popup.
//   2. `Capacitor.isNativePlatform()` + the PushNotifications plugin actually being injected — the
//      native runtime only exists in the shell; a plain browser has no `window.Capacitor`.
// On the browser/PWA build neither holds, so the whole module no-ops (no permission prompt, no plugin
// call) and the web experience is unchanged. (WEB-platform push via the FCM JS SDK is a separate,
// later concern; this ticket is the native client.)
//
// HOW THE PLUGIN IS REACHED. Because there's no bundler, we can't `import` from
// `@capacitor/push-notifications` (that's a node_modules package resolved at build time). Capacitor
// injects the plugin proxies onto `window.Capacitor.Plugins` at runtime inside the WebView, so we
// reach `PushNotifications` there (see push-env.js `getPushPlugin`). The npm dep is still required —
// `cap sync` uses it to compile the NATIVE (Android/FCM) half into the APK; this file only drives its
// JS bridge. The env-gating (getPushPlugin / isPushSupported) lives in the Firebase-free push-env.js
// so it's unit-testable under `node --test`.
//
// LIFECYCLE.
//   • On a sign-IN transition (signed-out → signed-in): request the OS notification permission
//     (Android 13+ POST_NOTIFICATIONS prompt) and, if granted, call register() — which makes the
//     device fetch its FCM token and fire the `registration` listener.
//   • `registration` listener → POST the token (+ platform ANDROID) to /api/v1/me/devices. FCM also
//     re-fires this listener when it ROTATES the token, so refresh is handled by the same path (the
//     backend upsert is idempotent and re-points the token at the caller).
//   • On a sign-OUT transition (signed-in → signed-out): DELETE the last-registered token so a signed-
//     out device stops receiving this user's pushes. Best-effort; the backend DELETE is idempotent.
//
// Consumers: loaded as a module from index.html; nothing imports from it. Listeners are attached once.

import { onAuthChanged } from "./auth.js";
import { getPushPlugin, isPushSupported } from "./push-env.js";
import { routeFromNotification, DEFAULT_ROUTE } from "./push-deeplink.js";
import { registerDevice, deregisterDevice } from "./api.js";
import { toast } from "./ui.js";

/** This client only registers Android devices (the only native shell today — TM-277/TM-278). */
const PLATFORM = "ANDROID";

// The most-recently-registered FCM token, kept so sign-out can deregister exactly that token. Lives
// only in memory (never persisted/logged) — Firebase/FCM owns token storage and rotation.
let currentToken = null;
// Guard so the plugin listeners are attached exactly once for the page's lifetime, even though
// onAuthChanged can fire many times (every sign-in/out + token bootstrap on reload).
let listenersAttached = false;

// Deep-link cold-start buffer (TM-285). When the app is LAUNCHED by a notification tap, the
// `pushNotificationActionPerformed` listener can fire before the hash router + auth have finished
// their first pass; navigating then would race the router's boot guard. So if we're not ready yet we
// stash the intended route here and replay it once auth resolves its first state (see initPush).
let pendingRoute = null;
// Becomes true after the first auth-state callback, i.e. once the router has run its initial guard
// and it's safe to navigate. Until then taps are buffered into `pendingRoute`.
let routerReady = false;

/**
 * Navigate the hash router to `route` by setting `window.location.hash`. The router (router.js)
 * listens for `hashchange` and re-runs its guard, so this single line gets us the FULL auth /
 * onboarding / admin enforcement for free: a deep-link to a protected view while signed-out is
 * remembered (tm.intendedRoute) and bounced to login → replayed after sign-in; an un-onboarded user
 * is held at the gate; a non-admin tapping an admin link is sent home. We only ever hand the router a
 * same-app hash route (push-deeplink.js is the trust boundary), never an external URL.
 *
 * If the same hash is already in the bar, no `hashchange` fires — but then we're already on the
 * target view, which is the correct end state, so nothing more is needed.
 * @param {string} route a safe in-app hash route (e.g. "#/profile").
 * @param {object} [win=globalThis]
 */
function navigateTo(route, win = globalThis) {
  try {
    if (win.location && win.location.hash !== route) {
      win.location.hash = route;
    }
  } catch (err) {
    console.warn("[push] could not navigate to deep-link route:", err?.message ?? err);
  }
}

/**
 * Handle a notification TAP: resolve the payload to a safe route and navigate there. On a WARM tap
 * (app already open, router booted) we navigate immediately. On a COLD start (the tap LAUNCHED the
 * app) the router/auth may not have finished their first pass yet, so we buffer the route and let
 * initPush replay it once auth resolves. A payload with no usable route falls back to DEFAULT_ROUTE
 * so a tap always lands somewhere sensible.
 * @param {object} notification the Capacitor notification from the action event.
 */
function handleTap(notification) {
  const route = routeFromNotification(notification) || DEFAULT_ROUTE;
  if (routerReady) {
    navigateTo(route);
  } else {
    // Cold start: stash the most-recent intended route; initPush replays it when the router is ready.
    pendingRoute = route;
  }
}

/**
 * Attach the PushNotifications listeners once. `registration` arrives with the device's FCM token on
 * first register AND on every later token refresh, so it's the single place we send a token to the
 * backend. `registrationError` is surfaced to the console (non-fatal — the app works without push).
 * @param {object} plugin the PushNotifications plugin proxy.
 */
function attachListeners(plugin) {
  if (listenersAttached) return;
  listenersAttached = true;

  // Fired with the FCM registration token on success — and again whenever FCM rotates it, which is
  // how token refresh is handled (same idempotent upsert re-points the token at the caller).
  plugin.addListener("registration", async (token) => {
    const value = token && token.value;
    if (!value) return;
    currentToken = value;
    try {
      await registerDevice(value, PLATFORM);
    } catch (err) {
      // Non-fatal: a failed registration just means no push until next register; never break the app.
      console.warn("[push] could not register device token with backend:", err?.message ?? err);
    }
  });

  // Fired if the device couldn't obtain a token (e.g. Google Play services / FCM not set up — the
  // human google-services.json prereq). Surfaced quietly; push simply stays off.
  plugin.addListener("registrationError", (err) => {
    console.warn("[push] FCM registration failed:", err?.error ?? err);
  });

  // TAP (TM-285): fired when the user taps a notification — both when the app was already open (warm)
  // and when the tap launched the app (cold start). Capacitor wraps the tapped notification in
  // `action.notification`; we resolve its payload to a safe in-app route and navigate there (or
  // buffer it for cold start — see handleTap / initPush).
  plugin.addListener("pushNotificationActionPerformed", (action) => {
    handleTap(action && action.notification);
  });

  // FOREGROUND (TM-285): on Android, a notification arriving while the app is in the foreground does
  // NOT appear in the system tray — Capacitor delivers it here instead. Rather than dropping it
  // silently, surface an in-app toast with a "View" action that deep-links to the same route the tap
  // would. (Background/closed-app notifications still go to the system tray as normal.)
  plugin.addListener("pushNotificationReceived", (notification) => {
    const title = (notification && (notification.title || notification.body)) || "New notification";
    const route = routeFromNotification(notification);
    toast(title, {
      type: "info",
      // Only offer "View" when the payload actually carries a destination; a bare info toast otherwise.
      action: route ? { label: "View", onClick: () => navigateTo(route) } : null,
    });
  });
}

/**
 * Request the OS notification permission (Android 13+ shows the POST_NOTIFICATIONS prompt) and, if
 * granted, register with FCM. `register()` triggers the `registration` listener with the token. If
 * permission is denied we stop quietly — the user simply gets no push. Best-effort throughout: any
 * failure is logged, never thrown, so it can't break the post-login flow.
 * @param {object} plugin the PushNotifications plugin proxy.
 */
async function requestAndRegister(plugin) {
  try {
    attachListeners(plugin);
    let perm = await plugin.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await plugin.requestPermissions();
    }
    if (perm.receive !== "granted") {
      console.info("[push] notification permission not granted; skipping FCM registration");
      return;
    }
    // Hands off to FCM; the device's token arrives via the `registration` listener (now or on refresh).
    await plugin.register();
  } catch (err) {
    console.warn("[push] permission/registration step failed:", err?.message ?? err);
  }
}

/**
 * Deregister the last-known token from the backend on sign-out (best-effort, idempotent). Clears the
 * in-memory token afterwards regardless, so a later sign-in starts clean.
 */
async function deregisterOnSignOut() {
  const token = currentToken;
  currentToken = null;
  if (!token) return;
  try {
    await deregisterDevice(token);
  } catch (err) {
    console.warn("[push] could not deregister device token on sign-out:", err?.message ?? err);
  }
}

// Drive the lifecycle off auth state. We act on TRANSITIONS, not the raw event: onAuthChanged fires
// once on boot (with the restored user or null) and again on every sign-in/out. Tracking the previous
// state lets us register only on a real sign-IN (incl. the restored-session boot, which is correct —
// a returning signed-in user should (re)register) and deregister only on a real sign-OUT.
let wasSignedIn = false;

/**
 * Initialise the push lifecycle. No-op (returns false) unless running inside the native shell with
 * the plugin available, so the browser build is untouched. Exported for unit tests; auto-runs below.
 * @param {object} [win=globalThis]
 * @returns {boolean} whether push was wired (i.e. we're in a supported native environment).
 */
export function initPush(win = globalThis) {
  if (!isPushSupported(win)) return false;
  const plugin = getPushPlugin(win);

  // Attach ALL listeners eagerly at boot — including the deep-link tap/foreground ones (TM-285). This
  // is essential for COLD start: when a tap launches the app, the OS fires
  // `pushNotificationActionPerformed` very early, so the listener must already be bound by the time
  // the WebView loads — we can't wait until permission is (re)granted on a sign-in transition. Safe
  // to call here: it's idempotent (listenersAttached guard) and binding tap/foreground listeners
  // does nothing until an event actually arrives.
  attachListeners(plugin);

  onAuthChanged((user) => {
    const signedIn = Boolean(user);
    if (signedIn && !wasSignedIn) {
      // Sign-in (or restored session on boot): request permission + register with FCM.
      void requestAndRegister(plugin);
    } else if (!signedIn && wasSignedIn) {
      // Sign-out: drop this device's token so it stops receiving the user's pushes.
      void deregisterOnSignOut();
    }
    wasSignedIn = signedIn;

    // Cold-start deep-link replay (TM-285). The first auth callback means auth has resolved and the
    // hash router has run its initial guard, so it's now safe to navigate. Mark ready and flush any
    // route buffered by a launch-by-tap. Navigating sets the hash → the router applies the full
    // auth/onboarding/admin guard (incl. remembering a protected target for a not-yet-signed-in user).
    if (!routerReady) {
      routerReady = true;
      if (pendingRoute) {
        const route = pendingRoute;
        pendingRoute = null;
        navigateTo(route, win);
      }
    }
  });
  return true;
}

initPush();
