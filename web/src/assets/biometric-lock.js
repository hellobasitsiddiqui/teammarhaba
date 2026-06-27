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
// TM-334 — THE INFINITE RE-PROMPT LOOP (the bug this file's state machine now defends against):
// Presenting the Android system BiometricPrompt BACKGROUNDS then FOREGROUNDS the Activity. On
// dismissal (success OR cancel), Capacitor's @capacitor/app plugin emits
// `appStateChange { isActive: true }` — indistinguishable, at the event level, from the user
// genuinely leaving the app and coming back. The old resume handler treated that synthetic resume as
// a FRESH lock trigger, so a *successful unlock* immediately re-armed the lock and re-showed the
// prompt → an endless loop that trapped the user (confirmed via emulator CDP: `internalAuthenticate`
// resolves fine, then the prompt's own foreground re-locks). The native plugin is healthy; the bug is
// purely app-side resume bookkeeping.
//
// The fix: a `promptInFlight` flag is raised the instant BEFORE we call authenticate() and only
// cleared once the prompt-induced resume has been CONSUMED. While it's up, an `appStateChange`
// (or visibilitychange) resume must NOT engage the lock. The prompt emits the pair
// `isActive:false` → `isActive:true`; we keep the flag up across both so we don't clear it too early
// and let the real *next* resume slip through. We also ignore resumes for a brief SETTLE window after
// a successful unlock, so the trailing foreground that arrives just after unlock() can't re-lock. A
// genuine background→foreground with no prompt in flight (and outside the settle window) still locks.
//
// Fail-safe: this is a CONVENIENCE layer, not the security boundary — the backend (default-deny,
// TM-79) is. So if biometry becomes unavailable (sensor lockout, un-enrolled mid-session) we fail
// OPEN and unlock, rather than trapping the user in an app they can never get back into. A genuine
// non-match or a user-cancel keeps the overlay up with a retry button.
//
// Browser builds: `isNativeShell()` is false, so `init()` returns immediately and NOTHING is mounted
// or listened for — the web surface is completely unaffected (an AC).
//
// TESTABILITY: the resume/lock STATE MACHINE lives in `createLockController(deps)`, a pure-ish
// factory with every side-effecting dependency injected (authenticate, usability check, lock-enabled
// read, an overlay adapter, and a clock). Tests drive it with mocks (mock @capacitor/app emitting
// appStateChange + a mock authenticate) and assert the no-relock behaviour — exactly the path the web
// e2e can't reach because `isNativeShell()` is false there. The live `init()` below wires the real
// browser/Capacitor dependencies into the same factory.

import { isNativeShell, isBiometricAvailable, authenticate } from "./biometric.js";
import { isAppLockEnabled, shouldEngageLock } from "./biometric-policy.js";

/**
 * How long (ms) after a successful unlock we keep ignoring resume events. Covers the trailing
 * `isActive:true` the dismissed prompt emits just AFTER we've already unlocked, so it can't re-lock.
 * Short enough that a genuinely separate background→foreground a moment later still locks.
 */
export const UNLOCK_SETTLE_MS = 750;

/**
 * Build the app-lock state machine. All side effects are injected so the resume/lock logic can be
 * unit-tested with mocks (no DOM, no Capacitor, no real clock) — see web/tools/biometric-lock.test.mjs.
 *
 * @param {{
 *   authenticate: (opts: object) => Promise<{ok: boolean, reason?: string, code?: string}>,
 *   isBiometricAvailable: () => Promise<boolean>,
 *   isAppLockEnabled: () => boolean,
 *   isNative: () => boolean,
 *   overlay: { show: (onUnlockClick: () => void) => void, hide: () => void },
 *   now?: () => number,
 * }} deps
 */
export function createLockController(deps) {
  const now = deps.now ?? (() => Date.now());

  let locked = false;
  // Debounce concurrent prompt attempts (a fast resume can fire twice).
  let prompting = false;
  // TM-334: raised BEFORE authenticate() and held until the prompt-induced resume has been consumed.
  // While set, resume events must NOT engage the lock (they're the prompt's own foreground, not the
  // user leaving and coming back).
  let promptInFlight = false;
  // TM-334: after the prompt backgrounds the activity (`isActive:false`) we EXPECT exactly one
  // matching foreground (`isActive:true`). We arm this on the prompt's background so we only clear
  // promptInFlight on the *paired* resume, never on a stray/early event.
  let awaitingPromptResume = false;
  // Timestamp of the last successful unlock — resumes within UNLOCK_SETTLE_MS of it are ignored, so
  // the prompt's trailing foreground that arrives just after unlock() can't re-lock.
  let unlockedAt = -Infinity;

  /** Run the biometric prompt; on success unlock, otherwise keep the overlay up (unless fail-open). */
  async function promptUnlock() {
    if (prompting) return;
    prompting = true;
    // TM-334: arm the suppression BEFORE the prompt is presented. Showing the system prompt
    // backgrounds (isActive:false) then foregrounds (isActive:true) the activity; both must be
    // ignored by the resume handler so the prompt doesn't re-trigger itself.
    promptInFlight = true;
    awaitingPromptResume = false;
    try {
      const res = await deps.authenticate({
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
      // "dismissed" or "failed": stay locked; the overlay's Unlock button lets them retry. We do NOT
      // auto-re-prompt here — the trailing resume is suppressed (promptInFlight), so the prompt can't
      // busy-loop; the user retries via the Unlock button.
    } finally {
      prompting = false;
      // If we never observed the prompt's background event by the time it settled, the suppression
      // would otherwise be cleared by the resume handler. As a safety net, if no background was seen
      // at all (e.g. a synchronous mock or a prompt that didn't background the activity), drop the
      // flag here so a later genuine resume isn't permanently suppressed.
      if (!awaitingPromptResume) promptInFlight = false;
    }
  }

  /** Mount the opaque overlay NOW, synchronously, without prompting (TM-292 eager cover). */
  function coverEagerly() {
    if (locked) return;
    deps.overlay.show(promptUnlock);
  }

  /** Engage the lock: show the overlay (if not already up) + immediately prompt. */
  function lock() {
    if (locked) return;
    locked = true;
    deps.overlay.show(promptUnlock);
    promptUnlock();
  }

  /** Release the lock. */
  function unlock() {
    locked = false;
    unlockedAt = now();
    deps.overlay.hide();
  }

  /**
   * Decide + engage the lock for the CURRENT moment (boot or resume): only when native + enabled +
   * usable. Re-checks usability each time because enrolment can change between sessions.
   *
   * To avoid a content flash (TM-292), we cover the screen EAGERLY — the moment we know native +
   * enabled — and only THEN await the usability check, tearing the cover back down if the device
   * can't be locked. The overlay is therefore up before any async work, never after it.
   */
  async function maybeLock() {
    const native = deps.isNative();
    const enabled = deps.isAppLockEnabled();
    if (!native || !enabled) return;
    // Cover first, ask questions later: mount the opaque overlay before the async usability check so
    // app content can't flash on cold-start/resume.
    coverEagerly();
    const usable = await deps.isBiometricAvailable();
    if (shouldEngageLock({ isNative: native, lockEnabled: enabled, biometryUsable: usable })) {
      lock();
    } else if (!locked) {
      // Not lockable on this device (no biometry/credential): tear the eager cover back down — the
      // backend is the real boundary, so we never trap the user behind a lock that can't be opened.
      deps.overlay.hide();
    }
  }

  /**
   * Handle an `appStateChange`/`visibilitychange` transition. The single chokepoint for the TM-334
   * fix: decides whether a foreground event is a REAL background→foreground (→ engage the lock) or
   * the SYNTHETIC one caused by our own biometric prompt (→ ignore).
   *
   * @param {boolean} isActive true = app foregrounded, false = app backgrounded.
   * @returns {Promise<void>|void}
   */
  function onAppStateChange(isActive) {
    if (!isActive) {
      // Backgrounded. If a prompt is in flight, THIS is the prompt backgrounding the activity — note
      // it so we clear the suppression only on the paired foreground that follows.
      if (promptInFlight) awaitingPromptResume = true;
      return;
    }
    // Foregrounded.
    if (promptInFlight) {
      // This is the prompt's own resume (success or cancel just dismissed it). Do NOT re-lock. If
      // this is the resume paired with the prompt's background, consume the suppression now so the
      // NEXT genuine resume is handled normally.
      if (awaitingPromptResume) {
        promptInFlight = false;
        awaitingPromptResume = false;
      }
      return;
    }
    // TM-334: a successful unlock can be immediately followed by a trailing foreground (the prompt
    // dismissal) that arrives a beat after we've already cleared promptInFlight. Ignore resumes for a
    // brief settle window after unlock so that trailing event can't re-lock.
    if (now() - unlockedAt < UNLOCK_SETTLE_MS) return;
    // A genuine background→foreground with no prompt in flight: engage the lock.
    return maybeLock();
  }

  return {
    onAppStateChange,
    maybeLock,
    coverEagerly,
    // Exposed for tests/inspection.
    isLocked: () => locked,
    promptUnlock,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live wiring: build a single controller backed by the real browser + Capacitor.
// ─────────────────────────────────────────────────────────────────────────────

let initialised = false;
let overlayEl = null;
let controller = null;

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
  if (overlayEl) {
    overlayEl.hidden = false;
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

  overlayEl = document.createElement("div");
  overlayEl.id = "tm-biometric-lock";
  overlayEl.className = "tm-lock-overlay";
  overlayEl.setAttribute("role", "dialog");
  overlayEl.setAttribute("aria-modal", "true");
  overlayEl.setAttribute("aria-label", "App locked");
  overlayEl.append(card);
  document.body.append(overlayEl);
}

function hideOverlay() {
  if (overlayEl) overlayEl.hidden = true;
}

/** The live overlay adapter handed to the controller. */
const liveOverlay = { show: showOverlay, hide: hideOverlay };

/** Subscribe to foreground/background transitions via the Capacitor App plugin, if present. */
function listenForResume() {
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App && typeof App.addListener === "function") {
    App.addListener("appStateChange", ({ isActive }) => {
      controller.onAppStateChange(isActive);
    });
  }
  // Belt-and-braces for WebViews where the App plugin event is flaky: also use the DOM
  // visibilitychange, which fires when the WebView is re-shown. We route it through the SAME
  // onAppStateChange chokepoint (mapping visible→true / hidden→false) so the TM-334 prompt-resume
  // suppression covers this path too.
  document.addEventListener("visibilitychange", () => {
    controller.onAppStateChange(document.visibilityState === "visible");
  });
}

/**
 * Initialise the app-lock. No-op outside the native shell (web unaffected). Safe to call once at boot.
 */
export function init() {
  if (initialised) return;
  initialised = true;
  if (!isNativeShell()) return;
  controller = createLockController({
    authenticate,
    isBiometricAvailable,
    isAppLockEnabled: () => isAppLockEnabled(safeStorage()),
    isNative: () => isNativeShell(),
    overlay: liveOverlay,
  });
  listenForResume();
  // Lock on cold start too (not just resume).
  controller.maybeLock();
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
