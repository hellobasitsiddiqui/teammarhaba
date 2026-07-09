// Backend API base URL for the public /status page (TM-182).
//
// WHY A SEPARATE, TINY CONFIG. The status page is a STANDALONE static page (web/src/status/index.html,
// served at /status before the SPA rewrite) — it deliberately does NOT import the SPA's /assets/config.js,
// because that file is content-hashed (fingerprinted) at deploy and this page lives outside /assets, so
// a reference to it would break. Instead this page carries its own one-line config, injected at deploy
// the SAME proven way as the SPA's config.js: the deploy step seds the 127.0.0.1 dev default to the live
// Cloud Run URL resolved from `gcloud run services describe` (never hard-coded — a rename just works).
// See .github/workflows/deploy.yml → "Inject backend API base URL into the status page".
//
// Local dev (docker-compose) talks to the backend on :8080, so that stays the committed default. The
// banner only calls the PUBLIC `/health` endpoint (permitAll in SecurityConfig; CORS already allows
// the teammarhaba.web.app origin), so nothing secret is exposed by knowing this URL — it's the same
// public API base the web app already calls.
window.TM_STATUS_CONFIG = Object.freeze({
  apiBaseUrl: "http://127.0.0.1:8080",
});
