import { defineConfig, devices } from "@playwright/test";
import { WEB_BASE_URL } from "./fixtures.mjs";

// Playwright config for the browser-e2e harness (TM-134). The harness runs on `main` + manual
// dispatch only (see ../../.github/workflows/e2e.yml) — never on the PR gate. Playwright owns the
// static web server (serve.mjs, which injects the e2e runtime config); the Auth emulator, backend,
// and Postgres are started beforehand by the workflow (or locally — see README.md).
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.mjs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: WEB_BASE_URL,
    trace: "retain-on-failure",
    // Capture a screenshot at the end of EVERY test (not just failures) so each run yields
    // evidence to attach to the sprint test ticket (TM-195). Trace/video stay failure-only (size).
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serve the static web app (with e2e config injected). The backend + emulator are external.
  webServer: {
    command: "node serve.mjs",
    url: WEB_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
