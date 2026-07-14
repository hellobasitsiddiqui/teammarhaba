// CLI wrapper around missingStoragePathCoverage (TM-704) for the deploy workflow.
//
//   node web/tools/check-storage-rules-file.mjs <path> [label]
//
// Reads a Storage rules document (the committed storage.rules for the pre-deploy gate, or the source
// of the live released ruleset for the post-deploy verification) and exits non-zero, printing a
// GitHub `::error::` annotation, if any required path lacks a match block. Exit 0 = fully covered.
import { readFileSync } from "node:fs";
import { missingStoragePathCoverage } from "./storage-rules-cover.mjs";

const [path, label = path] = process.argv.slice(2);
if (!path) {
  console.error("usage: check-storage-rules-file.mjs <path> [label]");
  process.exit(2);
}

const missing = missingStoragePathCoverage(readFileSync(path, "utf8"));
if (missing.length > 0) {
  console.error(
    `::error::${label} is missing Storage rule block(s) for: ${missing.join(", ")}. ` +
      "Admin uploads to those paths will be default-denied (TM-704). " +
      "For a released-ruleset failure the live rules are stale vs storage.rules — redeploy them.",
  );
  process.exit(1);
}
console.log(`${label}: all required Storage paths covered (${["avatars", "event-images", "venue-images"].join(", ")}).`);
