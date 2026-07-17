// Pure build-stamp helpers (TM-610, tests backfilled in TM-847). The build/version stamp shown in the
// footer (build-info.js) reduces raw deploy identifiers to compact, human-readable pieces:
//   • shortSha()      — a full 40-char git SHA → its 7-char short form; anything already short is untouched;
//   • trimRevision()  — a Cloud Run revision name → a compact `r<number>`; off-Cloud-Run / non-matching → "";
//   • buildStampParts() — the pure "collapse vs split" decision: when the web and backend SHAs match the
//     stamp is ONE value; when they've drifted it splits so the stale surface is obvious.
//
// These were previously private closures inside the build-info.js IIFE, so they shipped untested (the
// TM-824 closure review of "TM Easy Wins 1" flagged exactly this). Extracting them into this DOM-free,
// import-safe module — the SAME split the rest of the web app already uses (footer-core.js ↔ footer.js,
// membership-checkout-core.js ↔ membership-checkout.js) — lets Node's test runner cover them directly
// (web/tools/build-info.test.mjs) while build-info.js stays a thin DOM shell that imports them. The
// runtime behaviour is byte-for-byte unchanged: build-info.js calls these exact functions.
//
// NOTE: the LABELLING of the split stamp ("web <sha> · backend <sha>") lives in footer-core.js's
// formatBuildStamp() (added in TM-666) and is already unit-tested there. buildStampParts() here owns only
// the upstream collapse-vs-split DECISION (are the two SHAs the same commit or not, and what revision
// suffix applies); the two compose in build-info.js.

/**
 * Reduce a build id to a short 7-char SHA. A full 40-char hex git SHA is truncated to its first 7 chars;
 * anything already short — a short SHA, "dev" (the local fallback), or a legacy `git describe` string from
 * an older backend — is returned unchanged. A missing/empty id yields "".
 *
 * @param {unknown} id a build identifier (config.js `buildVersion`, or the backend `sha`/`version`).
 * @returns {string} the 7-char short SHA, or the input untouched when it isn't a full SHA, or "".
 */
export function shortSha(id) {
  if (!id) return "";
  return /^[0-9a-f]{40}$/i.test(id) ? id.slice(0, 7) : id;
}

/**
 * Trim a Cloud Run revision name to a compact `r<number>` (TM-610). Cloud Run names revisions
 * `<service>-<NNNNN>-<suffix>` (e.g. `teammarhaba-backend-00184-rik`); we keep just the revision number
 * — dropping the service-name prefix and the random suffix — so it renders as `r00184`. "local" (running
 * off Cloud Run) and anything that doesn't match the pattern are hidden (return "") rather than shown raw.
 *
 * @param {unknown} rev the backend's `/version` `revision` field.
 * @returns {string} `r<number>`, or "" when it's "local" / missing / non-matching.
 */
export function trimRevision(rev) {
  if (!rev || rev === "local") return "";
  const m = rev.match(/-(\d+)(?:-\w+)?$/);
  return m ? `r${m[1]}` : "";
}

/**
 * The pure "collapse vs split" decision for the build stamp (TM-610). Given the raw web build id, the
 * backend's `/version` sha/version, and its Cloud Run revision, it returns the short SHAs + revision
 * suffix AND a `collapsed` flag: TRUE when web and backend were deployed from the SAME commit (the normal
 * case — the stamp shows ONE value), FALSE when they've DRIFTED apart (the stamp splits to label each
 * surface). This is the branch build-info.js used to make inline; formatBuildStamp() (footer-core.js) then
 * turns these parts into the displayed text.
 *
 * @param {{webVersion?: unknown, apiSha?: unknown, revision?: unknown}} parts the raw deploy identifiers:
 *   `webVersion` (config.js buildVersion), `apiSha` (the backend `sha` or, for older backends, `version`),
 *   and `revision` (the backend Cloud Run revision).
 * @returns {{web: string, api: string, revSuffix: string, collapsed: boolean}} the short web/api SHAs, the
 *   ` · r<rev>` suffix (or ""), and whether the two surfaces collapse to one value.
 */
export function buildStampParts({ webVersion, apiSha, revision } = {}) {
  const web = shortSha(webVersion);
  const api = shortSha(apiSha);
  const rev = trimRevision(revision);
  const revSuffix = rev ? ` · ${rev}` : "";
  // Collapse only when the backend actually answered (api non-empty) AND both surfaces agree — the same
  // commit deployed to both. An absent/unmatched api SHA is NOT a collapse (there's nothing to compare).
  const collapsed = Boolean(api) && web === api;
  return { web, api, revSuffix, collapsed };
}
