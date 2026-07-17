// Pure build/version-stamp helpers (TM-610, TM-666, TM-847). Framework-free — no DOM, no fetch, no
// browser globals — so Node's test runner imports it directly (the same `*-core.js` split the rest of
// the web app uses; see AGENTIC-LESSONS "extract the pure logic to test it"). Guarded by
// build-info-core.test.mjs.
//
// These were previously nested inside build-info.js's IIFE with ZERO test coverage (flagged by the
// TM Easy Wins 1 closure review, TM-847). Extracting them verbatim — no behaviour change — makes the
// SHA-shortening and Cloud-Run-revision-trimming rules a real fail-before/pass-after regression guard.
// build-info.js now imports these; the labelled collapse/split formatting still lives in footer-core.js
// (formatBuildStamp), which build-info.js also imports and which its own test already covers.

/**
 * Reduce a build id to a short 7-char SHA. A full 40-char git SHA is truncated to its first 7 chars;
 * anything already short (a short SHA, "dev", or a legacy `git describe` string from an old backend,
 * e.g. "v1.2-3-gabc") is left untouched. An empty/absent id yields "".
 *
 * @param {string} [id] a build id — a full or short SHA, "dev", or a describe string.
 * @returns {string} the first 7 chars of a 40-char hex SHA, else `id` unchanged, else "".
 */
export function shortSha(id) {
  if (!id) return "";
  return /^[0-9a-f]{40}$/i.test(id) ? id.slice(0, 7) : id;
}

/**
 * Trim a Cloud Run revision to a compact `r<number>` (TM-610). Cloud Run names revisions
 * `<service>-<NNNNN>-<suffix>` (e.g. `teammarhaba-backend-00184-rik`); we keep just the revision
 * number, dropping the service-name prefix and the random suffix. "local" (off Cloud Run) and anything
 * that doesn't match are hidden (yield "") rather than shown raw.
 *
 * @param {string} [rev] the raw Cloud Run revision name, or "local", or absent.
 * @returns {string} `r<number>` for a matching revision, else "".
 */
export function trimRevision(rev) {
  if (!rev || rev === "local") return "";
  const m = rev.match(/-(\d+)(?:-\w+)?$/);
  return m ? `r${m[1]}` : "";
}
