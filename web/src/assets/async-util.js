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

/** Sentinel returned when a {@link singleFlight}-wrapped call is dropped because one is already running. */
export const DROPPED = Symbol("singleFlight.dropped");

/**
 * Wrap an async `fn` so that while one invocation is in flight, any further calls are DROPPED (they
 * return {@link DROPPED} immediately and never invoke `fn` a second time). The latch releases as soon as
 * the running promise settles — success OR failure — so a rejected run doesn't wedge the guard shut.
 *
 * This is the reusable core of TM-721's re-entrancy fixes: a double-tapped event action (events.js
 * runCommand) or a double-clicked admin Refresh (admin.js loadUsers) would otherwise fire the same
 * expensive/side-effecting command twice. Pure and DOM-free, so it's unit-testable (async-util.test.mjs).
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} fn the async function to guard.
 * @returns {(...args: Parameters<F>) => Promise<Awaited<ReturnType<F>> | typeof DROPPED>}
 */
export function singleFlight(fn) {
  let inFlight = false;
  return async function guarded(...args) {
    if (inFlight) return DROPPED;
    inFlight = true;
    try {
      return await fn.apply(this, args);
    } finally {
      inFlight = false;
    }
  };
}
