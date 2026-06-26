// App-lock controller (TM-282) — require a biometric (or device PIN) to unlock when the app returns
// to the foreground, behind a per-device user setting that defaults OFF (an AC).
//
// Lifecycle:
//   - On boot (in the native shell, if the lock is enabled + usable) we lock immediately, so a
//     cold-start also demands auth, not just a resume.
//   - We listen for the app coming back to the foreground (Capacitor @capacitor/app `appStateChange`,
//     read via window.Capacitor.Plugins.App — same hosted-origin bridge rule as biometric.js) and
//     lock on resume.
//   - While locked we mount a full-screen opaque overlay (`#tm-biometric-lock`) that covers the app
//     content (so nothing sensitive is visible behind it) and immediately invoke the prompt; on
//     success we remove the overlay.
//   - To avoid a content flash, the overlay is mounted EAGERLY the instant we know native + lock
//     enabled — BEFORE the async usability check resolves — then torn back down if the device turns
//     out not to be lockable (TM-292). The cover is therefore always up before any async work.
//
// Fail-safe: this is a CONVENIENCE layer, not the security boundary — the backend (default-deny,
// TM-79) is. So if biometry becomes unavailable (sensor lockout, un-enrolled mid-session) we fail
// OPEN and unlock, rather than trapping the user in an app they can never get back into. A genuine
// non-match or a user-cancel keeps the overlay up with a retry button.
//
// Browser builds: `isNativeShell()` is false, so `init()` returns immediately and NOTHING is mounted
// or listened for — the web surface is completely unaffected (an AC).

import { isNativeShell, isBiometricAvailable, authenticate } from "./biometric.js";
import { isAppLockEnabled, shouldEngageLock } from "./biometric-policy.js";

let initialised = false;
let locked = false;
let overlay = null;
// Debounce concurrent prompt attempts (a fast resume can fire twice).
let prompting = false;

/** localStorage, but tolerant of environments where it throws on access. */
function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Build (once) and show the opaque lock overlay covering the app. */
function showOverlay(onUnlockClick) {
  if (overlay) {
    overlay.hidden = false;
    return;
  }
  const card = document.createElement("div");
  card.className = "tm-lock-card";

  const title = document.createElement("h1");
  title.className = "tm-lock-title";
  title.textContent = "TeamMarhaba is locked";

  const hint = document.createElement("p");
  hint.className = "tm-lock-hint";
  hint.textContent = "Unlock with your fingerprint or device PIN to continue.";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tm-btn tm-btn-primary tm-lock-unlock";
  btn.textContent = "Unlock";
  btn.addEventListener("click", onUnlockClick);

  card.append(title, hint, btn);

  overlay = document.createElement("div");
  overlay.id = "tm-biometric-lock";
  overlay.className = "tm-lock-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "App locked");
  overlay.append(card);
  document.body.append(overlay);
}

function hideOverlay() {
  if (overlay) overlay.hidden = true;
}

/** Run the biometric prompt; on success unlock, otherwise keep the overlay up (unless fail-open). */
async function promptUnlock() {
  if (prompting) return;
  prompting = true;
  try {
    const res = await authenticate({
      reason: "Unlock TeamMarhaba",
      title: "Unlock TeamMarhaba",
      subtitle: "Confirm it's you to continue",
      allowDeviceCredential: true,
    });
    if (res.ok) {
      unlock();
      return;
    }
    // Fail OPEN if biometry/credential is simply unavailable — never trap the user (see file header).
    if (res.reason === "unavailable") {
      unlock();
      return;
    }
    // "dismissed" or "failed": stay locked; the overlay's Unlock button lets them retry.
  } finally {
    prompting = false;
  }
}

/**
 * Mount the opaque overlay NOW, synchronously, without prompting yet (TM-292). Called the instant we
 * know we're native + lock-enabled, BEFORE the async usability check resolves, so app content is never
 * briefly visible on cold-start/resume. `maybeLock()` either upgrades this to a full {@link lock} (and
 * prompts) or tears it back down via {@link unlock} if the device turns out not to be lockable.
 */
function coverEagerly() {
  if (locked) return;
  showOverlay(promptUnlock);
}

/** Engage the lock: show the overlay (if not already up) + immediately prompt. */
function lock() {
  if (locked) return;
  locked = true;
  showOverlay(promptUnlock);
  promptUnlock();
}

/** Release the lock. */
function unlock() {
  locked = false;
  hideOverlay();
}

/**
 * Decide + engage the lock for the CURRENT moment (boot or resume): only when native + enabled +
 * usable. Re-checks usability each time because enrolment can change between sessions.
 *
 * To avoid a content flash (TM-292), we cover the screen EAGERLY — the moment we know native + enabled
 * — and only THEN await the usability check, tearing the cover back down if the device can't be locked.
 * The overlay is therefore up before any async work, never after it.
 */
async function maybeLock() {
  const native = isNativeShell();
  const enabled = isAppLockEnabled(safeStorage());
  if (!native || !enabled) return;
  // Cover first, ask questions later: mount the opaque overlay before the async usability check so
  // app content can't flash on cold-start/resume.
  coverEagerly();
  const usable = await isBiometricAvailable();
  if (shouldEngageLock({ isNative: native, lockEnabled: enabled, biometryUsable: usable })) {
    lock();
  } else if (!locked) {
    // Not lockable on this device (no biometry/credential): tear the eager cover back down — the
    // backend is the real boundary, so we never trap the user behind a lock that can't be opened.
    hideOverlay();
  }
}

/** Subscribe to foreground/background transitions via the Capacitor App plugin, if present. */
function listenForResume() {
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App && typeof App.addListener === "function") {
    App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) maybeLock();
    });
  }
  // Belt-and-braces for WebViews where the App plugin event is flaky: also use the DOM
  // visibilitychange, which fires when the WebView is re-shown.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeLock();
  });
}

/**
 * Initialise the app-lock. No-op outside the native shell (web unaffected). Safe to call once at boot.
 */
export function init() {
  if (initialised) return;
  initialised = true;
  if (!isNativeShell()) return;
  listenForResume();
  // Lock on cold start too (not just resume).
  maybeLock();
}

// Auto-init at module load — the router/index wires this in via a <script type="module"> import.
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.tmBiometricLock = { init };
}
