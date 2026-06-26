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
| `login-sms.yaml` | "Try another way" → phone → "Text me a code" → SMS code → Sign in → home | Firebase test number `+16505550100` / `123456`. **Assumes the e2e-flag is pre-injected** (see below). |
| `warm-restart.yaml` | sign in → relaunch (keep state) → still on home | Verifies the TM-307 persistence fallback. |
| `camera.yaml` | profile → tap avatar → native camera/photos picker prompt | Best-effort; asserts the picker/permission UI. |
| `biometric.yaml` | profile → flip app-lock → BiometricPrompt | Best-effort; needs an enrolled fingerprint to fully complete. |
| `permissions.yaml` | push (POST_NOTIFICATIONS on login) + location (GPS) prompts | Best-effort; asserts + grants the OS dialogs. |

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

`login-sms.yaml` relies on the gated reCAPTCHA-bypass flag `window.__TM_E2E_PHONE_TEST__ = true`
(TM-309, merged + deployed). `web/src/assets/auth.js` sets
`auth.settings.appVerificationDisabledForTesting = true` **only when both** hold:

1. **Requested** — `window.__TM_E2E_PHONE_TEST__ === true` (or `TEAMMARHABA_CONFIG.phoneTestMode`).
2. **Context-safe** — the Auth emulator is wired in **or** we're inside the native Capacitor shell
   (`window.Capacitor.isNativePlatform() === true`). Inside this app, condition 2 is **automatic**.

So the flow only needs condition 1, and the flag must be `true` **before `auth.js` evaluates** — it's
read once at module load.

**Why pure Maestro can't set it:** Maestro's `runScript`/`evalScript` run in Maestro's **own** JS
sandbox, not inside the app's WebView, so they cannot set a `window` global the SPA reads. There is
also **no deep link or URL query param** the app honours for this — `server.url` is fixed in
`capacitor.config.json` and the SPA reads the flag from `window`, not the URL. So pure Maestro alone
**cannot** establish condition 1.

**Chosen mechanism — harness pre-injection over CDP (the TM-302 contract these flows assume):**
before a flow runs, the **TM-302 e2e harness** attaches to the app's WebView via the Chrome DevTools
Protocol and runs `Page.addScriptToEvaluateOnNewDocument` with:

```js
window.__TM_E2E_PHONE_TEST__ = true;
```

so the global is present on **every document before any SPA script** (including `auth.js`) runs. This
requires a **debug** build (`WebView.setWebContentsDebuggingEnabled(true)` is on for debug, off for
release), so the flag is **unreachable in production**. The harness then hands off to Maestro to drive
the UI. `login-sms.yaml` is written so a **missing** pre-injection fails **loud** — the reCAPTCHA gate
fires, the "Text a code" step never appears, and the `assertVisible: { id: "sms-step-code" }` step
times out — rather than hanging silently.

> If you run `login-sms.yaml` **without** the TM-302 harness having pre-injected the flag, expect a
> reCAPTCHA challenge / timeout. That is the contract these flows assume, not a flow bug.

## Dependencies

- **TM-309** — the gated phone-auth e2e hook (`__TM_E2E_PHONE_TEST__`). Merged + deployed.
- **TM-302** — the e2e harness that pre-injects the flag over CDP (the contract `login-sms.yaml`,
  `warm-restart.yaml`, `camera.yaml`, `biometric.yaml`, `permissions.yaml` assume).
- **TM-312** — the fixed-code test-email hook for `login-email.yaml` (Gmail-read interim until then).

## Best-effort native flows — device prerequisites

- **camera** — a generic emulator has no real camera image; the flow asserts the picker/permission UI
  appears but does not complete a capture.
- **biometric** — needs an enrolled fingerprint to fully complete the BiometricPrompt; on an emulator:
  `adb -e emu finger touch 1` after the prompt shows.
- **permissions** — the push (POST_NOTIFICATIONS) dialog only appears on **API 33+**; on older API
  levels it's auto-granted at install (no dialog). The flow guards these with `optional: true` so it
  never hard-fails on absent or locale-different OS chrome.
