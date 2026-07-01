// TeamMarhaba — k6 load / concurrency harness (TM-343).
//
// Simulates N concurrent virtual users against the backend API and reports latency
// percentiles / error rate / throughput, WHILE also asserting concurrency-correctness:
// each VU authenticates as a DISTINCT seeded user and asserts GET /me returns ONLY its
// own identity — catching data-isolation / cross-user-bleed races, not just perf.
//
// ─────────────────────────────────────────────────────────────────────────────────────
//  NON-PROD BY DEFAULT.  BASE_URL defaults to the local e2e stack (Firebase Auth emulator
//  + backend). This harness MINTS test tokens via the Firebase Auth *emulator* sign-in
//  endpoint — that path only exists on an emulator, so pointing it at a real Firebase
//  project simply won't yield tokens. NEVER run this against production. A prod-directed
//  run is refused unless you pass ALLOW_PROD=true *and* a non-emulator TOKEN_MODE (see the
//  prod guard below). Do not remove the guard.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// Scenario (per VU iteration):
//   1. (once, in setup) mint an emulator ID token for each of N distinct seeded users.
//   2. GET  /api/v1/me            → read my profile; assert uid/email are MINE (isolation).
//   3. PATCH /api/v1/me           → update a profile field with a value unique to this VU.
//   4. GET  /api/v1/me            → re-read; assert the field I just wrote is what I read
//                                    back (no cross-VU write bleed) AND identity is still mine.
//
// Run (local e2e stack up — see README.md in this dir):
//   k6 run test/load/api-load.js                       # defaults: 5 VUs, ramped, ~1m
//   k6 run -e VUS=50 -e DURATION=2m test/load/api-load.js
//   k6 run -e VUS=20 -e BASE_URL=https://<aat-host> -e TOKEN_MODE=static \
//          -e TOKENS_FILE=/path/tokens.json test/load/api-load.js   # AAT / staging
//
// Env / CLI knobs (all optional; sensible non-prod defaults):
//   VUS            virtual users            (default 5)
//   DURATION       steady-state duration    (default 1m)   — used when STAGES is unset
//   STAGES         explicit ramp, e.g. "10s:0-10,50s:10,10s:0"  (overrides VUS/DURATION shape)
//   BASE_URL       backend base URL         (default http://127.0.0.1:8080  — the e2e backend)
//   AUTH_EMULATOR_HOST  Firebase Auth emulator host  (default 127.0.0.1:9099)
//   FIREBASE_API_KEY    emulator API key (any string works on the emulator; default "fake-api-key")
//   USER_PREFIX / USER_DOMAIN / USER_PASSWORD  seeded-account shape (see setup())
//   TOKEN_MODE     "emulator" (default, mint via emulator) | "static" (read TOKENS_FILE)
//   TOKENS_FILE    JSON array of {uid,email,idToken} for TOKEN_MODE=static (e.g. AAT)
//   P95_MS         p95 latency threshold in ms   (default 800)
//   ERROR_RATE     max http_req_failed rate      (default 0.01 = 1%)
//   CORRECTNESS_RATE  max tolerated correctness-check failure rate (default 0 = zero bleed)
//   SUMMARY_JSON   path to also write the end-of-test summary as JSON (optional)
//   ALLOW_PROD     must be "true" to even attempt a non-emulator prod-looking target (guard)

import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { SharedArray } from "k6/data";

// ── Config ────────────────────────────────────────────────────────────────────────────
const BASE_URL = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const AUTH_EMULATOR_HOST = __ENV.AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIREBASE_API_KEY = __ENV.FIREBASE_API_KEY || "fake-api-key";
const TOKEN_MODE = __ENV.TOKEN_MODE || "emulator"; // "emulator" | "static"
const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || "1m";

const USER_PREFIX = __ENV.USER_PREFIX || "loadtest-user";
const USER_DOMAIN = __ENV.USER_DOMAIN || "teammarhaba.test";
const USER_PASSWORD = __ENV.USER_PASSWORD || "loadtest-pw-123456";

const P95_MS = Number(__ENV.P95_MS || 800);
const ERROR_RATE = Number(__ENV.ERROR_RATE || 0.01);
const CORRECTNESS_RATE = Number(__ENV.CORRECTNESS_RATE || 0); // zero tolerance for data bleed

// ── Prod guard ──────────────────────────────────────────────────────────────────────
// A loud refusal to hammer anything that looks like production. Two independent gates:
//   (1) an emulator TOKEN_MODE cannot mint tokens against real Firebase anyway, and
//   (2) any non-localhost, non-emulator target requires ALLOW_PROD=true to proceed.
// This runs at module-eval time so a misdirected run dies immediately, before any traffic.
(function prodGuard() {
  const host = BASE_URL.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  const looksNonProd =
    isLocal || /(^|[.-])(aat|staging|stg|preview|dev|test|nonprod|non-prod)([.-]|$)/i.test(host);
  const allowProd = String(__ENV.ALLOW_PROD || "").toLowerCase() === "true";

  if (TOKEN_MODE === "emulator" && !isLocal && !allowProd) {
    fail(
      `PROD GUARD: TOKEN_MODE=emulator against a non-local target (${host}). The emulator ` +
        `sign-in path won't work against real Firebase, and this looks like it may not be the ` +
        `local e2e stack. Point BASE_URL at the e2e backend, or use TOKEN_MODE=static with ` +
        `pre-minted AAT tokens. To override deliberately, set ALLOW_PROD=true.`,
    );
  }
  if (!looksNonProd && !allowProd) {
    fail(
      `PROD GUARD: BASE_URL host "${host}" does not look like a non-prod target ` +
        `(local / aat / staging / preview / dev / test). Refusing to run — this harness must ` +
        `NEVER hammer production. If this really is a sanctioned non-prod target, re-run with ` +
        `ALLOW_PROD=true (and get sign-off first).`,
    );
  }
})();

// ── Custom metrics ──────────────────────────────────────────────────────────────────
const meLatency = new Trend("me_get_duration", true);
const patchLatency = new Trend("me_patch_duration", true);
const correctnessFailed = new Rate("correctness_check_failed"); // cross-user bleed rate
const isolationChecks = new Counter("isolation_checks_total");
const flowsCompleted = new Counter("flows_completed");

// ── Ramp / VU shape ─────────────────────────────────────────────────────────────────
// STAGES="10s:0-10,50s:10,10s:0" → ramp 0→10 over 10s, hold 10 for 50s, ramp 10→0 over 10s.
// Default (STAGES unset): a gentle ramp up to VUS, a steady hold for DURATION, then a ramp down.
function parseStages(spec) {
  return spec.split(",").map((seg) => {
    const [dur, target] = seg.split(":");
    const t = target.includes("-") ? Number(target.split("-")[1]) : Number(target);
    return { duration: dur.trim(), target: t };
  });
}
const stages = __ENV.STAGES
  ? parseStages(__ENV.STAGES)
  : [
      { duration: "10s", target: VUS }, // ramp up
      { duration: DURATION, target: VUS }, // steady state
      { duration: "5s", target: 0 }, // ramp down
    ];

export const options = {
  scenarios: {
    api_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages,
      gracefulRampDown: "5s",
    },
  },
  // Thresholds FAIL the run (non-zero exit) when breached — this is what makes the harness a
  // gate, not just a report. All overridable via env.
  thresholds: {
    http_req_failed: [{ threshold: `rate<${ERROR_RATE}`, abortOnFail: false }],
    http_req_duration: [`p(95)<${P95_MS}`, "p(99)<2000"],
    // Concurrency-correctness is a HARD gate: any cross-user data bleed fails the run.
    correctness_check_failed: [`rate<=${CORRECTNESS_RATE}`],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// ── Token minting (setup: runs once, before the load) ───────────────────────────────
// Mint one DISTINCT ID token per prospective VU the same way web/e2e/global-setup.mjs does:
// sign in each seeded user against the Firebase Auth *emulator* and grab its idToken. We also
// call GET /me once per user here to JIT-provision the backend `users` row (TM-112) so the
// first in-test read is a steady-state read, not a first-provision write.
//
// For AAT / staging (TOKEN_MODE=static) we DON'T sign in — the emulator isn't there — we read a
// pre-minted TOKENS_FILE instead (see README for how to produce it).
function mintEmulatorToken(email, password) {
  const url = `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const res = http.post(
    url,
    JSON.stringify({ email, password, returnSecureToken: true }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "emulator_signin" } },
  );
  if (res.status !== 200) {
    fail(`emulator sign-in failed for ${email}: ${res.status} ${res.body}`);
  }
  return JSON.parse(res.body).idToken;
}

export function setup() {
  // Static-token mode: read pre-minted tokens (e.g. for AAT). Shape: [{uid?,email,idToken}, …].
  if (TOKEN_MODE === "static") {
    const file = __ENV.TOKENS_FILE;
    if (!file) fail("TOKEN_MODE=static requires TOKENS_FILE=<path to tokens json>");
    const tokens = JSON.parse(open(file));
    if (!Array.isArray(tokens) || tokens.length === 0) {
      fail(`TOKENS_FILE ${file} must be a non-empty JSON array of {email,idToken}`);
    }
    return { users: tokens };
  }

  // Emulator mode (default): mint one distinct token per VU from a seeded account.
  const users = [];
  for (let i = 0; i < VUS; i++) {
    const email = `${USER_PREFIX}-${i}@${USER_DOMAIN}`;
    const idToken = mintEmulatorToken(email, USER_PASSWORD);
    users.push({ email, idToken });
  }

  // Warm the backend: JIT-provision each user's row so in-test reads are steady-state.
  for (const u of users) {
    const r = http.get(`${BASE_URL}/api/v1/me`, {
      headers: { Authorization: `Bearer ${u.idToken}`, Accept: "application/json" },
      tags: { name: "provision_me" },
    });
    if (r.status === 200) {
      const me = JSON.parse(r.body);
      u.uid = me.uid; // capture the server-side identity for the isolation assertion
    } else {
      // Non-fatal here: a mis-seeded account surfaces as a failed in-test check, not a silent pass.
      console.warn(`provision GET /me for ${u.email} returned ${r.status}`);
    }
  }

  console.log(
    `[setup] minted ${users.length} distinct tokens (mode=${TOKEN_MODE}) against ${BASE_URL}`,
  );
  return { users };
}

// ── Per-VU virtual-user flow ─────────────────────────────────────────────────────────
export default function (data) {
  const users = data.users;
  // Each VU claims a DISTINCT seeded identity (round-robin over however many we have — with the
  // default setup there are exactly VUS of them, so this is a 1:1 VU↔user mapping). __VU is 1-based.
  const me = users[(__VU - 1) % users.length];
  const authHeaders = {
    Authorization: `Bearer ${me.idToken}`,
    Accept: "application/json",
  };

  // 1) GET /me — read my profile; it MUST be mine and nobody else's.
  const getRes = http.get(`${BASE_URL}/api/v1/me`, {
    headers: authHeaders,
    tags: { name: "GET /me" },
  });
  meLatency.add(getRes.timings.duration);

  const got = safeJson(getRes);
  const okGet = check(getRes, { "GET /me is 200": (r) => r.status === 200 });

  // Concurrency-correctness: the identity I read back must be the identity I authenticated as.
  // If VU #3 ever sees VU #7's email/uid, that's cross-user data bleed — the whole point of this
  // harness. We compare on email (always present on our seeded tokens) and, when known, uid.
  let identityMine = true;
  if (okGet && got) {
    isolationChecks.add(1);
    identityMine =
      got.email === me.email && (me.uid == null || got.uid === me.uid);
    check(null, {
      "GET /me returns only MY identity (no cross-user bleed)": () => identityMine,
    });
    if (!identityMine) {
      correctnessFailed.add(1);
      console.error(
        `DATA BLEED: VU ${__VU} authed as ${me.email}` +
          `${me.uid ? "/" + me.uid : ""} but GET /me returned ${got.email}/${got.uid}`,
      );
    } else {
      correctnessFailed.add(0);
    }
  }

  // 2) PATCH /me — write a value UNIQUE to this VU, so a subsequent read can detect write-bleed.
  const stamp = `${me.email}#${__ITER}`;
  const patchRes = http.patch(
    `${BASE_URL}/api/v1/me`,
    JSON.stringify({ displayName: stamp, city: `city-${__VU}` }),
    { headers: { ...authHeaders, "Content-Type": "application/json" }, tags: { name: "PATCH /me" } },
  );
  patchLatency.add(patchRes.timings.duration);
  check(patchRes, { "PATCH /me is 200": (r) => r.status === 200 });

  // 3) GET /me again — the value I just wrote must be exactly what I read back (no write bleed),
  //    and the identity must STILL be mine.
  const reRes = http.get(`${BASE_URL}/api/v1/me`, {
    headers: authHeaders,
    tags: { name: "GET /me (verify write)" },
  });
  meLatency.add(reRes.timings.duration);
  const reGot = safeJson(reRes);
  if (reRes.status === 200 && reGot) {
    isolationChecks.add(1);
    const noBleed =
      reGot.email === me.email &&
      reGot.displayName === stamp &&
      (me.uid == null || reGot.uid === me.uid);
    check(null, {
      "write is isolated to MY profile (read-after-write, no bleed)": () => noBleed,
    });
    correctnessFailed.add(noBleed ? 0 : 1);
    if (!noBleed) {
      console.error(
        `WRITE BLEED: VU ${__VU} wrote "${stamp}" as ${me.email} but read back ` +
          `"${reGot.displayName}" for ${reGot.email}/${reGot.uid}`,
      );
    }
  }

  flowsCompleted.add(1);
}

function safeJson(res) {
  try {
    return res.body ? JSON.parse(res.body) : null;
  } catch (_e) {
    return null;
  }
}

// ── Summary: console text + optional JSON artifact ───────────────────────────────────
export function handleSummary(data) {
  const out = { stdout: textSummary(data, { indent: " ", enableColors: true }) };
  const jsonPath = __ENV.SUMMARY_JSON;
  if (jsonPath) out[jsonPath] = JSON.stringify(data, null, 2);
  return out;
}
