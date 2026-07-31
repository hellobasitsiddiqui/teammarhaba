// TM-1180 — regression coverage for the surface-scoped e2e resolver (scope-e2e.mjs). Pure logic, no
// browser: run with `node --test scope-e2e.test.mjs` (wired as `npm run test:scope`, and executed in the
// e2e job before the browser suite). Every assertion here defends the SAFETY invariant — an under-scoped
// grep would silently skip a spec a PR breaks, so these lock down the "degrade to FULL when unsure" rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope } from "./scope-e2e.mjs";

test("a shared-core (forceFull) change forces the FULL suite", () => {
  for (const f of [
    "web/src/index.html",
    "web/src/assets/styles.css",
    "web/src/assets/router.js",
    "web/src/assets/api.js",
    "web/src/assets/ui.js",
    "web/src/assets/app.js",
    "web/src/assets/auth.js",
    "web/src/assets/avatar-events.js",
    "web/src/assets/config.js",
  ]) {
    assert.equal(resolveScope([f]).full, true, `${f} must force FULL`);
  }
});

test("an unmapped web/src path degrades to FULL (unknown → assume it could break anything)", () => {
  assert.equal(resolveScope(["web/src/status/status.js"]).full, true);
  assert.equal(resolveScope(["web/src/assets/geolocation.js"]).full, true);
  assert.equal(resolveScope(["web/src/assets/doodles.js"]).full, true);
});

test("a web-but-not-src change (harness/e2e/public) forces FULL", () => {
  assert.equal(resolveScope(["web/e2e/fixtures.mjs"]).full, true);
  assert.equal(resolveScope(["web/e2e/tests/anything.spec.mjs"]).full, true);
  assert.equal(resolveScope(["web/e2e/surface-to-specs.json"]).full, true);
});

test("a single mapped surface scopes to that tag + the always-on smoke set", () => {
  const r = resolveScope(["web/src/assets/admin-events.js"]);
  assert.equal(r.full, false);
  const tags = r.grep.split("|");
  assert.ok(tags.includes("@admin-events"), "maps admin-events → @admin-events");
  assert.ok(tags.includes("@app-shell"), "always-on smoke @app-shell");
  assert.ok(tags.includes("@auth"), "always-on smoke @auth");
});

test("multiple changed surfaces union their tags", () => {
  const r = resolveScope(["web/src/assets/profile.js", "web/src/assets/chat-core.js"]);
  assert.equal(r.full, false);
  const tags = r.grep.split("|");
  for (const t of ["@profile", "@chat", "@app-shell", "@auth"]) {
    assert.ok(tags.includes(t), `union must include ${t}`);
  }
});

test("a non-web change riding alongside a scoped web change does NOT force FULL", () => {
  const r = resolveScope(["backend/src/main/java/Foo.java", "web/src/assets/admin-events.js", "README.md"]);
  assert.equal(r.full, false);
  assert.ok(r.grep.includes("@admin-events"));
});

test("most-specific prefix wins: admin-events is not swallowed by generic admin", () => {
  assert.ok(resolveScope(["web/src/assets/admin-events.js"]).grep.split("|").includes("@admin-events"));
  const generic = resolveScope(["web/src/assets/admin-ops-core.js"]);
  const gtags = generic.grep.split("|");
  assert.ok(gtags.includes("@admin"), "admin-ops → generic @admin");
  assert.ok(!gtags.includes("@admin-events"), "generic admin must not claim @admin-events");
});

test("the always-on smoke tags are real (no scoped grep can select zero tests)", () => {
  // @app-shell + @auth are always in the grep and both match real specs, so Playwright never errors
  // 'no tests found'. This encodes the invariant; the map JSON is the source of truth.
  const r = resolveScope(["web/src/assets/terms.js"]);
  assert.equal(r.full, false);
  assert.ok(r.grep.includes("@app-shell") && r.grep.includes("@auth"));
});

test("a changeset with only non-web files degrades gracefully to a smoke-only scope (defensive)", () => {
  // resolveScope is only invoked when the changes guard already found a web file, but if handed only
  // non-web paths it must not throw or return an empty grep — it yields the smoke-only set.
  const r = resolveScope(["backend/src/Foo.java", "docs/x.md"]);
  assert.equal(r.full, false);
  assert.equal(r.grep, "@app-shell|@auth");
});
