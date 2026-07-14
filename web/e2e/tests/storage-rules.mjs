// Storage rules verification (TM-704) — the guard the outage needed.
//
// The prod incident: admin event-image (TM-392) and venue-photo (TM-519) uploads were denied because
// the *released* ruleset was stale and lacked those match blocks. The Playwright suite could not catch
// it — events.spec.mjs sets `imagePath` as a string via the API (TM-392 is API-only), so no bytes ever
// hit Storage and the rules are never exercised for those paths. This test uploads real bytes to the
// Storage emulator (loaded with the repo-root storage.rules) and asserts the rule outcomes directly:
//
//   admin (role=ADMIN claim)  -> event-images/{id}, venue-images/{id}  = ALLOWED
//   signed-in non-admin       -> event-images/{id}, venue-images/{id}  = DENIED
//   anonymous                 -> event-images/{id}                     = DENIED
//   admin, non-image content  -> event-images/{id}                     = DENIED
//
// Run: `npm run test:storage-rules` (self-contained — starts the Storage emulator via emulators:exec),
// or reuse an already-running emulator by setting E2E_STORAGE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST.
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { ref, uploadBytes } from "firebase/storage";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "storage.rules");
const [host, port] = (process.env.E2E_STORAGE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").split(":");

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic — image/*
const img = { contentType: "image/png" };
const notImg = { contentType: "application/pdf" };

const env = await initializeTestEnvironment({
  projectId: "teammarhaba",
  storage: { rules: readFileSync(RULES, "utf8"), host, port: Number(port) },
});

const admin = env.authenticatedContext("admin-uid", { role: "ADMIN" }).storage();
const user = env.authenticatedContext("user-uid", {}).storage(); // signed in, no admin claim
const anon = env.unauthenticatedContext().storage();

let pass = 0;
const check = async (label, p) => { await p; console.log(`  ✔ ${label}`); pass++; };

try {
  console.log("ADMIN can upload event/venue images (the prod bug: this was denied):");
  await check("admin → event-images/evt-1 (image)", assertSucceeds(uploadBytes(ref(admin, "event-images/evt-1"), png, img)));
  await check("admin → venue-images/ven-1 (image)", assertSucceeds(uploadBytes(ref(admin, "venue-images/ven-1"), png, img)));

  console.log("Non-admin and anonymous are denied:");
  await check("signed-in non-admin → event-images/evt-2 DENIED", assertFails(uploadBytes(ref(user, "event-images/evt-2"), png, img)));
  await check("signed-in non-admin → venue-images/ven-2 DENIED", assertFails(uploadBytes(ref(user, "venue-images/ven-2"), png, img)));
  await check("anonymous → event-images/evt-3 DENIED", assertFails(uploadBytes(ref(anon, "event-images/evt-3"), png, img)));

  console.log("Admin still gated on content-type (non-image denied):");
  await check("admin → event-images/evt-4 (application/pdf) DENIED", assertFails(uploadBytes(ref(admin, "event-images/evt-4"), png, notImg)));

  console.log(`\nALL ${pass} STORAGE-RULE CHECKS PASSED`);
} finally {
  await env.cleanup();
}
