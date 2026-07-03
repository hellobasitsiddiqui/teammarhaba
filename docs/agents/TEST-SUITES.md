# TEST-SUITES — the on-demand test-suite library (epic TM-339)

What each suite is, how to fire it, where the evidence lands, and when to run which.

The library has **one dispatch entrypoint**:
[`.github/workflows/test-suite.yml`](../../.github/workflows/test-suite.yml) ("Test suite
(on-demand)", TM-340). It runs a chosen **suite** on a chosen **surface** and (optionally) attaches
screenshots + a pass/fail summary to a Jira ticket. It is a library you **invoke** — never a
PR/merge gate (the fast gate is `ci.yml`); the one automatic run is the nightly iOS keep-warm cron
(below).

```bash
# The general form (from a repo clone; add -R hellobasitsiddiqui/teammarhaba from outside):
gh workflow run test-suite.yml -f suite=<suite> -f surface=<surface> \
  [-f jira_ticket=TM-XXX] [-f duration_minutes=N] [-f vus=N]
```

Exact inputs (from the yml — these are the only ones):

| Input | Required | Default | Values / meaning |
|---|---|---|---|
| `suite` | yes | `all` | `auth` `onboarding` `terms` `profile` `avatar` `admin` `broadcast` `theme` `help` `badges` `webview` `responsive` (feature tags) · `all` · `golden` · `soak` · `load` |
| `surface` | yes | `web` | `web` · `mobile-web` · `android` · `ios` |
| `jira_ticket` | no | `""` | Ticket key to attach evidence to (e.g. `TM-190`). Blank = skip. |
| `duration_minutes` | no | `""` | Soak duration in minutes (soak suite only; passthrough). |
| `vus` | no | `""` | Virtual users / concurrency (load suite only; passthrough). |

Dispatches of the same `(suite, surface)` pair serialize (concurrency group, no cancel), so two
identical dispatches queue rather than fight over the emulator.

---

## The suite catalog

Four suite types + `all`:

| Suite | Type | What it is |
|---|---|---|
| `auth` … `responsive` | **Per-feature regression** | The Playwright specs carrying that `@tag`: `npx playwright test --project=<project> --grep "@<suite>"`. Tag→spec map below. |
| `all` | **Full regression** | The whole tagged Playwright suite, no grep. |
| `golden` | **Golden-path journey** (TM-341, `web/e2e/suites/golden.sh`) | ONE long happy-path run of the single `@golden` spec ([`golden-path.spec.mjs`](../../web/e2e/tests/golden-path.spec.mjs)): sign in (email code) → onboarding gate → terms gate → profile edit (DB persist) → avatar upload + re-upload (TM-335 regression) → home (+ admin console if admin) → help / visual guide → sign out. Living evidence the product works front-to-back; screenshots at every major step. |
| `soak` | **Soak / endurance** (TM-342, `web/e2e/suites/soak.sh`) | LOOPS the same `@golden` journey back-to-back until `DURATION_MINUTES` (default **10**) elapses. Records pass/fail + wall-clock seconds per iteration, then a summary (iterations, pass/fail, min/max/avg). Hard-fails on any failed iteration (or zero iterations); flags **upward latency drift** — last-quartile avg iteration time exceeding the first quartile's by more than `DRIFT_PCT` (default **20%**, needs ≥4 iterations) — as a loud warning, not a fail. Surfaces leaks, gradual degradation, intermittent flakiness. |
| `load` | **Load / concurrency-correctness** (TM-343, k6) | [`test/load/api-load.js`](../../test/load/README.md): N distinct seeded virtual users each looping `GET /me` → `PATCH /me` (a value unique to that VU) → `GET /me`, asserting identity isolation and read-after-write isolation (zero cross-user bleed). Both a perf gate (default thresholds: p95 < 800ms, p99 < 2000ms, error rate < 1%) and a correctness gate (`correctness_check_failed` must be 0). **Fired via `load-test.yml`, not `test-suite.yml` — see the caveat below.** |

### Feature tag → spec map (`web/e2e/tests/`)

| `suite=` | Spec(s) |
|---|---|
| `auth` | `email-code-login.spec.mjs` |
| `onboarding` | `onboarding-gate.spec.mjs` |
| `terms` | `terms-gate.spec.mjs` |
| `profile` | `profile-edit.spec.mjs`, `profile-blank-phone.spec.mjs` |
| `avatar` | `avatar-upload.spec.mjs` |
| `admin` | `admin-walkthrough.spec.mjs`, `broadcast-admin.spec.mjs` |
| `broadcast` | `broadcast-admin.spec.mjs` |
| `theme` | `theme-visual.spec.mjs` |
| `help` | `help-and-byline.spec.mjs` |
| `badges` | `get-the-app-badges.spec.mjs` |
| `webview` | `webview-get-app-hidden.spec.mjs`, `webview-google-hidden.spec.mjs` |
| `responsive` | `responsive-mobile.spec.mjs` — **mobile-web surface only** (the desktop `chromium` project `testIgnore`s it) |

### The `suite=load` caveat

`test-suite.yml` hands `golden|soak|load` off to `web/e2e/suites/<suite>.sh`. `golden.sh` and
`soak.sh` exist; **`load.sh` does not** — so `suite=load` on `web`/`mobile-web` currently exits
with the workflow's explicit "not implemented yet" error. TM-343 delivered the load suite as a k6
harness with its own workflow instead. **Fire load like this:**

```bash
gh workflow run load-test.yml -f vus=20 -f duration=1m -f p95_ms=800 -f error_rate=0.01
```

`load-test.yml` inputs (all optional): `vus` (default `20`), `duration` (k6 hold, default `1m`),
`p95_ms` (default `800`), `error_rate` (max `http_req_failed` rate, default `0.01`). It stands up
its own non-prod stack (Postgres + Auth emulator + backend), seeds `vus` accounts, and runs the
harness. **Never points at production** — the script has a prod guard (`ALLOW_PROD=true` +
sign-off required to override); AAT/staging runs use `TOKEN_MODE=static` with pre-minted tokens
(see [`test/load/README.md`](../../test/load/README.md)).

---

## Surfaces — the cross-surface model

Every journey is meant to run across four surfaces. Android & iOS are Capacitor WebViews loading
the **same hosted web app**, so the journeys are shared — only the runner differs:

| `surface=` | Runner | Notes / caveats |
|---|---|---|
| `web` | Playwright `chromium` project (Desktop Chrome), ubuntu; full emulator-backed stack (Postgres + Firebase Auth/Storage emulators + backend), mirrors `e2e.yml` | Runs every spec except `responsive-mobile` (use `mobile-web` for `suite=responsive`). |
| `mobile-web` | Playwright `mobile-chromium` project (Pixel 5 viewport, ≈393px), same stack | The project's `testMatch` only includes `responsive-mobile`, `golden-path`, `broadcast-admin` — so the meaningful suites here are `all`, `golden`, `soak`, `responsive`, `broadcast`, `admin`. Any other feature tag matches no spec in this project and Playwright exits non-zero with "no tests found". |
| `android` | Maestro on an Android emulator (API 34, Pixel 6 profile), debug APK, via [`android/maestro/ci-run.sh`](../../android/maestro/README.md) | **Per-tag Maestro selection is wired for `events` only** (TM-399): `suite=events` runs the Events journey (`events.yaml`: browse → detail → RSVP → confirm → un-RSVP + a best-effort reminder/lifecycle push receipt), which needs a **seeded public event** (`EVENTS_SEED_CMD` / pre-seed — see the README). **Any other `suite`** runs the shared smoke set (`login-sms`, `warm-restart`, `camera`, `biometric`, `permissions`; `login-email` disabled, `events` excluded) with a `::notice::` — still meaningful as a smoke over the surface. Each flow starts from clean state (`pm clear`) with the `tm_e2e_phone_test` reCAPTCHA-bypass flag re-injected over CDP; the flag-reading web code must be **deployed** to the hosted SPA for flows to pass. `ci-run.sh` now also **harvests** per-step screenshots into `maestro-artifacts/` (TM-371). |
| `ios` | Maestro on the iOS Simulator (`macos-latest`, billed ~10×), Debug build for the `iphonesimulator` SDK with signing disabled, via [`ios/maestro/ci-run.sh`](../../ios/maestro/README.md) | Same "shared flow set regardless of suite" rule as android. **Scope caveat (TM-354):** the iOS **gate** is a launch + WKWebView **render** smoke only — `golden-path.yaml` hard-asserts the hosted SPA rendered via static login text, screenshotting each step. The authenticated journey + per-plugin flows live in `ios/maestro/optional/` and run **best-effort, never gating** (Maestro-on-iOS can't reliably drive dynamic WKWebView DOM). The journey logic is covered by the web Playwright golden-path (same web code) + the human manual test (TM-355). Ceiling: Simulator only — no signing/device/real push. |

---

## How to fire — worked examples

```bash
# Full tagged regression on desktop web
gh workflow run test-suite.yml -f suite=all -f surface=web

# One feature's regression suite, evidence attached to a ticket
gh workflow run test-suite.yml -f suite=profile -f surface=web -f jira_ticket=TM-190

# Golden-path journey on each surface
gh workflow run test-suite.yml -f suite=golden -f surface=web
gh workflow run test-suite.yml -f suite=golden -f surface=mobile-web
gh workflow run test-suite.yml -f suite=golden -f surface=android -f jira_ticket=TM-190
gh workflow run test-suite.yml -f suite=golden -f surface=ios

# 30-minute soak on desktop web
gh workflow run test-suite.yml -f suite=soak -f surface=web -f duration_minutes=30

# Load / concurrency (k6) — its own workflow (see caveat above)
gh workflow run load-test.yml -f vus=50 -f duration=2m

# Watch / fetch results
gh run list --workflow=test-suite.yml --limit 3
gh run watch <run-id> --exit-status
gh run download <run-id> -n test-suite-<suite>-<surface>
```

Companion dispatchables outside the library entrypoint:

```bash
# Full nightly web Playwright suite (both projects), on demand + optional evidence ticket
gh workflow run e2e.yml -f evidence_ticket=TM-XXX

# Full Android emulator Maestro run, on demand + optional evidence ticket
gh workflow run mobile-e2e.yml -f evidence_ticket=TM-XXX

# Build-health + live-serving canary, on demand
gh workflow run nightly-canary.yml
```

Local runs: `cd web/e2e && npx playwright test --grep @golden` (stack up first — see
[`web/e2e/suites/README.md`](../../web/e2e/suites/README.md)); `k6 run test/load/api-load.js`
(see [`test/load/README.md`](../../test/load/README.md)); `maestro test android/maestro/<flow>.yaml`
(see [`android/maestro/README.md`](../../android/maestro/README.md)).

---

## Where evidence lands

**GitHub Actions artifacts** (uploaded `always()`, even on failure):

| Run | Artifact | Contents |
|---|---|---|
| `test-suite.yml` web / mobile-web | `test-suite-<suite>-<surface>` | `web/e2e/playwright-report` + `web/e2e/test-results` (per-step screenshots — `screenshot: "on"` is forced in the config — plus traces/videos on failure) |
| `test-suite.yml` android | `test-suite-<suite>-android` | `maestro-artifacts/` (JUnit `report-<flow>.xml` + `debug-<flow>/`) **and** `~/.maestro/tests` (see gotcha) |
| `test-suite.yml` ios | `test-suite-<suite>-ios` (nightly cron: `test-suite-nightly-ios`) | `maestro-artifacts/` (launch shot `00-app-launched.png`, per-flow `screenshots-<flow>/`, `OPTIONAL_RESULTS.txt`) **and** `~/.maestro/tests` |
| `load-test.yml` | `k6-summary` (+ `load-test-logs` on failure) | `k6-summary.json` end-of-test summary |
| `e2e.yml` | `playwright-report` (+ `e2e-logs` on failure) | report + `test-results` screenshots |
| `mobile-e2e.yml` | `maestro-evidence` + `app-debug-apk` | `maestro-artifacts` + `~/.maestro/tests`; the debug APK |

**Jira** — pass `-f jira_ticket=TM-XXX` (or `evidence_ticket` on `e2e.yml`/`mobile-e2e.yml`) and
[`.github/scripts/test-suite-evidence.sh`](../../.github/scripts/test-suite-evidence.sh) attaches
an evidence **zip** + a `summary.txt` (suite / surface / verdict / run link) and posts a one-line
pass/fail comment. Best-effort: it never fails the job and skips silently if the ticket or
`JIRA_*` secrets are missing.

### The `~/.maestro` harvest gotcha (TM-371 — keeps biting)

Maestro writes `takeScreenshot` outputs to its own per-run dir **`~/.maestro/tests/<timestamp>/`**
(and/or the CWD, depending on version) — **not** into `maestro-artifacts/`. Consequences:

- The GH artifact **does** capture them (the upload path includes `~/.maestro/tests`).
- The **Jira evidence zip is built from `maestro-artifacts` only**. The iOS runner harvests every
  flow's shots into `maestro-artifacts/screenshots-<flow>/` after each flow, so its zip carries the
  full set; the **Android runner does not harvest** — Android per-step shots must be pulled from
  the GH artifact (`gh run download … -n test-suite-<suite>-android`), not the Jira zip.

**Evidence rule (sprint DoD):** the automated-test ticket needs the **FULL set of per-step
screenshots attached as individual viewable PNGs** — never one shot, never only the CI zip — and
the count verified (a single screenshot is a red flag). If a lane loses shots, fix the lane's
harvest, don't ship "1 shot + a follow-up ticket".

---

## When each runs automatically

The nightly ladder (offset so the slow runs don't contend for runners):

| UTC | Workflow | What runs |
|---|---|---|
| 03:00 | `e2e.yml` | Full web Playwright suite (both `chromium` + `mobile-chromium` projects) against the emulator stack |
| 04:00 | `mobile-e2e.yml` | Full Android emulator Maestro flow set (per-PR trigger intentionally OFF — advisory, never a merge gate) |
| 05:00 | `test-suite.yml` | **iOS Simulator keep-warm only** — on the `schedule` event the inputs are empty, so only the `ios` job fires (stops the slow, macOS-billed lane rotting between dispatches); the web/mobile-web/android jobs stay dispatch-only |
| 06:00 | `nightly-canary.yml` | Fresh-clone full backend build + test, then live health: Cloud Run Ready revision + Firebase Hosting 200. Opens an issue on failure |

Always-on baseline (not part of the library): `ci.yml` on every PR/push to `main` (the fast
required gate) and the path-filtered `ios-simulator.yml` compile check on PRs touching `ios/**`.
`load-test.yml` is never scheduled — deliberate, heavy, dispatch-only.

---

## When to run which — mapping to the DoD gates

| Moment | Fire |
|---|---|
| **Every PR** | Nothing from the library — `ci.yml` is the automatic fast gate. The suite library is never a PR gate. |
| **Before merging a `web/`-touching PR** | e2e is off the PR gate and rots un-run (GENESIS "no-rot guard"): dispatch `e2e.yml` — or at minimum `suite=golden surface=web` — on the branch and require green before merge. |
| **After a risky change to one feature** | That feature's suite: `suite=<tag> surface=web` (+ `mobile-web` when the spec is mobile-covered: golden / responsive / broadcast / admin). |
| **Major ship / epic close** | `suite=golden` on **all four surfaces** (web, mobile-web, android, ios) — remembering the iOS gate proves launch+render only. |
| **Sprint closure — the automated e2e test ticket** | Run the sprint's flows with `-f jira_ticket=<automated-test-ticket>` so the verdict + zip land on the ticket, then download the artifacts and attach the **full viewable screenshot set** (see the evidence rule above). This is gate 1(b) of the sprint-closure DoD — see [`GENESIS.md`](GENESIS.md) § "Sprint-closure gate" and [`SPRINTS.md`](project/SPRINTS.md) § "Per-sprint testing — always SPLIT". The **manual** test ticket (human, live app + real device), the cross-sprint **code review**, and the **deploy** are the other, separate gates — a suite run substitutes for none of them. |
| **Blocker / intermittent bug** | The area's feature suite to reproduce; add `suite=soak -f duration_minutes=30` (or longer) when a leak, gradual degradation, or flaky recurrence is suspected — the drift summary is the tell. |
| **Perf / concurrency risk** (new hot endpoint, auth/session changes, anything multi-user) | `load-test.yml` — perf thresholds + zero-cross-user-bleed correctness. Non-prod only; prod-directed runs need explicit sign-off. |
| **Release gate / deploy** | Nightly ladder green (03:00–06:00) + a fresh `golden` pass; after deploying, the canary (06:00 or `gh workflow run nightly-canary.yml`) confirms the live revision serves. |

---

## Deeper docs

- [`web/e2e/suites/README.md`](../../web/e2e/suites/README.md) — the golden/soak/load script contract (`PW_PROJECT`, `DURATION_MINUTES`, `VUS`)
- [`test/load/README.md`](../../test/load/README.md) — k6 knobs, thresholds, AAT/static-token mode, prod guard
- [`android/maestro/README.md`](../../android/maestro/README.md) — Android flows, test credentials, the CDP flag-injection contract
- [`ios/maestro/README.md`](../../ios/maestro/README.md) — iOS gate-vs-optional tiers and the Simulator limitation
- [`docs/qa/mobile-two-layer.md`](../qa/mobile-two-layer.md) / [`docs/qa/MANUAL-WALKTHROUGHS.md`](../qa/MANUAL-WALKTHROUGHS.md) — the manual-testing counterparts
- [`GENESIS.md`](GENESIS.md) · [`conventions/AGENTIC-LESSONS.md`](conventions/AGENTIC-LESSONS.md) — the sprint-closure gate + fleet lessons these suites plug into

Tickets: epic **TM-339**; TM-340 (dispatch foundation), TM-341 (golden), TM-342 (soak), TM-343
(load/k6), TM-353/TM-354 (iOS lane + scope), TM-371 (screenshot harvest).
