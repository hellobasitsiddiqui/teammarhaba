// Swagger UI bootstrap for the public API reference (TM-520 / TM-526; self-hosted in TM-768).
//
// WHY EXTERNAL (not inline). The site-wide CSP (TM-722) sets `script-src 'self' …` with NO
// 'unsafe-inline', so an inline <script> is blocked and the page rendered blank in prod. This init
// therefore lives in its own file served from 'self', alongside the self-hosted swagger-ui-bundle.js /
// swagger-ui.css in this directory — no third-party CDN, so the whole page loads under the strict CSP
// with no exception (the industry-standard fix: self-host + externalize, never 'unsafe-inline' or a
// CDN allowlist). See web/tools/csp-static-pages.test.mjs, which guards this.
//
// READ-ONLY public page: "Try it out" is disabled (supportedSubmitMethods: []) — this static page has
// no backend to call, and the live prod API surface is deliberately private. It renders ./openapi.json,
// kept byte-identical to backend/openapi.json by web/tools/api-docs-spec-drift.test.mjs.
window.ui = SwaggerUIBundle({
  url: "./openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  // Read-only public page: hide "Try it out" (there's no backend to call from here).
  supportedSubmitMethods: [],
  presets: [SwaggerUIBundle.presets.apis],
  layout: "BaseLayout",
});
