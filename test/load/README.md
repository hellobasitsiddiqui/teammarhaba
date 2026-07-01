# Load / concurrency harness (k6) — TM-343

A [k6](https://k6.io) harness that drives **N concurrent virtual users** against the backend API,
reports latency percentiles / error rate / throughput, and — crucially — asserts
**concurrency-correctness**: that under concurrent load no user ever sees another user's data
(no cross-user bleed / isolation races). It's both a **perf gate** (thresholds fail the run) and a
**correctness gate** (any data bleed fails the run).

- Script: [`api-load.js`](./api-load.js)
- Seeder: [`seed-users.mjs`](./seed-users.mjs) (seeds N disposable emulator accounts)

> ## ⚠ NON-PROD ONLY
> `BASE_URL` defaults to the **local e2e stack** (`http://127.0.0.1:8080`). The default token path
> mints test tokens via the **Firebase Auth _emulator_** sign-in endpoint — a path that only exists
> on an emulator, so it can't even authenticate against real Firebase. On top of that a **prod guard**
> in the script refuses any target whose host doesn't look non-prod (local / `aat` / `staging` /
> `preview` / `dev` / `test`) unless you explicitly pass `ALLOW_PROD=true`. **Never point this at
> production.** Get sign-off before any prod-directed run (see the Human step on TM-343).

## The scenario (per VU iteration)

Each virtual user authenticates as a **distinct seeded user** and loops:

1. `GET  /api/v1/me` — read my profile; **assert `uid`/`email` are mine** (identity isolation).
2. `PATCH /api/v1/me` — write a value **unique to this VU** (`displayName = <my-email>#<iter>`).
3. `GET  /api/v1/me` — re-read; **assert I read back exactly what I wrote** and identity is still
   mine (read-after-write isolation — catches write-bleed between concurrent users).

Tokens are minted **once in `setup()`** (one distinct ID token per VU) the same way
`web/e2e/global-setup.mjs` does — sign each seeded account in against the emulator's
`accounts:signInWithPassword` endpoint and keep its `idToken`. `setup()` also does a warm
`GET /me` per user to JIT-provision its backend row so in-test reads are steady-state.

## Thresholds (fail the run when breached)

| Metric | Default | Override |
| --- | --- | --- |
| `http_req_duration` p95 | `< 800ms` | `-e P95_MS=…` |
| `http_req_duration` p99 | `< 2000ms` | (edit script) |
| `http_req_failed` rate | `< 1%` | `-e ERROR_RATE=0.01` |
| `correctness_check_failed` rate | `<= 0` (zero data bleed) | `-e CORRECTNESS_RATE=…` |

A breach makes `k6 run` exit non-zero, so it gates CI.

## Run against the local e2e stack

Prereqs: k6, Node 20+, JDK 21, Docker, and the same stack the browser e2e uses. Bring the stack up
exactly as in [`../../web/e2e/README.md`](../../web/e2e/README.md) (Postgres + Auth emulator + backend
on `:8080`). Then:

```bash
# 1. Seed N distinct load-test accounts (uses firebase-admin from web/e2e's node_modules).
#    Run it from web/e2e so the firebase-admin import resolves:
cd web/e2e && npm install
VUS=50 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 E2E_API_BASE_URL=http://127.0.0.1:8080 \
  node ../../test/load/seed-users.mjs

# 2. Run the harness (defaults: 5 VUs, ramped, ~1m). From repo root:
k6 run test/load/api-load.js

# Scale it up + a longer hold:
k6 run -e VUS=50 -e DURATION=2m test/load/api-load.js

# Emit a JSON summary artifact alongside the console summary:
k6 run -e VUS=50 -e SUMMARY_JSON=k6-summary.json test/load/api-load.js
```

> `seed-users.mjs` seeds `VUS` accounts named `loadtest-user-0..N-1@teammarhaba.test`. Keep the same
> `VUS` (and `USER_PREFIX`/`USER_DOMAIN`/`USER_PASSWORD` if overridden) for both the seeder and the
> k6 run so the token mint in `setup()` finds them. If you only need a quick smoke and have no
> `firebase-admin` handy, you can create accounts straight against the emulator instead:
> `curl -s -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key" -H "Content-Type: application/json" -d '{"email":"loadtest-user-0@teammarhaba.test","password":"loadtest-pw-123456","returnSecureToken":true}'`

## Run against AAT / staging (`TOKEN_MODE=static`)

There's no emulator on AAT, so you can't mint tokens in-script. Pre-mint real ID tokens for N
**disposable AAT test accounts** out-of-band and hand them to k6 as a JSON file:

```bash
# tokens.json — a JSON array; uid is optional (email is asserted, uid too when present):
# [ { "email": "loadtest-0@…", "uid": "…", "idToken": "eyJ…" }, … ]
k6 run -e VUS=20 -e TOKEN_MODE=static -e TOKENS_FILE=./tokens.json \
       -e BASE_URL=https://<aat-backend-host> test/load/api-load.js
```

The prod guard accepts an `aat`/`staging`/`preview`/`dev`/`test` host; a bare prod host is refused
unless `ALLOW_PROD=true` is also set (and it should only be set with explicit sign-off).

## Knobs (all optional; `-e KEY=VALUE` or env)

| Key | Default | Meaning |
| --- | --- | --- |
| `VUS` | `5` | virtual users (also how many tokens `setup()` mints) |
| `DURATION` | `1m` | steady-state hold (used when `STAGES` is unset) |
| `STAGES` | — | explicit ramp, e.g. `"10s:0-10,50s:10,10s:0"` (overrides `VUS`/`DURATION` shape) |
| `BASE_URL` | `http://127.0.0.1:8080` | backend base URL (non-prod) |
| `AUTH_EMULATOR_HOST` | `127.0.0.1:9099` | Firebase Auth emulator host |
| `FIREBASE_API_KEY` | `fake-api-key` | emulator API key (any string works on the emulator) |
| `TOKEN_MODE` | `emulator` | `emulator` (mint) or `static` (read `TOKENS_FILE`) |
| `TOKENS_FILE` | — | JSON tokens for `TOKEN_MODE=static` |
| `USER_PREFIX` / `USER_DOMAIN` / `USER_PASSWORD` | `loadtest-user` / `teammarhaba.test` / `loadtest-pw-123456` | seeded-account shape |
| `P95_MS` / `ERROR_RATE` / `CORRECTNESS_RATE` | `800` / `0.01` / `0` | thresholds |
| `SUMMARY_JSON` | — | also write the end-of-test summary as JSON to this path |
| `ALLOW_PROD` | — | must be `true` to override the prod guard (needs sign-off) |

## How TM-340 dispatches this

TM-340's `test-suite.yml` (`suite=load vus=N`) invokes this exact command against the non-prod
target it stands up:

```bash
k6 run -e VUS="${VUS}" -e DURATION="${DURATION:-1m}" \
       -e BASE_URL="${BASE_URL}" -e SUMMARY_JSON=k6-summary.json \
       test/load/api-load.js
```

A ready-to-wire `workflow_dispatch` job stub lives at
[`../../.github/workflows/load-test.yml`](../../.github/workflows/load-test.yml) — it stands up the
same Postgres + Auth-emulator + backend stack the e2e workflow uses, seeds `VUS` accounts, and runs
the harness. TM-340 can call that job (or inline the command above) from the dispatch matrix.

## Smoke result (VUS=2, ~8s hold, local e2e stack)

```
✓ GET /me is 200
✓ GET /me returns only MY identity (no cross-user bleed)
✓ PATCH /me is 200
✓ write is isolated to MY profile (read-after-write, no bleed)

checks ....................: 100.00%  ✓ 5204  ✗ 0
✓ correctness_check_failed .: 0.00%    ✓ 0     ✗ 2602
✓ http_req_duration ........: p(95)=14.43ms  (< 800ms)
✓ http_req_failed ..........: 0.00%
http_reqs ..................: 3907   163.18/s
iterations .................: 1301
```

All thresholds green; zero cross-user data bleed across ~1,300 concurrent iterations.
