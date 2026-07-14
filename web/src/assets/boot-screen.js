// Web boot screen — DOM + lifecycle driver (TM-381).
//
// A lightweight Paper-themed loading screen covers the beat between the native-splash handoff and the
// SPA's first paint, greeting the user with a random playful tagline (the pure pick logic + the copy
// list live in boot-core.js). The overlay markup itself is in index.html (`#boot-screen`) so it's
// painted teal from the very FIRST frame — no white/unstyled flash while these modules load. This
// module only (1) writes the chosen tagline into it and (2) dismisses it once the app has painted.
//
// NEVER DELAYS READINESS. The overlay is a `position: fixed` cosmetic layer painted ON TOP of the
// booting app — the app loads underneath regardless, so nothing here blocks it. We add NO artificial
// timer: the screen is lifted at first app paint (two animation frames after DOM ready, mirroring the
// native splash driver splash.js), so if the SPA is cached-instant it simply flashes briefly or is
// skipped. A short opacity fade-out reads as a smooth teal → paper handoff to the app beneath.
//
// CROSS-SURFACE. index.html is the single page served to the browser AND loaded inside the Capacitor
// Android / iOS WebView, so this one implementation covers web, mobile-web and both native shells.

import { TAGLINES, pickTagline } from "./boot-core.js";

// localStorage key holding the LAST-shown tagline, so the next launch can avoid repeating it. Namespaced
// under `tm.` like the app's other client keys (e.g. router's `tm.intendedRoute`).
const LAST_KEY = "tm.boot.lastTagline";

/**
 * Choose a tagline (avoiding last launch's) and write it into the `#boot-tagline` slot. Persists the
 * choice so the NEXT launch can skip it. Storage is best-effort — a blocked/absent `localStorage`
 * (private mode, a locked-down WebView) must never break boot, so both the read and the write are
 * guarded and simply fall back to "no previous / don't persist".
 *
 * @param {object} [win=globalThis] injectable window for tests.
 * @returns {string|null} the tagline shown, or null if there was no slot / nothing to show.
 */
export function showBootTagline(win = globalThis) {
  const doc = win.document;
  const slot = doc && doc.getElementById("boot-tagline");
  if (!slot) return null; // no boot screen on this page — nothing to do.

  let previous = null;
  try {
    previous = win.localStorage.getItem(LAST_KEY);
  } catch {
    // localStorage unavailable — treat as "no previous", still show a (possibly repeated) tagline.
  }

  const tagline = pickTagline(TAGLINES, previous, win.Math ? win.Math.random : Math.random);
  if (!tagline) return null;

  slot.textContent = tagline;
  // Mark the slot ready so CSS can fade the tagline in (its arrival is a beat after the wordmark, which
  // is in the static HTML — animating it in makes that intentional rather than a flash of empty copy).
  slot.dataset.ready = "true";

  try {
    win.localStorage.setItem(LAST_KEY, tagline);
  } catch {
    // Best-effort persistence; a write failure just means the next launch might repeat this one.
  }
  return tagline;
}

/**
 * Dismiss the boot screen: fade it out, then remove it from the DOM so it can't trap pointer events or
 * linger in the accessibility tree. Idempotent (guarded by a `data-dismissed` flag) so it's safe to
 * call from more than one ready signal. No-op if the overlay isn't present (e.g. already removed).
 *
 * @param {object} [win=globalThis] injectable window for tests.
 * @returns {boolean} true if this call issued the dismiss, false if it no-op'd.
 */
export function dismissBoot(win = globalThis) {
  const doc = win.document;
  const screen = doc && doc.getElementById("boot-screen");
  if (!screen || screen.dataset.dismissed) return false;
  screen.dataset.dismissed = "true";

  // Kick off the CSS fade-out (`.is-hiding` → opacity 0 + pointer-events: none).
  screen.classList.add("is-hiding");

  const remove = () => {
    if (screen.remove) screen.remove();
    else if (screen.parentNode) screen.parentNode.removeChild(screen);
  };
  // Remove after the fade completes for a clean handoff...
  if (typeof screen.addEventListener === "function") {
    screen.addEventListener("transitionend", remove, { once: true });
  }
  // ...but also on a hard safety cap, so a skipped/interrupted transition (reduced-motion, a WebView
  // that doesn't fire transitionend) can never leave the overlay stuck on screen.
  const setTimer = win.setTimeout || setTimeout;
  setTimer(remove, 600);
  return true;
}

// How long the boot screen stays up so the ring → smiley → two-line sequence (TM-705) can play. The
// animation is ~3.1s; we hold a touch past it, then lift. Single tunable knob — lower it to shorten the
// splash. Under prefers-reduced-motion there's no animation to see, so we skip the hold entirely.
export const MIN_SHOW_MS = 3200;

/**
 * Wire the boot screen: dismiss the overlay once BOTH the app has painted AND the minimum-show window has
 * elapsed, so the TM-705 launch animation is actually seen. "First paint" = two animation frames after the
 * DOM is ready (the same signal splash.js uses). Gating on first-paint too means we still never uncover a
 * still-blank page. Under prefers-reduced-motion the min-show is 0, restoring the original
 * dismiss-at-first-paint behaviour (no artificial wait). No tagline write anymore — the two brand lines are
 * static markup animated by CSS (showBootTagline/boot-core are retained but no longer wired here).
 *
 * @param {object} [win=globalThis] injectable window for tests.
 */
export function initBootScreen(win = globalThis) {
  const doc = win.document;
  if (!doc) return;

  let reduce = false;
  try {
    reduce = Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    // matchMedia unavailable — treat as "motion allowed" and hold for the animation.
  }
  const minShow = reduce ? 0 : MIN_SHOW_MS;

  let painted = false;
  let minElapsed = minShow === 0;
  const tryDismiss = () => {
    if (painted && minElapsed) dismissBoot(win);
  };

  const onPainted = () => {
    const raf = win.requestAnimationFrame || ((cb) => (win.setTimeout || setTimeout)(cb, 16));
    raf(() => raf(() => {
      painted = true;
      tryDismiss();
    }));
  };

  if (doc.readyState === "complete" || doc.readyState === "interactive") {
    onPainted();
  } else {
    doc.addEventListener("DOMContentLoaded", onPainted, { once: true });
  }

  if (minShow > 0) {
    const setTimer = win.setTimeout || setTimeout;
    setTimer(() => {
      minElapsed = true;
      tryDismiss();
    }, minShow);
  }
}

// Auto-init when loaded as a module in the app. Guarded so importing the pure helpers in a test (where
// there's no `#boot-screen` element) is a complete no-op — showBootTagline/dismissBoot both bail
// without a slot/overlay, and the DOMContentLoaded wiring is harmless in that headless case.
initBootScreen();
