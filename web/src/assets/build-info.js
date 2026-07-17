// Build/version stamp (TM-142, TM-155, TM-610). Shows which web bundle is live, plus the backend's
// build, so a stale surface is obvious at a glance (the two deploy independently). Both surfaces are
// now identified by their short commit SHA (TM-610: `git rev-parse --short HEAD` for web, the backend's
// baked-in `sha` for api) rather than a compounding `git describe` string. In the normal case the two
// SHAs match, so the stamp collapses to a single `<sha> · r<rev>`; it only splits to `web … · api …`
// when the surfaces drift out of sync. The web SHA is injected into config.js at deploy time; the
// backend's comes from its public /version endpoint. Unobtrusive and best-effort — if the backend is
// unreachable, the web-only SHA still shows. XSS-safe: only textContent is written, never innerHTML.
//
// TM-666: the stamp now LABELS which value is the web build vs the backend build. The pure formatting
// lives in footer-core.js (formatBuildStamp, unit-tested); to import it this file is an ES module now
// (loaded via <script type="module"> in index.html) rather than a classic IIFE script. Module scripts
// defer, but #build-info is already in the DOM before this runs, so the timing is unchanged in effect.
//
// TM-847: the pure identifier logic (shortSha, trimRevision, and the collapse-vs-split decision) now
// lives in build-info-core.js so it can be unit-tested (web/tools/build-info.test.mjs) — it used to be
// private closures in this IIFE and shipped untested (flagged by the TM-824 "Easy Wins 1" closure
// review). This file stays a thin DOM shell: it reads config + the backend /version, calls those pure
// helpers, and writes the result to textContent. The behaviour is unchanged — the same functions, only
// now importable rather than inlined.
import { formatBuildStamp } from "./footer-core.js";
import { shortSha, buildStampParts } from "./build-info-core.js";

(function stampBuildInfo() {
  const el = document.getElementById("build-info");
  if (!el) return;

  const cfg = window.TEAMMARHABA_CONFIG || {};
  // Web build id: already a short SHA from deploy (TM-610), or "dev" locally.
  const webVersion = cfg.buildVersion || "dev";
  // Show the web SHA — LABELLED "web <sha>" (TM-666) — until (and unless) the backend answers with
  // its own. Before the backend responds there's only one value, so labelling it makes clear it's the
  // WEB build (not the backend).
  el.textContent = formatBuildStamp({ webSha: shortSha(webVersion) });

  const base = cfg.apiBaseUrl;
  if (!base) return;

  fetch(`${base}/version`, { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((v) => {
      if (!v) return;
      // Prefer the precise `sha` anchor (TM-610); fall back to `version` for older backends that predate
      // the sha field. buildStampParts (TM-847, build-info-core.js) reduces both surfaces to short SHAs,
      // trims the revision to `r<number>`, and decides whether they collapse to one value or have drifted.
      const { web, api, revSuffix } = buildStampParts({
        webVersion,
        apiSha: v.sha || v.version,
        revision: v.revision,
      });
      if (!api) return; // backend answered but carried no usable SHA — keep the web-only stamp.

      // Collapse to one SHA when web and api match (the normal case — both deployed from the same
      // commit); only split to a LABELLED `web … · backend …` when they've drifted apart, so it's
      // clear which SHA is which surface (TM-666). formatBuildStamp owns that pure formatting.
      el.textContent = formatBuildStamp({ webSha: web, apiSha: api, revSuffix });

      if (v.buildTime && v.buildTime !== "unknown") {
        el.title = `backend built ${v.buildTime}`;
      }
    })
    .catch(() => {
      /* backend unreachable — keep the web-only stamp */
    });
})();
