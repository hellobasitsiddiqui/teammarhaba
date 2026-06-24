// Web runtime config (TM-104). Single source of the backend API base URL so nothing is
// hard-coded against a host. Local dev (docker-compose) talks to the backend on :8080; the
// deployed build overrides `apiBaseUrl` (e.g. the Cloud Run URL) at deploy time. Consumers
// read `window.TEAMMARHABA_CONFIG.apiBaseUrl` (the API client lands in TM-108).
//
// `authEmulatorHost` is null in every real environment — Firebase Auth runs for real. It is
// set ONLY by the browser-e2e harness (TM-134), which serves a generated config pointing the
// Firebase client SDK at a local Auth emulator (see web/e2e/). Prod/dev never set it, so
// production auth behaviour is unchanged. `storageEmulatorHost` is the exact same idea for the
// Firebase Storage emulator (TM-166 avatar uploads): null everywhere except e2e.
//
// `buildVersion` is `git describe --tags` output for the web bundle (TM-155) — a readable build
// name from the nearest release tag (e.g. v1.4.0-12-ged338a9), or the bare short SHA until
// anything is tagged. It stays "dev" locally; the deploy injects the real value into this file
// the same way it injects `apiBaseUrl` (TM-142), so the live first page can show which build it
// is — and reveal a stale surface at a glance.
//
// `theme` selects the app-wide visual family (TM-210). It's the `data-theme` axis that scopes the
// CSS token contract in styles.css; theme.js reads it here at boot and sets it on <html>. This is
// the placeholder default — "clean" is the only theme that exists today and equals the current
// look (no visual change). The deploy injects the real per-environment value over it (TM-212), the
// same seam as `apiBaseUrl`/`buildVersion` above; any unknown value falls back to "clean" in
// theme.js, so a bad config never breaks the page.
window.TEAMMARHABA_CONFIG = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8080",
    authEmulatorHost: null,
    storageEmulatorHost: null,
    buildVersion: "dev",
    theme: "clean",
});
