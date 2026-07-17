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
import { formatBuildStamp } from "./footer-core.js";
// TM-847: the pure SHA-shortening + Cloud-Run-revision-trimming helpers were previously nested in the
// IIFE below with no test coverage. They now live in build-info-core.js (unit-tested) and are imported
// here — no behaviour change, just a testable seam (the same `*-core.js` split the rest of the app uses).
import { shortSha, trimRevision } from "./build-info-core.js";

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
      // Prefer the precise `sha` anchor (TM-610); fall back to `version` for older backends
      // that predate the sha field. Either way we render it as a short SHA.
      const apiVersion = shortSha(v.sha || v.version);
      if (!apiVersion) return;

      const web = shortSha(webVersion);
      const rev = trimRevision(v.revision);
      const revSuffix = rev ? ` · ${rev}` : "";

      // Collapse to one SHA when web and api match (the normal case — both deployed from the same
      // commit); only split to a LABELLED `web … · backend …` when they've drifted apart, so it's
      // clear which SHA is which surface (TM-666). formatBuildStamp owns that pure formatting.
      el.textContent = formatBuildStamp({ webSha: web, apiSha: apiVersion, revSuffix });

      if (v.buildTime && v.buildTime !== "unknown") {
        el.title = `backend built ${v.buildTime}`;
      }
    })
    .catch(() => {
      /* backend unreachable — keep the web-only stamp */
    });

  // shortSha() and trimRevision() moved to build-info-core.js (TM-847) and imported above, so they're
  // unit-testable. No behaviour change — the IIFE still calls them exactly as before.
})();
