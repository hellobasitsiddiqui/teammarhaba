// Shared constants for the browser-e2e harness (TM-134). Imported by global-setup (which seeds
// these accounts into the Firebase Auth emulator) and by the specs (which sign in as them).
//
// These are DISPOSABLE emulator accounts — never real users, never prod data. The emulator is
// wiped each run, so fixed credentials are fine and keep tests readable.

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "teammarhaba";

/** Where the Firebase Auth emulator listens (browser + backend both reach it on the host). */
export const AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.E2E_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

/** Backend + web base URLs (host-published ports; overridable for local runs). */
export const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://127.0.0.1:8080";
export const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL || "http://127.0.0.1:8081";

/** Seeded accounts. `admin` gets the role=ADMIN custom claim; `target` is the one we disable. */
export const ADMIN = { email: "e2e-admin@teammarhaba.test", password: "e2e-admin-pw-123456" };
export const TARGET = { email: "e2e-target@teammarhaba.test", password: "e2e-target-pw-123456" };

/** Connection for the persisted-state assertion (same Postgres the stack uses). */
export const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "teammarhaba",
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "devpassword",
};
