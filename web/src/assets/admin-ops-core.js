// Pure, framework-free logic for the admin Operations panel (TM-183) — the URL/model builders behind
// the "Operations" links on the #/admin landing page. NO DOM, no fetch, no browser globals at module
// scope, so Node's test runner imports it directly (the same `*-core.js` split the web app already
// uses — see home-core.js / events-core.js, and AGENTIC-LESSONS "extract the pure logic to test it").
// The DOM half (rendering + the authenticated diagnostics fetch) lives in admin.js.
//
// The panel groups operational links into three kinds, distinguished by how the backend authorises them:
//
//   1. App endpoints  — publicly reachable (in the SecurityConfig permit-list), so they can be plain
//                        anchors that open in a new tab. Resolved against the INJECTED API base URL
//                        (the same `window.TEAMMARHABA_CONFIG.apiBaseUrl` seam api.js uses, TM-104) —
//                        never a hardcoded host, so dev / prod / a replay all point at the right backend.
//   2. Diagnostics    — require a Firebase bearer token (`/actuator/info`, `/actuator/metrics`). A plain
//                        <a href> navigation carries NO Authorization header and gets 401, so these are
//                        NOT anchors: admin.js fetches them with the admin's token and renders the JSON.
//                        This module only supplies the target URLs + descriptions.
//   3. Consoles       — external cloud/dev consoles (Cloud Run, Logs Explorer, Firebase Auth, Artifact
//                        Registry, GitHub, Jira, the live site). Built from BUILD/DEPLOY-INJECTED config
//                        (project / region / service / repo / Jira board) — never hardcoded, so a replay
//                        into a different GCP project or repo renders correct links. Any console whose
//                        required config is absent is simply omitted (never a broken/half-built URL).
//
// The permit-list here is kept in lock-step with backend SecurityConfig (TM-79): only `/health`,
// `/version`, `/actuator/health(/**)`, `/v3/api-docs/**`, `/swagger-ui/**` are public and may be anchors.
// Swagger UI + the OpenAPI spec are non-prod only (disabled in prod by TM-520) — flagged in their copy.

/** The exact set of backend paths that are public (SecurityConfig permit-list, TM-79). Only paths whose
 *  first segment matches one of these may ever be rendered as a plain anchor. Exported so the test can
 *  assert every App-endpoint link stays inside the permit-list (a guard against a future edit adding a
 *  protected path as an anchor — which would silently 401 for the admin). */
export const PUBLIC_PERMIT_LIST = Object.freeze([
  "/health",
  "/version",
  "/actuator/health",
  "/v3/api-docs",
  "/swagger-ui",
]);

/** Trim a possibly-null string to a non-empty trimmed value, else "". */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Encode a single URL path/query SEGMENT (a project id, region, service name — never a slash-bearing
 *  value). Belt-and-braces: these come from trusted deploy-injected config, but encoding keeps a stray
 *  character from ever breaking out of the intended URL position. */
function seg(value) {
  return encodeURIComponent(clean(value));
}

/**
 * The configured backend API base URL, trailing slashes trimmed — the SAME resolution api.js does, so
 * the App-endpoint anchors and the Diagnostics fetch hit exactly the backend the rest of the app calls.
 * @param {{apiBaseUrl?: string}} [cfg] usually `window.TEAMMARHABA_CONFIG`.
 * @returns {string} the base with no trailing slash, or "" when unconfigured.
 */
export function apiBase(cfg = {}) {
  return clean(cfg && cfg.apiBaseUrl).replace(/\/+$/, "");
}

/**
 * Group 1 — public App endpoints as absolute anchor URLs against the injected API base. ONLY
 * permit-listed (public) paths appear, so every href is safe to open as a plain new-tab anchor.
 * Returns [] when no API base is configured (nothing sensible to link to).
 * @param {{apiBaseUrl?: string}} [cfg]
 * @returns {{label: string, href: string, desc: string}[]}
 */
export function appLinks(cfg = {}) {
  const base = apiBase(cfg);
  if (!base) return [];
  return [
    { label: "Health", href: `${base}/health`, desc: "Cloud Run liveness probe — plain UP/DOWN." },
    { label: "Actuator health", href: `${base}/actuator/health`, desc: "Spring Boot health with component detail." },
    { label: "Swagger UI", href: `${base}/swagger-ui/index.html`, desc: "Interactive API explorer (non-prod only — disabled in prod, TM-520)." },
    { label: "OpenAPI spec", href: `${base}/v3/api-docs`, desc: "Raw OpenAPI JSON (non-prod only — disabled in prod, TM-520)." },
    { label: "Build / version", href: `${base}/version`, desc: "Backend build provenance — sha, build time, revision." },
  ];
}

/**
 * Group 2 — the authenticated diagnostics endpoints. NOT anchors: a plain navigation sends no bearer
 * token and gets 401, so admin.js fetches each of these WITH the admin's token and renders the JSON in a
 * collapsible block. This module only names the targets; {@link diagnosticsUrl} builds the absolute URL.
 */
export const DIAGNOSTICS = Object.freeze([
  { key: "info", label: "Actuator info", path: "/actuator/info", desc: "Build + git info (needs an admin token)." },
  { key: "metrics", label: "Actuator metrics", path: "/actuator/metrics", desc: "Available metric names (needs an admin token)." },
]);

/**
 * The absolute URL for a diagnostics endpoint, resolved against the injected API base (so the fetch
 * targets the same backend as everything else). `null` when no base is configured.
 * @param {{apiBaseUrl?: string}} cfg
 * @param {string} path a leading-slash diagnostics path (e.g. "/actuator/info").
 * @returns {?string}
 */
export function diagnosticsUrl(cfg, path) {
  const base = apiBase(cfg);
  return base ? `${base}${path}` : null;
}

/**
 * Group 3 — external console links, built entirely from build/deploy-injected config so a replay into a
 * different project/repo renders correct URLs (never hardcoded). Each link is emitted ONLY when the
 * config it needs is present, so a partially-configured environment shows the links it can and silently
 * omits the rest rather than rendering a broken URL.
 *
 * Config keys (all optional; see config.js — defaulted for the worked example, injected at deploy time):
 *   • opsProject      — GCP + Firebase project id (Cloud Run, Logs, Firebase Auth, Artifact Registry, live site)
 *   • opsRegion       — Cloud Run / Artifact Registry region
 *   • opsService      — Cloud Run service name
 *   • opsRepo         — GitHub "owner/name" (repo / Actions / PRs)
 *   • opsJiraBoardUrl — full Jira board URL (not derivable from the others, so passed whole)
 *
 * @param {{opsProject?: string, opsRegion?: string, opsService?: string, opsRepo?: string, opsJiraBoardUrl?: string}} [cfg]
 * @returns {{label: string, href: string, desc: string}[]}
 */
export function consoleLinks(cfg = {}) {
  const project = clean(cfg.opsProject);
  const region = clean(cfg.opsRegion);
  const service = clean(cfg.opsService);
  const repo = clean(cfg.opsRepo);
  const jiraBoardUrl = clean(cfg.opsJiraBoardUrl);
  const links = [];

  // Cloud Run service detail — revisions, traffic split, and logs for the backend.
  if (project && region && service) {
    links.push({
      label: "Cloud Run service",
      href: `https://console.cloud.google.com/run/detail/${seg(region)}/${seg(service)}/metrics?project=${seg(project)}`,
      desc: "Revisions, traffic split, and logs for the backend service.",
    });
  }
  // Logs Explorer pre-filtered to the backend service's Cloud Run revisions.
  if (project && service) {
    const query = `resource.type="cloud_run_revision"\nresource.labels.service_name="${service}"`;
    links.push({
      label: "Logs Explorer",
      href: `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(query)}?project=${seg(project)}`,
      desc: "GCP logs filtered to the backend service.",
    });
  }
  // Firebase console — Authentication users (the project is also the Firebase project, TM-140).
  if (project) {
    links.push({
      label: "Firebase Auth",
      href: `https://console.firebase.google.com/project/${seg(project)}/authentication/users`,
      desc: "Firebase console — Authentication users.",
    });
  }
  // Artifact Registry — the backend container images repo ("containers", per the deploy image path).
  if (project && region) {
    links.push({
      label: "Artifact Registry",
      href: `https://console.cloud.google.com/artifacts/docker/${seg(project)}/${seg(region)}/containers?project=${seg(project)}`,
      desc: "Backend container images.",
    });
  }
  // GitHub — repo, CI/deploy workflow runs, and open PRs. `opsRepo` is "owner/name": its slash is a
  // real path separator, so it is used as-is (never percent-encoded, which would break the path).
  if (repo) {
    links.push({ label: "GitHub repo", href: `https://github.com/${repo}`, desc: "Source repository." });
    links.push({ label: "GitHub Actions", href: `https://github.com/${repo}/actions`, desc: "CI / deploy workflow runs." });
    links.push({ label: "Pull requests", href: `https://github.com/${repo}/pulls`, desc: "Open pull requests." });
  }
  // Jira board — passed whole (site + project + board id aren't derivable from the GCP config).
  if (jiraBoardUrl) {
    links.push({ label: "Jira board", href: jiraBoardUrl, desc: "The project's sprint board." });
  }
  // The live web app — the Firebase Hosting default domain for the project.
  if (project) {
    links.push({ label: "Live web app", href: `https://${project}.web.app`, desc: "The deployed site (Firebase Hosting)." });
  }
  return links;
}
