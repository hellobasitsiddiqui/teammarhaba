// Phone-auth e2e gate (TM-302 / TM-309 / TM-318) — decides whether the reCAPTCHA app-verification
// bypass (`auth.settings.appVerificationDisabledForTesting = true`) may be enabled for the current
// environment.
//
// Pulled out of auth.js into its own pure module (same rationale as auth-env.js):
//   1. The gate is the single piece of the SMS-e2e wiring that is unit-testable WITHOUT a browser or
//      the Firebase SDK — feed it a fake `window`/`localStorage`, assert the decision. The
//      framework-free repo runs `node --test web/tools/*.test.mjs` on the PR gate, so the
//      "never weaken reCAPTCHA on the public site" safety contract is guarded by a real test.
//   2. It keeps auth.js focused on the Firebase calls; this module has zero Firebase imports.
//
// THE CONTRACT (must hold for the bypass to be enabled): BOTH
//   • REQUESTED  — a harness explicitly asked for the bypass, via ANY of:
//       - `window.TEAMMARHABA_CONFIG.phoneTestMode === true`         (runtime config — never set in prod)
//       - `window.__TM_E2E_PHONE_TEST__ === true`                    (a window global a harness injects)
//       - `localStorage["tm_e2e_phone_test"] === "1"`                (PERSISTED flag — TM-318)
//   • CONTEXT-SAFE — the context cannot be the public site, via EITHER:
//       - an Auth emulator is wired in (`window.TEAMMARHABA_CONFIG.authEmulatorHost`), OR
//       - we're inside the native Capacitor shell (`window.Capacitor.isNativePlatform() === true`).
//
// TM-318 added the persisted localStorage path because the mobile-e2e Maestro harness relaunches the
// app between flows: a `window` global (or a `Page.addScriptToEvaluateOnNewDocument` hook) is lost on
// relaunch, but a localStorage value survives, so the flag is read fresh on every page load. It stays
// a no-op in production: nothing sets that key on https://teammarhaba.web.app, and even a stray value
// can't take effect there because the context-safe half of the gate still requires the emulator or
// the native shell.

const E2E_PHONE_LOCALSTORAGE_KEY = "tm_e2e_phone_test";

/**
 * Read the persisted phone-e2e flag from localStorage, defensively. localStorage can be absent
 * (Node/tests) or throw on access (a locked-down / partitioned WebView); a read failure must never
 * break auth boot, so it fails CLOSED (returns false → no bypass).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function persistedPhoneE2eFlag(win = globalThis) {
  try {
    const ls = win && win.localStorage;
    return Boolean(ls) && ls.getItem(E2E_PHONE_LOCALSTORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Is the phone-e2e bypass REQUESTED for this environment? True when any of the three request signals
 * is present (runtime config flag, window global, or the TM-318 persisted localStorage key).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function phoneE2eRequested(win = globalThis) {
  if (!win) return false;
  return (
    Boolean(win.TEAMMARHABA_CONFIG && win.TEAMMARHABA_CONFIG.phoneTestMode === true) ||
    win.__TM_E2E_PHONE_TEST__ === true ||
    persistedPhoneE2eFlag(win)
  );
}

/**
 * Is the context SAFE for the bypass — i.e. provably not the public web app? True when an Auth
 * emulator is configured, OR we're running inside the native Capacitor shell. The https public site
 * has neither, so this is false there (the bypass is unreachable in production regardless of the
 * requested signal).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function phoneE2eContextSafe(win = globalThis) {
  if (!win) return false;
  const emulatorWired = Boolean(win.TEAMMARHABA_CONFIG && win.TEAMMARHABA_CONFIG.authEmulatorHost);
  const nativeShell = Boolean(
    win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform(),
  );
  return emulatorWired || nativeShell;
}

/**
 * The single decision used by auth.js: may the reCAPTCHA app-verification bypass be enabled? Only
 * when the bypass is BOTH requested AND context-safe — the safety contract that keeps it a no-op on
 * the public site.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function shouldDisablePhoneAppVerification(win = globalThis) {
  return phoneE2eRequested(win) && phoneE2eContextSafe(win);
}

export { E2E_PHONE_LOCALSTORAGE_KEY };
