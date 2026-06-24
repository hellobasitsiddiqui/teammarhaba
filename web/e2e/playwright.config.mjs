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
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Desktop project runs every spec EXCEPT the mobile-only responsive one (which needs the phone
    // viewport from the mobile-chromium project below).
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /responsive-mobile\.spec\.mjs/,
    },
    // Mobile viewport project (TM-229) — a phone profile (Pixel 5 ≈ 393px wide) so the responsive
    // specs exercise the real narrow-screen layout: hamburger nav, no horizontal page scroll, the
    // scrollable admin table. Scoped to the responsive spec via its testMatch so the desktop specs
    // don't double-run under mobile.
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
      testMatch: /responsive-mobile\.spec\.mjs/,
    },
  ],
  // Serve the static web app (with e2e config injected). The backend + emulator are external.
  webServer: {
    command: "node serve.mjs",
    url: WEB_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
