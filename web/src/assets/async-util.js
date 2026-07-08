// Pure async helpers — framework-free, with zero DOM/fetch/browser deps, so they are unit-testable
// in isolation (see web/tools/async-util.test.mjs), the same way events-core.js is.
//
// `settleOrFallback` was extracted from router.js as part of the TM-307 regression-test backfill.
// The TM-307 login dead-end was an un-timed `await` on a promise that could hang forever inside the
// Android WebView (the first getIdToken()/GET /me after a custom-token sign-in), so navigation off
// #/login never fired. This helper bounds that wait; extracting it lets the exact behaviour be
// guarded by a test instead of only a manual on-device check.

/**
 * Resolve `promise`, or `fallback` if it neither resolves nor rejects within `ms`.
 *
 * Never rejects — callers get a uniform outcome object they can branch on:
 *   - resolved in time:  { timedOut: false, value }
 *   - rejected in time:  { timedOut: false, error, value: fallback }
 *   - timed out:         { timedOut: true, value: fallback }
 *
 * @template T
 * @param {Promise<T>} promise  the work to bound
 * @param {number} ms           timeout budget in milliseconds
 * @param {T} fallback          value to fall back to on timeout or rejection
 * @returns {Promise<{ timedOut: boolean, value: T, error?: unknown }>}
 */
export function settleOrFallback(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish({ timedOut: true, value: fallback }), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        finish({ timedOut: false, value });
      })
      .catch((err) => {
        clearTimeout(timer);
        finish({ timedOut: false, error: err, value: fallback });
      });
  });
}
