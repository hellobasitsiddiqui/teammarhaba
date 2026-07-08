// Drift guard (TM-520): the public static API-docs page (web/src/api-docs/) renders a COPY of the
// backend's committed OpenAPI spec. backend/openapi.json is the source of truth — itself guarded
// against the live API by OpenApiDriftTest. This test keeps the web copy byte-identical to it, so
// the public docs can never silently drift from the real contract.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const backendSpec = join(here, "..", "..", "backend", "openapi.json"); // web/tools -> repo root -> backend
const webCopy = join(here, "..", "src", "api-docs", "openapi.json"); // web/tools -> web/src/api-docs

test("public api-docs openapi.json is byte-identical to backend/openapi.json", () => {
  const backend = readFileSync(backendSpec, "utf8");
  const web = readFileSync(webCopy, "utf8");
  assert.equal(
    web,
    backend,
    "web/src/api-docs/openapi.json drifted from backend/openapi.json. Re-copy it:\n" +
      "  cp backend/openapi.json web/src/api-docs/openapi.json",
  );
});
