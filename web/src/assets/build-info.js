// Build/version stamp (TM-142, TM-155). Shows which web bundle is live, plus the backend's build,
// so a stale surface is obvious at a glance (the two deploy independently). Both surfaces report a
// `git describe --tags` build name (e.g. v1.4.0-12-ged338a9, or the bare short SHA until tagged):
// the web one is injected into config.js at deploy time; the backend one comes from its public
// /version endpoint. Unobtrusive and best-effort — if the backend is unreachable, the web stamp
// still shows. XSS-safe: only textContent is written, never innerHTML.
(function stampBuildInfo() {
  const el = document.getElementById("build-info");
  if (!el) return;

  const cfg = window.TEAMMARHABA_CONFIG || {};
  const webVersion = cfg.buildVersion || "dev";
  el.textContent = `web ${webVersion}`;

  const base = cfg.apiBaseUrl;
  if (!base) return;

  fetch(`${base}/version`, { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((v) => {
      // Prefer the describe `version` (TM-155); fall back to the bare `sha` for older backends.
      const apiVersion = v && (v.version || v.sha);
      if (!apiVersion) return;
      const rev = v.revision && v.revision !== "local" ? ` (${v.revision})` : "";
      el.textContent = `web ${webVersion} · api ${apiVersion}${rev}`;
      if (v.buildTime && v.buildTime !== "unknown") {
        el.title = `backend built ${v.buildTime}`;
      }
    })
    .catch(() => {
      /* backend unreachable — keep the web-only stamp */
    });
})();
