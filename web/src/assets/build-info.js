// Build/version stamp (TM-142, TM-155, TM-610). Shows which web bundle is live, plus the backend's
// build, so a stale surface is obvious at a glance (the two deploy independently). Both surfaces are
// now identified by their short commit SHA (TM-610: `git rev-parse --short HEAD` for web, the backend's
// baked-in `sha` for api) rather than a compounding `git describe` string. In the normal case the two
// SHAs match, so the stamp collapses to a single `<sha> · r<rev>`; it only splits to `web … · api …`
// when the surfaces drift out of sync. The web SHA is injected into config.js at deploy time; the
// backend's comes from its public /version endpoint. Unobtrusive and best-effort — if the backend is
// unreachable, the web-only SHA still shows. XSS-safe: only textContent is written, never innerHTML.
(function stampBuildInfo() {
  const el = document.getElementById("build-info");
  if (!el) return;

  const cfg = window.TEAMMARHABA_CONFIG || {};
  // Web build id: already a short SHA from deploy (TM-610), or "dev" locally.
  const webVersion = cfg.buildVersion || "dev";
  // Show the bare web SHA until (and unless) the backend answers with its own.
  el.textContent = shortSha(webVersion);

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

      // Collapse to one SHA when web and api match (the normal case — both deployed from the
      // same commit); only split to labelled `web … · api …` when they've drifted apart.
      el.textContent = web === apiVersion
        ? `${web}${revSuffix}`
        : `web ${web} · api ${apiVersion}${revSuffix}`;

      if (v.buildTime && v.buildTime !== "unknown") {
        el.title = `backend built ${v.buildTime}`;
      }
    })
    .catch(() => {
      /* backend unreachable — keep the web-only stamp */
    });

  // Reduce a build id to a short 7-char SHA. A full 40-char git SHA is truncated; anything already
  // short (a short SHA, "dev", or a legacy describe string from an old backend) is left untouched.
  function shortSha(id) {
    if (!id) return "";
    return /^[0-9a-f]{40}$/i.test(id) ? id.slice(0, 7) : id;
  }

  // Trim a Cloud Run revision to a compact `r<number>` (TM-610). Cloud Run names revisions
  // `<service>-<NNNNN>-<suffix>` (e.g. teammarhaba-backend-00184-rik); we keep just the revision
  // number, dropping the service-name prefix and the random suffix. "local" (off Cloud Run) and
  // anything that doesn't match are hidden rather than shown raw.
  function trimRevision(rev) {
    if (!rev || rev === "local") return "";
    const m = rev.match(/-(\d+)(?:-\w+)?$/);
    return m ? `r${m[1]}` : "";
  }
})();
