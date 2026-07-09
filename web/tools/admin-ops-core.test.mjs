// Unit tests for the admin Operations panel pure core (TM-183) — the App-endpoint / Diagnostics /
// Console URL builders behind the #/admin Operations panel.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/fetch, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PUBLIC_PERMIT_LIST,
  apiBase,
  appLinks,
  DIAGNOSTICS,
  diagnosticsUrl,
  consoleLinks,
} from "../src/assets/admin-ops-core.js";

const CFG = Object.freeze({
  apiBaseUrl: "https://api.example.test",
  opsProject: "acme-proj",
  opsRegion: "europe-west2",
  opsService: "acme-backend",
  opsRepo: "acme-org/acme-repo",
  opsJiraBoardUrl: "https://acme.atlassian.net/jira/software/projects/AC/boards/2",
});

// ---- apiBase ------------------------------------------------------------------------------

test("apiBase trims trailing slashes and is empty when unconfigured", () => {
  assert.equal(apiBase({ apiBaseUrl: "https://api.example.test/" }), "https://api.example.test");
  assert.equal(apiBase({ apiBaseUrl: "https://api.example.test///" }), "https://api.example.test");
  assert.equal(apiBase({ apiBaseUrl: "https://api.example.test" }), "https://api.example.test");
  assert.equal(apiBase({}), "");
  assert.equal(apiBase(), "");
});

// ---- Group 1: App endpoints (public anchors) ----------------------------------------------

test("appLinks resolves all endpoints against the injected API base (never hardcoded)", () => {
  const links = appLinks(CFG);
  const byLabel = Object.fromEntries(links.map((l) => [l.label, l.href]));
  assert.equal(byLabel["Health"], "https://api.example.test/health");
  assert.equal(byLabel["Actuator health"], "https://api.example.test/actuator/health");
  assert.equal(byLabel["Swagger UI"], "https://api.example.test/swagger-ui/index.html");
  assert.equal(byLabel["OpenAPI spec"], "https://api.example.test/v3/api-docs");
  assert.equal(byLabel["Build / version"], "https://api.example.test/version");
});

test("appLinks is empty when no API base is configured (nothing sensible to link)", () => {
  assert.deepEqual(appLinks({}), []);
  assert.deepEqual(appLinks({ apiBaseUrl: "" }), []);
});

test("every App-endpoint link stays inside the SecurityConfig permit-list (never anchors a protected path)", () => {
  for (const { href } of appLinks(CFG)) {
    const path = new URL(href).pathname;
    const permitted = PUBLIC_PERMIT_LIST.some((p) => path === p || path.startsWith(`${p}/`));
    assert.ok(permitted, `App-endpoint path "${path}" must be in the permit-list ${PUBLIC_PERMIT_LIST}`);
  }
});

test("the docs endpoints are flagged non-prod (TM-520 disables springdoc in prod)", () => {
  const byLabel = Object.fromEntries(appLinks(CFG).map((l) => [l.label, l.desc]));
  assert.match(byLabel["Swagger UI"], /non-prod/i);
  assert.match(byLabel["OpenAPI spec"], /non-prod/i);
});

// ---- Group 2: Diagnostics (authenticated fetch, not anchors) ------------------------------

test("DIAGNOSTICS names exactly the two protected actuator endpoints", () => {
  assert.deepEqual(DIAGNOSTICS.map((d) => d.path), ["/actuator/info", "/actuator/metrics"]);
});

test("diagnosticsUrl resolves against the API base, and is null when unconfigured", () => {
  assert.equal(diagnosticsUrl(CFG, "/actuator/info"), "https://api.example.test/actuator/info");
  assert.equal(diagnosticsUrl(CFG, "/actuator/metrics"), "https://api.example.test/actuator/metrics");
  assert.equal(diagnosticsUrl({}, "/actuator/info"), null);
});

test("the diagnostics paths are NOT in the public permit-list (that's why they need a token)", () => {
  for (const { path } of DIAGNOSTICS) {
    const permitted = PUBLIC_PERMIT_LIST.some((p) => path === p || path.startsWith(`${p}/`));
    assert.ok(!permitted, `diagnostics path "${path}" must NOT be public (it needs the bearer token)`);
  }
});

// ---- Group 3: Consoles (config-driven, replay-safe) ---------------------------------------

test("consoleLinks builds every console URL from injected config", () => {
  const byLabel = Object.fromEntries(consoleLinks(CFG).map((l) => [l.label, l.href]));
  assert.equal(
    byLabel["Cloud Run service"],
    "https://console.cloud.google.com/run/detail/europe-west2/acme-backend/metrics?project=acme-proj",
  );
  assert.equal(byLabel["Firebase Auth"], "https://console.firebase.google.com/project/acme-proj/authentication/users");
  assert.equal(
    byLabel["Artifact Registry"],
    "https://console.cloud.google.com/artifacts/docker/acme-proj/europe-west2/containers?project=acme-proj",
  );
  assert.equal(byLabel["GitHub repo"], "https://github.com/acme-org/acme-repo");
  assert.equal(byLabel["GitHub Actions"], "https://github.com/acme-org/acme-repo/actions");
  assert.equal(byLabel["Pull requests"], "https://github.com/acme-org/acme-repo/pulls");
  assert.equal(byLabel["Jira board"], CFG.opsJiraBoardUrl);
  assert.equal(byLabel["Live web app"], "https://acme-proj.web.app");
});

test("Logs Explorer is filtered to the service, with the filter query URL-encoded", () => {
  const logs = consoleLinks(CFG).find((l) => l.label === "Logs Explorer");
  // The service filter must be present (decoded), and the raw href must be percent-encoded (no raw quotes/newlines).
  assert.ok(decodeURIComponent(logs.href).includes('resource.labels.service_name="acme-backend"'));
  assert.ok(!logs.href.includes('"'), "the query must be URL-encoded in the href");
  assert.ok(!/\n/.test(logs.href), "the query newline must be URL-encoded in the href");
});

test("the GitHub repo slug's slash is NOT percent-encoded (it's a real path separator)", () => {
  const repo = consoleLinks(CFG).find((l) => l.label === "GitHub repo");
  assert.equal(repo.href, "https://github.com/acme-org/acme-repo");
  assert.ok(!repo.href.includes("%2F"), "owner/name slash must stay a literal '/'");
});

test("consoleLinks omits (never half-builds) a link whose required config is missing", () => {
  // Only a repo configured → exactly the three GitHub links, nothing GCP/Jira/site.
  const repoOnly = consoleLinks({ opsRepo: "o/r" }).map((l) => l.label);
  assert.deepEqual(repoOnly, ["GitHub repo", "GitHub Actions", "Pull requests"]);

  // Cloud Run needs project + region + service — drop the service and the Cloud Run link disappears,
  // while the project-only links (Firebase Auth, live site) remain.
  const noService = consoleLinks({ opsProject: "p", opsRegion: "r" }).map((l) => l.label);
  assert.ok(!noService.includes("Cloud Run service"));
  assert.ok(noService.includes("Firebase Auth"));
  assert.ok(noService.includes("Live web app"));

  // Nothing configured → no links at all (never a broken URL).
  assert.deepEqual(consoleLinks({}), []);
});
