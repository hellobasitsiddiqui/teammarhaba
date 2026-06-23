// Tests for the asset fingerprinter (TM-144). Framework-free — Node's built-in test runner:
//   node --test web/build/

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fingerprint } from "./fingerprint.mjs";

/** Lay out a throwaway dist dir from a {path: content} map; returns its path. */
function makeDist(files) {
  const dist = mkdtempSync(join(tmpdir(), "fp-"));
  mkdirSync(join(dist, "assets"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const FIXTURE = {
  "index.html":
    '<link rel="stylesheet" href="/assets/style.css" />\n<script type="module" src="/assets/a.js"></script>',
  "assets/a.js": '// usage: import { b } from "./a.js";\nimport { b } from "./b.js";\nexport const a = b + 1;\n',
  "assets/b.js": "export const b = 1;\n",
  "assets/style.css": "body { color: red; }\n",
};

test("renames every asset with a content hash and drops the originals", () => {
  const dist = makeDist(FIXTURE);
  try {
    const manifest = fingerprint(dist);
    const left = readdirSync(join(dist, "assets")).sort();

    // Originals gone; each replaced by <name>.<10-hex>.<ext>.
    assert.deepEqual(left.filter((f) => ["a.js", "b.js", "style.css"].includes(f)), []);
    assert.match(manifest["a.js"], /^a\.[0-9a-f]{10}\.js$/);
    assert.match(manifest["b.js"], /^b\.[0-9a-f]{10}\.js$/);
    assert.match(manifest["style.css"], /^style\.[0-9a-f]{10}\.css$/);
    for (const orig of ["a.js", "b.js", "style.css"]) {
      assert.ok(left.includes(manifest[orig]), `${manifest[orig]} should exist`);
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("rewrites index.html references and transitive import specifiers", () => {
  const dist = makeDist(FIXTURE);
  try {
    const manifest = fingerprint(dist);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    assert.ok(html.includes(`/assets/${manifest["style.css"]}`));
    assert.ok(html.includes(`/assets/${manifest["a.js"]}`));
    assert.ok(!html.includes("/assets/style.css\""), "old css ref should be gone");

    // a.js now imports b by its HASHED name (transitive rewrite); the comment example stays as-is.
    const a = readFileSync(join(dist, "assets", manifest["a.js"]), "utf8");
    assert.ok(a.includes(`from "./${manifest["b.js"]}"`), "a.js should import hashed b.js");
    assert.ok(a.includes('import { b } from "./a.js";'), "comment example untouched");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("is deterministic — identical input yields identical hashes", () => {
  const a = makeDist(FIXTURE);
  const b = makeDist(FIXTURE);
  try {
    assert.deepEqual(fingerprint(a), fingerprint(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("changing a dependency busts the dependent's hash too (transitive)", () => {
  const base = fingerprint(makeDist(FIXTURE));
  const changed = makeDist({ ...FIXTURE, "assets/b.js": "export const b = 2;\n" });
  try {
    const after = fingerprint(changed);
    assert.notEqual(after["b.js"], base["b.js"], "b.js hash should change");
    assert.notEqual(after["a.js"], base["a.js"], "a.js hash should change because b changed");
    assert.equal(after["style.css"], base["style.css"], "unrelated style.css hash should be stable");
  } finally {
    rmSync(changed, { recursive: true, force: true });
  }
});
