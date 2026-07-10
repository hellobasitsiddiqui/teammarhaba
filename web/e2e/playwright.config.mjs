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
  projects: [
    // Desktop project runs every spec EXCEPT the mobile-only ones (which need the phone viewport from
    // the mobile-chromium project below): the responsive layout spec and the chat-foundation evidence
    // spec (TM-587, captured at the Pixel 5 surface TM-564 uses).
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /(responsive-mobile|chat-foundation)\.spec\.mjs/,
    },
    // Mobile viewport project (TM-229) — a phone profile (Pixel 5 ≈ 393px wide) so the responsive
    // specs exercise the real narrow-screen layout: hamburger nav, no horizontal page scroll, the
    // scrollable admin table. Scoped by testMatch so the desktop specs don't double-run under mobile.
    // The golden-path journey (TM-341), the admin broadcast compose→send e2e (TM-366) and the events
    // journey (TM-400) are deliberately project-agnostic — they opt INTO this project too (handling the
    // hamburger nav at a phone width) so those flows are proven on mobile web as well as desktop.
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
      testMatch: /(responsive-mobile|golden-path|broadcast-admin|events|chat-foundation)\.spec\.mjs/,
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
