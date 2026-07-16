// CSP-vs-pages guard (TM-768). The site-wide Content-Security-Policy lives in firebase.json (hosting
// config); the pages are static HTML. Nothing tested the INTERSECTION — so when TM-722 added a strict
// CSP, the /api-docs Swagger page (jsdelivr CDN + inline <script>) and the /download probe (inline
// <script>) silently went dark in prod while web-security-headers.test.mjs (which only checks the
// header STRING) stayed green.
//
// This test parses the CSP from firebase.json, walks every web/src/**/*.html, and fails if any page
// loads a <script src>/<stylesheet link> from a host the policy doesn't allow, or uses an inline
// <script> while script-src has no 'unsafe-inline'. It reds the build BEFORE deploy on the next CSP
// tighten or the next CDN/inline page.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // web/tools -> web -> repo root
const webSrc = join(repoRoot, "web", "src");

// ---- parse the CSP from firebase.json ----
function loadCsp() {
  const fb = JSON.parse(readFileSync(join(repoRoot, "firebase.json"), "utf8"));
  const headers = fb.hosting.headers.flatMap((h) => h.headers);
  const csp = headers.find((h) => h.key.toLowerCase() === "content-security-policy");
  assert.ok(csp, "no Content-Security-Policy header found in firebase.json");
  const directives = {};
  for (const part of csp.value.split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) directives[name.toLowerCase()] = vals;
  }
  return directives;
}

// A token like https://www.gstatic.com or a wildcard https://*.googleusercontent.com matches an origin.
function tokenMatches(token, origin) {
  if (token === origin) return true;
  if (token.startsWith("https://*.")) {
    const suffix = token.slice("https://*".length); // ".googleusercontent.com"
    return origin.startsWith("https://") && origin.endsWith(suffix);
  }
  return false;
}
function hostAllowed(directives, directive, url) {
  const origin = new URL(url).origin; // https://cdn.jsdelivr.net
  const tokens = directives[directive] || directives["default-src"] || [];
  return tokens.some((t) => tokenMatches(t, origin));
}

// ---- collect all html files under web/src ----
function htmlFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(full));
    else if (e.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const directives = loadCsp();
const scriptInline = (directives["script-src"] || []).includes("'unsafe-inline'");

test("every web/src page loads only CSP-permitted scripts/styles (no CDN, no inline script)", () => {
  const violations = [];
  for (const file of htmlFiles(webSrc)) {
    // Strip HTML comments first — CSP ignores commented-out markup, and a comment may legitimately
    // mention "<script>" in prose (as these very files do when documenting the CSP fix).
    const html = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const rel = file.slice(repoRoot.length + 1);

    // external <script src="https://…">
    for (const m of html.matchAll(/<script\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)) {
      if (!hostAllowed(directives, "script-src", m[1])) {
        violations.push(`${rel}: <script src> ${m[1]} not allowed by script-src`);
      }
    }
    // inline <script> (a <script> with no src attribute + a body)
    for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (m[1].trim() && !scriptInline) {
        violations.push(`${rel}: inline <script> blocked (script-src has no 'unsafe-inline')`);
      }
    }
    // external stylesheet <link rel="stylesheet" href="https://…"> (order-independent attrs)
    for (const m of html.matchAll(/<link\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
      const tag = m[0];
      if (!/rel=["']stylesheet["']/i.test(tag)) continue; // ignore preconnect / icon / etc.
      if (!hostAllowed(directives, "style-src", m[1])) {
        violations.push(`${rel}: <link stylesheet> ${m[1]} not allowed by style-src`);
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    "static pages violate the deployed CSP (firebase.json):\n  " + violations.join("\n  "),
  );
});
