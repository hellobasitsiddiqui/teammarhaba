// Web runtime config (TM-104). Single source of the backend API base URL so nothing is
// hard-coded against a host. Local dev (docker-compose) talks to the backend on :8080; the
// deployed build overrides `apiBaseUrl` (e.g. the Cloud Run URL) at deploy time. Consumers
// read `window.TEAMMARHABA_CONFIG.apiBaseUrl` (the API client lands in TM-108).
window.TEAMMARHABA_CONFIG = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8080",
});
