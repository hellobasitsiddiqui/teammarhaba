// TM-735 — regression tests for three CD-workflow defects (batched TM-655 MEDIUM findings).
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`. These parse the workflow YAML as text and assert the exact
// invariant each fix locks in, so a later edit can't silently reintroduce the defect.
//
//   1. deploy-reconcile.yml — the 30-min reconcile must NOT force-deploy every merged commit
//      (that defeats the deliberate deploy-label gate, TM-153/TM-156). It may only heal a real
//      strand: a Deploy that was initiated but whose latest run did not conclude `success`.
//   2. deploy.yml — the candidate revision to promote must be PINNED by --revision-suffix, not
//      read back from the SERVICE-GLOBAL latestCreatedRevisionName, so a concurrent preview deploy
//      (same Cloud Run service) can't get 100% prod traffic promoted onto it.
//   3. android-release.yml — the whole-site Hosting publish must also inject the backend URL into
//      the standalone /status page's status-config.js, exactly like deploy.yml, or every Android
//      release ships a /status page pinned to the 127.0.0.1 dev default.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const wf = (name) => readFileSync(join(HERE, "../../.github/workflows", name), "utf8");

const RECONCILE = wf("deploy-reconcile.yml");
const DEPLOY = wf("deploy.yml");
const ANDROID = wf("android-release.yml");

// ---- Finding 1: deploy-reconcile must not defeat the deliberate-deploy gate -------------------

test("reconcile gates re-dispatch on the latest Deploy run's conclusion (strand-only)", () => {
  // The fix keys the strand decision off the latest completed Deploy run's conclusion.
  assert.match(
    RECONCILE,
    /gh run list --workflow=deploy\.yml[^\n]*--status=completed/,
    "reconcile must inspect the latest COMPLETED Deploy run to decide whether a strand exists",
  );
  assert.match(
    RECONCILE,
    /--json conclusion/,
    "reconcile must read the Deploy run's `conclusion`",
  );
});

test("reconcile does NOTHING (exits) when the latest Deploy concluded success", () => {
  // A successful latest Deploy means its revision was promoted+verified; a HEAD mismatch is then an
  // intentionally-undeployed commit — the gate working as designed. Must short-circuit to exit 0.
  assert.match(
    RECONCILE,
    /LAST_CONCLUSION.*=.*"success"[\s\S]*?exit 0/,
    "on latest Deploy conclusion == success the reconcile must exit without re-dispatching",
  );
});

test("reconcile only re-dispatches Deploy AFTER the success short-circuit", () => {
  // There must be exactly one `gh workflow run deploy.yml` inside the strand path, and the
  // success-conclusion check must appear before it (so a successful deploy can never reach it).
  const successIdx = RECONCILE.indexOf('LAST_CONCLUSION}" = "success"');
  const lastDispatchIdx = RECONCILE.lastIndexOf("gh workflow run deploy.yml");
  assert.ok(successIdx !== -1, "the success-conclusion gate must exist");
  assert.ok(
    successIdx < lastDispatchIdx,
    "the strand re-dispatch must come AFTER the `conclusion == success` early-exit",
  );
});

test("reconcile no longer treats a plain serving!=main-HEAD mismatch as a strand", () => {
  // The old warning claimed a strand purely from `serving is not main HEAD`. That message form
  // (re-dispatch justified only by the HEAD mismatch, with no conclusion check) must be gone.
  assert.doesNotMatch(
    RECONCILE,
    /Stranded deploy — serving '\$\{SERVING_REV\}' is not main HEAD\. Re-dispatching/,
    "must not re-dispatch on a bare serving!=HEAD mismatch — that defeats the deploy-label gate",
  );
});

// ---- Finding 2: deploy.yml candidate revision must be pinned, not race-read -------------------

test("deploy pins the candidate revision name via --revision-suffix", () => {
  assert.match(
    DEPLOY,
    /--revision-suffix="\$\{REV_SUFFIX\}"/,
    "the candidate deploy must pin its revision name with --revision-suffix",
  );
  // The suffix must be unique per run (run id + attempt) so two runs can't collide.
  assert.match(DEPLOY, /GITHUB_RUN_ID/, "revision suffix must include the run id for uniqueness");
  assert.match(DEPLOY, /GITHUB_RUN_ATTEMPT/, "revision suffix must include the run attempt");
});

test("deploy does NOT derive NEW_REV from the service-global latestCreatedRevisionName", () => {
  // This is the race: a concurrent preview deploy to the same service moves
  // latestCreatedRevisionName. NEW_REV must be the pinned `${SERVICE}-${REV_SUFFIX}` instead.
  assert.doesNotMatch(
    DEPLOY,
    /NEW_REV=\$\(gcloud run services describe[\s\S]*?latestCreatedRevisionName/,
    "NEW_REV must not be read back from latestCreatedRevisionName (preview-deploy race)",
  );
  assert.match(
    DEPLOY,
    /NEW_REV="\$\{SERVICE\}-\$\{REV_SUFFIX\}"/,
    "NEW_REV must be the deterministically-pinned revision name",
  );
});

test("deploy still promotes BY NAME to the pinned revision (never --to-latest)", () => {
  // Guard against regressing the by-name promotion. The promote must route to the pinned NEW_REV,
  // and must not fall back to --to-latest (which would defeat the point of pinning the revision).
  assert.match(
    DEPLOY,
    /--to-revisions="\$\{NEW_REV\}=100"/,
    "promote must route 100% traffic to the pinned NEW_REV by name",
  );
  // `--to-latest` is mentioned in prose comments (explaining why it's NOT used); assert only that
  // no non-comment command line actually passes it.
  const commandUsesToLatest = DEPLOY.split("\n").some(
    (line) => !line.trimStart().startsWith("#") && line.includes("--to-latest"),
  );
  assert.ok(
    !commandUsesToLatest,
    "no command in the deploy workflow may pass --to-latest (promotion is always by pinned name)",
  );
});

// ---- Finding 3: android-release must inject status-config.js like deploy.yml ------------------

test("android-release injects the backend URL into the standalone /status config", () => {
  assert.match(
    ANDROID,
    /sed -i "s#http:\/\/127\.0\.0\.1:8080#\$\{URL\}#" web\/dist\/status\/status-config\.js/,
    "android-release must sed the live backend URL into web/dist/status/status-config.js",
  );
});

test("android-release status injection mirrors deploy.yml (both target status-config.js)", () => {
  // Both the Android whole-site publish and the web deploy republish Hosting, so both must inject
  // the /status config — otherwise a release ships a /status page pinned to the dev default.
  const target = "web/dist/status/status-config.js";
  assert.ok(DEPLOY.includes(target), "deploy.yml must inject status-config.js (baseline)");
  assert.ok(ANDROID.includes(target), "android-release.yml must inject status-config.js too");
});
