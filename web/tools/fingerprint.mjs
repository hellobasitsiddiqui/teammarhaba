// Content-hash (fingerprint) the built web assets so every deploy changes their URLs — an
// automatic, instant cache-bust (TM-144). Renames `<dist>/assets/*.{js,css}` to
// `<name>.<hash>.<ext>`, then rewrites the references in `index.html` AND the relative ES-module
// import specifiers between assets.
//
// Hashing is TRANSITIVE: a file's hash is computed AFTER its dependencies' import specifiers have
// been rewritten to their hashed names, so changing one module busts every module that imports it.
// Without this, a cached importer would keep pointing at a dependency URL that no longer exists.
//
// Framework-free — Node built-ins only. Run after the build copy + any config injection:
//   node web/build/fingerprint.mjs web/dist

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";

const HASH_LEN = 10;

/** Strip `//` line and block comments so dependency detection ignores doc examples like
 *  `import { x } from "./api.js"` that appear inside header comments. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The relative `.js` specifiers a module REALLY imports (from real import/export-from statements). */
function realDeps(src) {
  const code = stripComments(src);
  const deps = new Set();
  // `import ... from "./x.js"` / `export ... from "./x.js"` (the import body has no quotes, so it
  // spans newlines safely here), and side-effect `import "./x.js"`.
  for (const m of code.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"](\.\/[^'"]+\.js)['"]/g)) {
    deps.add(m[1].slice(2));
  }
  for (const m of code.matchAll(/\bimport\s*['"](\.\/[^'"]+\.js)['"]/g)) {
    deps.add(m[1].slice(2));
  }
  return [...deps];
}

/**
 * Fingerprint every hashable asset in `<distDir>/assets`, rewrite references, and write an
 * `asset-manifest.json` mapping original → hashed names. Returns that manifest.
 */
export function fingerprint(distDir) {
  const assetsDir = join(distDir, "assets");
  const files = readdirSync(assetsDir)
    .filter((f) => /\.(js|css)$/.test(f))
    .sort(); // sort for deterministic topo order / hashes

  const contents = new Map(files.map((f) => [f, readFileSync(join(assetsDir, f), "utf8")]));
  const deps = new Map(
    files.map((f) => [f, f.endsWith(".js") ? realDeps(contents.get(f)).filter((d) => contents.has(d)) : []]),
  );

  // Topological order: dependencies before the files that import them.
  const order = [];
  const done = new Set();
  const visit = (f, stack) => {
    if (done.has(f)) return;
    if (stack.has(f)) throw new Error(`import cycle involving ${f}`);
    stack.add(f);
    for (const d of deps.get(f)) visit(d, stack);
    stack.delete(f);
    done.add(f);
    order.push(f);
  };
  for (const f of files) visit(f, new Set());

  const hashedName = new Map();
  const manifest = {};
  for (const f of order) {
    let src = contents.get(f);
    // Rewrite this file's real dependency specifiers to their already-computed hashed names.
    for (const d of deps.get(f)) {
      const nn = hashedName.get(d);
      src = src.split(`"./${d}"`).join(`"./${nn}"`).split(`'./${d}'`).join(`'./${nn}'`);
    }
    const ext = extname(f);
    const hash = createHash("sha256").update(src).digest("hex").slice(0, HASH_LEN);
    const nn = `${basename(f, ext)}.${hash}${ext}`;
    hashedName.set(f, nn);
    manifest[f] = nn;
    writeFileSync(join(assetsDir, nn), src);
  }

  // Drop the originals — only the hashed (immutable-cacheable) files remain.
  for (const f of files) rmSync(join(assetsDir, f));

  // Rewrite the entry HTML's <link>/<script> references (index.html stays unhashed — it's the
  // always-revalidated entry point that points at the newest hashed assets).
  const indexPath = join(distDir, "index.html");
  let html = readFileSync(indexPath, "utf8");
  for (const [orig, nn] of hashedName) {
    html = html.split(`/assets/${orig}`).join(`/assets/${nn}`);
  }
  writeFileSync(indexPath, html);

  writeFileSync(join(distDir, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// CLI entry: `node web/build/fingerprint.mjs <distDir>`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dist = process.argv[2] || "web/dist";
  const manifest = fingerprint(dist);
  console.log(`Fingerprinted ${Object.keys(manifest).length} assets in ${dist}/assets`);
}
