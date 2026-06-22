// Web runtime config (TM-104). Single source of the backend API base URL so nothing is
// hard-coded against a host. Local dev (docker-compose) talks to the backend on :8080; the
// deployed build overrides `apiBaseUrl` (e.g. the Cloud Run URL) at deploy time. Consumers
// read `window.TEAMMARHABA_CONFIG.apiBaseUrl` (the API client lands in TM-108).
//
// `authEmulatorHost` is null in every real environment — Firebase Auth runs for real. It is
// set ONLY by the browser-e2e harness (TM-134), which serves a generated config pointing the
// Firebase client SDK at a local Auth emulator (see web/e2e/). Prod/dev never set it, so
// production auth behaviour is unchanged.
window.TEAMMARHABA_CONFIG = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8080",
    authEmulatorHost: null,
});
