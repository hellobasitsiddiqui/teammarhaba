// Build/version stamp (TM-142). Shows which web bundle is live, plus the backend's build,
// so a stale surface is obvious at a glance (the two deploy independently). The web SHA is
// injected into config.js at deploy time; the backend SHA/revision comes from its public
// /version endpoint. Unobtrusive and best-effort — if the backend is unreachable, the web
// stamp still shows. XSS-safe: only textContent is written, never innerHTML.
(function stampBuildInfo() {
  const el = document.getElementById("build-info");
  if (!el) return;

  const cfg = window.TEAMMARHABA_CONFIG || {};
  const webSha = cfg.buildSha || "dev";
  el.textContent = `web ${webSha}`;

  const base = cfg.apiBaseUrl;
  if (!base) return;

  fetch(`${base}/version`, { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((v) => {
      if (!v || !v.sha) return;
      const rev = v.revision && v.revision !== "local" ? ` (${v.revision})` : "";
      el.textContent = `web ${webSha} · api ${v.sha}${rev}`;
      if (v.buildTime && v.buildTime !== "unknown") {
        el.title = `backend built ${v.buildTime}`;
      }
    })
    .catch(() => {
      /* backend unreachable — keep the web-only stamp */
    });
})();
