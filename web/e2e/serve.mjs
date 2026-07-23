// Minimal static server for the browser-e2e harness (TM-134).
//
// Serves the framework-free web app from ../src exactly as nginx does in prod (the app is just
// static files), with ONE difference: it synthesises /assets/config.js at request time so the
// committed config.js stays prod-clean (authEmulatorHost: null) while e2e points the app at the
// local backend + Firebase Auth emulator. Hash routing means every route is `/#/...`, so no SPA
// rewrite is needed — the server only ever serves `/` (index.html) and `/assets/*`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const PORT = Number(process.env.PORT || 8081);
const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://127.0.0.1:8080";
const AUTH_EMULATOR_HOST = process.env.E2E_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const STORAGE_EMULATOR_HOST = process.env.E2E_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// The injected runtime config — same shape as web/src/assets/config.js, but with the e2e backend URL
// and the Auth + Storage emulator hosts set so the Firebase client SDK uses the emulators (TM-166
// adds the Storage emulator for the avatar-upload walkthrough).
const E2E_CONFIG = `window.TEAMMARHABA_CONFIG = Object.freeze({
    apiBaseUrl: ${JSON.stringify(API_BASE_URL)},
    authEmulatorHost: ${JSON.stringify(AUTH_EMULATOR_HOST)},
    storageEmulatorHost: ${JSON.stringify(STORAGE_EMULATOR_HOST)},
    // Suppress the first-run product tour (TM-135) in the harness. Seeded accounts start each run with
    // empty localStorage, so they look "first-run" every time; since TM-307 lands a signed-in user on
    // #/home first, the site tour now auto-starts and its full-screen .tm-tour-blocker overlay
    // intercepts clicks (e.g. the admin disable-confirm dialog). Off in prod (flag absent) — tours.js
    // honours this; replaying a tour from the Help menu is unaffected.
    suppressAutoTours: true,
    // TM-759: the WEB membership flag stays OFF here (matching prod / the committed config.js), so the
    // served app behaves EXACTLY as before membership for every spec — a browser RSVP on a priced event
    // free-joins rather than routing through routePaidCheckout, and the profile hub renders no membership
    // card. Turning it on GLOBALLY (an earlier revision did) regressed the whole non-payment suite: it
    // detoured the events-spec RSVP into checkout and broke the onboarding→profile render.
    //
    // The two payment specs (paid-rsvp / subscribe, TM-738) that DO need the flag turn it on FOR
    // THEMSELVES, before any app script runs, via page.addInitScript (they also inject the payments/Revolut
    // widget block there) — so membership is scoped to exactly those two specs, not the served app at large.
    // See the beforeEach in paid-rsvp.spec.mjs / subscribe.spec.mjs.
    //
    // TM-1009: the verified-phone requirement flag is pinned ON here (the committed config.js ships it
    // OFF). The whole existing suite — completeOnboarding's Send-code/OTP walk (helpers/onboarding.mjs),
    // the TM-930/932 gate-verify specs, the TM-982 phone-edit specs, the TM-992 reverify-nudge specs —
    // was written against, and still regression-covers, the flag-ON (go-live) behaviour; running the
    // harness flag-OFF would leave the Send button unbuilt and strand every one of those walks. The
    // flag-OFF (collect-only) behaviour is unit-covered in web/tools/verified-phone-flag.test.mjs; a
    // spec that wants to exercise it can override via page.addInitScript, like the payment specs do.
    flags: Object.freeze({ requireVerifiedPhone: true }),
});
`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/assets/config.js") {
      res.writeHead(200, { "content-type": CONTENT_TYPES[".js"], "cache-control": "no-store" });
      res.end(E2E_CONFIG);
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    // Resolve safely under ROOT (no path traversal).
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(500).end("Server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[e2e] web server on http://127.0.0.1:${PORT} (api=${API_BASE_URL}, ` +
      `authEmulator=${AUTH_EMULATOR_HOST}, storageEmulator=${STORAGE_EMULATOR_HOST})`,
  );
});
