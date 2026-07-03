# Maestro e2e flows — TeamMarhaba Android (TM-314)

[Maestro](https://maestro.mobile.dev/) UI flows that drive the **native Capacitor Android app**
(`appId app.teammarhaba.webview`) end-to-end on a real device or emulator. The app loads the hosted
web SPA at `https://teammarhaba.web.app`, so these flows exercise the **whole stack** — the native
shell, the WebView bridge, and the live web UI — in a way the web-only Playwright suite
(`web/e2e/`) cannot.

> These are the **device-level** journeys. The Playwright specs in `web/e2e/` cover the web UI against
> the Firebase Auth emulator; the Maestro flows here cover the same journeys through the **packaged
> Android app** against real (test-mode) Firebase.

## Flows

| Flow | Journey | Notes |
|---|---|---|
| `login-email.yaml` | email → "Email me a code" → 6-digit code → Sign in → home | **Depends on TM-312** for a deterministic code (see below). |
| `login-sms.yaml` | "Try another way" → phone → "Text me a code" → SMS code → Sign in → home | Firebase test number `+16505550100` / `123456`. **Assumes the persisted e2e-flag is pre-injected** (see below). Does NOT `clearState` (would wipe the flag). |
| `warm-restart.yaml` | sign in → relaunch (keep state) → still on home | Verifies the TM-307 persistence fallback. |
| `camera.yaml` | profile → tap avatar → native camera/photos picker prompt | Best-effort; asserts the picker/permission UI. |
| `biometric.yaml` | profile → flip app-lock → BiometricPrompt | Best-effort; needs an enrolled fingerprint to fully complete. |
| `permissions.yaml` | push (POST_NOTIFICATIONS on login) + location (GPS) prompts | Best-effort; asserts + grants the OS dialogs. |
| `events.yaml` | Events → browse list → open detail → RSVP → confirm → land GOING → un-RSVP (TM-399) | **Suite-scoped** (`suite=events`, kept out of the default smoke set). Needs a **seeded public event** + drives a best-effort reminder push receipt — see below. |

Every flow asserts its end state (signed-in home, or the prompt UI) and calls `takeScreenshot` at the
key steps. `warm-restart`, `camera`, `biometric`, and `permissions` reuse `login-sms.yaml` as a
subflow (`runFlow:`) to establish a session.

## Install Maestro

```bash
curl -fsSL "https://get.maestro.mobile.dev" | bash
# adds the `maestro` CLI to ~/.maestro/bin — add that to PATH
maestro --version
```

Maestro talks to whatever device `adb devices` lists. See the
[install docs](https://maestro.mobile.dev/getting-started/installing-maestro) for prerequisites
(a JDK is required).

## Run locally against an emulator

1. **Build + install the app** (debug — see `../README.md`):
   ```bash
   # from the repo root
   npm ci && npx cap sync android
   (cd android && ./gradlew installDebug)
   ```
   > The **debug** build is required for the SMS flow: WebView debugging must be ON so the harness can
   > pre-inject the e2e flag over CDP (see below). The `appId` Maestro targets is
   > `app.teammarhaba.webview` — note the debug variant installs as `app.teammarhaba.webview.debug`;
   > set `appId:` in the flow (or pass `--app-id`) to match the variant you installed.

2. **Start an emulator** (or attach a device) and confirm `adb devices` lists it.

3. **Run a single flow**, overriding inputs as needed:
   ```bash
   # SMS happy path (test number + fixed code are the defaults)
   maestro test android/maestro/login-sms.yaml

   # Email happy path — supply the TM-312 fixed code (or the Gmail-read code) per run
   maestro test android/maestro/login-email.yaml -e EMAIL_CODE=123456

   # Whole suite
   maestro test android/maestro
   ```
   Screenshots land in the Maestro output dir (printed at the end of the run); `maestro test` also
   uploads a report when run with `--format junit` / in Maestro Cloud.

## Test credentials

| What | Value | Source |
|---|---|---|
| SMS test number | `+16505550100` | Firebase fixed test number (TM-241) — no real SMS sent. |
| SMS fixed code | `123456` | Paired with the number above. |
| Email address | `*@teammarhaba.test` | TM-312 allow-list (deterministic, no real mailbox). |
| Email fixed code | TM-312 contract | Set `EMAIL_CODE` from TM-312; **interim:** read from Gmail (below). |

No secrets are committed. Real-number/real-mailbox sign-in is out of scope for these flows.

### Email-code: TM-312 dependency + Gmail-read interim

`login-email.yaml` needs a **deterministic** 6-digit code.

- **Target (TM-312):** a fixed-code test-email hook — any `@teammarhaba.test` address (an allow-list)
  receives a **fixed** code with no real email sent. Once TM-312 is merged + deployed, set
  `TEST_EMAIL`/`EMAIL_CODE` in the flow (or pass `-e EMAIL_CODE=...`) to the TM-312 values and the
  flow runs hands-off.
- **Interim (until TM-312 lands):** drive a **real** `@teammarhaba.test`-style address through a real
  mailbox and have a harness step **read the latest code from Gmail** (Gmail API / IMAP), then pass it
  in: `maestro test android/maestro/login-email.yaml -e EMAIL_CODE=<code-from-gmail>`. This is a
  human/harness step outside Maestro — Maestro itself cannot read an inbox.

## e2e-flag injection contract (SMS / phone auth)

`login-sms.yaml` relies on the gated reCAPTCHA-bypass flag, which `web/src/assets/auth.js`
(via the pure `web/src/assets/phone-e2e.js` module) reads to set
`auth.settings.appVerificationDisabledForTesting = true` **only when both** hold:

1. **Requested** — any of: the **persisted** `localStorage["tm_e2e_phone_test"] === "1"` (TM-318),
   `window.__TM_E2E_PHONE_TEST__ === true`, or `TEAMMARHABA_CONFIG.phoneTestMode === true`.
2. **Context-safe** — the Auth emulator is wired in **or** we're inside the native Capacitor shell
   (`window.Capacitor.isNativePlatform() === true`). Inside this app, condition 2 is **automatic**.

So the flow only needs condition 1, and the flag must be set **before `auth.js` evaluates** — it's
read once at module load (and again after every page reload / app relaunch).

**Why pure Maestro can't set it:** Maestro's `runScript`/`evalScript` run in Maestro's **own** JS
sandbox, not inside the app's WebView, so they cannot reach the SPA's `window`/`localStorage`. There
is also **no deep link or URL query param** the app honours for this — `server.url` is fixed in
`capacitor.config.json`. So pure Maestro alone **cannot** establish condition 1.

**Chosen mechanism — harness pre-injection of a PERSISTED flag over CDP (TM-318):** before the flows
run, the `mobile-e2e.yml` harness attaches to the app's WebView via the Chrome DevTools Protocol and
runs (see `inject-e2e-flag.mjs`):

```js
localStorage.setItem("tm_e2e_phone_test", "1");
```

A **persisted** localStorage key is used **instead of** a `window` global or
`Page.addScriptToEvaluateOnNewDocument` because **both of those are wiped by the app relaunch Maestro
performs on `launchApp`** — localStorage survives the relaunch, so `auth.js` re-reads the flag fresh
on every page load. This requires a **debug** build (`WebView.setWebContentsDebuggingEnabled(true)` is
on for debug, off for release), so the flag is **unreachable in production** — and even if it weren't,
condition 2 (context-safe) keeps it a no-op on the public https site.

**The `clearState` contract (TM-318):** because the flag lives in localStorage, **no flow may
`clearState` on `launchApp`** — that would wipe the harness-injected flag and re-arm the reCAPTCHA
gate. `login-sms.yaml` and `login-email.yaml` therefore launch with `clearState: false` and reach the
signed-out front door by **signing out** (optional steps, skipped on an already-signed-out launch)
rather than clearing app data. Any new flow that needs the phone-e2e bypass must follow the same rule.

The mechanism is steps in `mobile-e2e.yml`'s emulator `script` block: launch the app
(`adb shell monkey`), find the WebView devtools socket
(`adb shell cat /proc/net/unix | grep webview_devtools_remote`), `adb forward` a local TCP port to it,
then run `node android/maestro/inject-e2e-flag.mjs` (which sets + verifies the key and reloads the
page). `login-sms.yaml` is written so a **missing** injection fails **loud** — the reCAPTCHA gate
fires, the "Text a code" step never appears, and the `assertVisible: { id: "sms-step-code" }` step
times out — rather than hanging silently.

> If you run `login-sms.yaml` **without** the harness having pre-injected the flag, expect a reCAPTCHA
> challenge / timeout. That is the contract these flows assume, not a flow bug. To inject manually
> against a local emulator: `adb shell monkey -p app.teammarhaba.webview -c android.intent.category.LAUNCHER 1`,
> find the socket, `adb forward tcp:9222 localabstract:<socket>`, then
> `CDP_PORT=9222 node android/maestro/inject-e2e-flag.mjs`.

> **Deploy caveat (TM-318):** the app loads the **hosted prod SPA** (`https://teammarhaba.web.app`),
> so the `auth.js`/`phone-e2e.js` change that reads the persisted key must be **deployed** before a
> nightly/dispatch/PR emulator run can honour the injected flag. Until the deploy lands, the SMS flow
> runs against the still-old hosted SPA and will hit the reCAPTCHA gate.

## Dependencies

- **TM-309** — the gated phone-auth e2e hook (the request/context-safe gate in `phone-e2e.js`).
- **TM-318** — extends the gate to read the **persisted** `localStorage["tm_e2e_phone_test"]` key, and
  wires the `mobile-e2e.yml` harness (`inject-e2e-flag.mjs`) to set it over CDP before the flows run
  (the contract `login-sms.yaml`, `warm-restart.yaml`, `camera.yaml`, `biometric.yaml`,
  `permissions.yaml` assume). **Must be deployed to the hosted SPA** before a run honours the flag.
- **TM-312** — the fixed-code test-email hook for `login-email.yaml` (Gmail-read interim until then).

## Best-effort native flows — device prerequisites

- **camera** — a generic emulator has no real camera image; the flow asserts the picker/permission UI
  appears but does not complete a capture.
- **biometric** — needs an enrolled fingerprint to fully complete the BiometricPrompt; on an emulator:
  `adb -e emu finger touch 1` after the prompt shows.
- **permissions** — the push (POST_NOTIFICATIONS) dialog only appears on **API 33+**; on older API
  levels it's auto-granted at install (no dialog). The flow guards these with `optional: true` so it
  never hard-fails on absent or locale-different OS chrome.

## Events journey (TM-399) — selection, data precondition, reminder push receipt

`events.yaml` walks the merged user Events UI (TM-396): **sign in → open Events → browse the list →
open an event detail → RSVP → confirm ("I'm going") → land GOING (✓ Going + "we'll remind you the day
before") → un-RSVP**. It reuses `login-sms.yaml` as the sign-in subflow (same e2e-flag contract).

**Selector note.** The TM-396 UI tags interactive nodes with `data-testid` (`event-card`,
`event-primary-action`, `event-mystate`, `event-remind-note`…), not DOM `id`s — and Maestro's `id:`
matches a DOM `id`, not `data-testid`. So the flow targets those elements by their **stable tested
copy** (from `web/src/assets/events-core.js`) and annotates each step with the matching `data-testid`.
`text:` is an **anchored regex**, so strings with regex metacharacters (`?`, the 🎉 emoji) are matched
with a tolerant `.*…*` pattern.

**How to run it.** It's **suite-scoped** — the default/all/nightly android set (`login-sms`,
`warm-restart`, `camera`, `biometric`, `permissions`) deliberately **excludes** it (it carries a data
precondition), so `mobile-e2e.yml` is unchanged. Select it explicitly:

```bash
gh workflow run test-suite.yml -f suite=events -f surface=android -f jira_ticket=TM-399
# locally: bash android/maestro/ci-run.sh <debug.apk> events
#   or a single flow (seed first): maestro test android/maestro/events.yaml -e EVENT_HEADING="…"
```

### Events data precondition (the honest e2e contract)

The flow RSVPs to a **real, public, upcoming event** identified by its heading (env `EVENT_HEADING`,
default `TeamMarhaba e2e coffee morning`). Events are **admin-created** (no public seed path), so — the
same way `login-sms.yaml` assumes the injected reCAPTCHA flag + the deployed SPA — this flow assumes
that event exists; if it doesn't, the browse assertion fails **loud** (not a hang). The seeded event
should have **no age band** (so the TM-415 age gate is a no-op) and start **> 60 min out** (outside the
TM-413 booking cutoff, so a fresh RSVP lands GOING). Two ways to satisfy it:

- **Seed hook (CI):** set `EVENTS_SEED_CMD` — `ci-run.sh` runs it before the flow (e.g. a `curl` to
  `POST /api/v1/admin/events` with an admin token, or `gh workflow run` a seeding job). It stays out of
  this repo because it needs an **admin** credential (the human-secret split); the harness only invokes
  the hook you give it.
- **Pre-seed once:** create one public demo event with that heading via the admin Events console — a
  one-time action, like registering the Firebase test number.

### Events reminder / lifecycle push receipt (best-effort, non-gating — the TM-368 method)

Pure Maestro can't register an FCM token, trigger a send, or read the tray, so "a real
reminder/lifecycle push was **received** on the emulator" is a best-effort **harness** step
(`ci-run.sh` → `verify_reminder_push`), run right after `events.yaml` against its still-signed-in
session. It applies the TM-368 method (a `google_apis` emulator receives real FCM):

1. Grant `POST_NOTIFICATIONS` so `push.js` registers a real FCM token.
2. Over CDP (`push-receipt.mjs`, same bridge as `inject-e2e-flag.mjs`) drive the app's own client:
   opt into push (`api.js` `updateMe({notificationPref:"BOTH"})`) + read the device token
   (`push.js` `getCurrentToken()`) — token presence proves the device is targetable.
3. **Trigger** the push — a reminder needs the wall-clock scheduler; a lifecycle push is
   `POST /api/v1/admin/events/{id}/cancel`; `POST /api/v1/admin/users/{id}/test-push` is the generic
   real-FCM send. All need an **admin** send (or the 24h/1h scheduler), so the trigger is
   environment-provided: set `EVENTS_PUSH_TRIGGER_CMD` to run one.
4. Capture evidence: `dumpsys notification` + a tray screenshot into `maestro-artifacts/`
   (`push-dumpsys.txt`, `push-tray.png`).

It **never changes the run's pass/fail** — emulator FCM delivery + the admin/wall-clock trigger are
outside the flow's control, so this is advisory evidence (the same posture as the iOS `optional/`
tier). The deterministic in-app journey (browse → RSVP → un-RSVP) is the gating part.

### Screenshot harvest (TM-371)

`ci-run.sh` now **harvests** each flow's `takeScreenshot` PNGs from `~/.maestro/tests/<ts>/` into
`maestro-artifacts/screenshots-<flow>/` after every flow (mirroring `ios/maestro/ci-run.sh`), so the
Jira evidence zip — built from `maestro-artifacts/` only — carries the **full per-step set**, not just
whatever the GH artifact's `~/.maestro/tests` path caught. This closes the android side of the
recurring harvest gotcha.
