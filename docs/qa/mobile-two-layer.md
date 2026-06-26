# Two-layer mobile testing process

How we manually test the Capacitor / Android app: **emulator first** for fast iteration, **physical
device** for final sign-off. This is the mobile counterpart to the browser-based
[`MANUAL-WALKTHROUGHS.md`](./MANUAL-WALKTHROUGHS.md) — same spirit (hand-run scripts for review
sign-off), but for the native shell.

The native shell is a thin Kotlin WebView wrapper around the hosted web UI (TM-231); see
[`android/README.md`](../../android/README.md) for build/sign/distribute and
[`docs/agents/webview-auth-contract.md`](../agents/webview-auth-contract.md) for the auth contract
the shell must satisfy.

## The two layers

| | Layer 1 — Emulator | Layer 2 — Physical device |
| --- | --- | --- |
| **For** | Fast iteration: smoke every feature after each fix/deploy | Final sign-off on real hardware before closing a QA gate |
| **Cost** | Cheap, repeatable, no phone needed (runs on the Mac) | Needs a real phone + a person holding it |
| **Confidence** | "Verified on emulator" | "Signed off on device" |
| **Covers** | Logic, layout, theme, most native capabilities (simulated) | What an emulator can't fully represent (see below) |

A fix is **"verified on emulator"** at Layer 1. The **close gate (TM-288) still requires Layer 2** —
a final pass on a physical device before a QA gate is closed. Layer 1 is necessary but not
sufficient; Layer 2 is the gate.

## Layer 1 — Emulator setup runbook (macOS, Apple Silicon / arm64)

Prereqs: Homebrew + a JDK (we have Java 21).

```bash
# 1. Android command-line tools
brew install --cask android-commandlinetools

# 2. SDK root + packages (Google-Play image required for push/FCM; arm64 for Apple Silicon)
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "emulator" \
  "system-images;android-34;google_apis_playstore;arm64-v8a"

# 3. Create the AVD
echo no | avdmanager create avd -n teammarhaba \
  -k "system-images;android-34;google_apis_playstore;arm64-v8a" -d pixel_7

# 4. Boot it
"$ANDROID_HOME/emulator/emulator" -avd teammarhaba -no-snapshot-load &

# 5. Install the APK (once booted)
"$ANDROID_HOME/platform-tools/adb" wait-for-device
"$ANDROID_HOME/platform-tools/adb" install -r ~/Documents/teammarhaba-apk/app-release.apk
```

Notes:

- The **`google_apis_playstore`** image is required — push/FCM only works on a Google-Play system
  image. A plain `google_apis` image will not deliver notifications.
- **`arm64-v8a`** matches Apple Silicon; an `x86_64` image would run under emulation and be slow.
- AVD name `teammarhaba`, device profile `pixel_7`, API 34 — keep these stable so evidence and CI
  (TM-302) refer to the same target.

## What's testable on the emulator (+ how)

| Feature | Emulator? | How |
| --- | --- | --- |
| Camera | ✅ (simulated) | The emulator's virtual / host-webcam camera |
| Biometric | ✅ | Enroll a fingerprint, then **Extended controls (···) → Fingerprint → Touch sensor** to simulate the scan. (CLI equivalent: `adb emu finger touch <id>`.) |
| GPS | ✅ | **Extended controls → Location** to set coordinates. (CLI equivalent: `adb emu geo fix <lon> <lat>`.) |
| Push / FCM | ✅ | **Only** on a Google-Play system image (see setup above) |
| Splash / layout / theme / diagnostics | ✅ | Normal — just run the app |

## Layer-2-only (physical device)

Some things the emulator can simulate but never fully represent. Confirm these on a real phone
before a TM-288 sign-off:

- **Real camera** — actual image quality, focus, lighting, and the real OS camera permission UX.
- **Real fingerprint hardware** — a genuine sensor, not a simulated touch.
- **Real notch / safe-area** — true cutout and insets rendering on real hardware.
- **Real push delivery latency** — actual end-to-end FCM delivery timing over the network, not a
  local simulation.

## Runtime debugging — DEBUG apk + Chrome DevTools Protocol (CDP)

The shell is a WebView, so the app's logic, console, and network all live in a remotely-inspectable
web page. This is how we root-caused the login bugs (e.g. TM-307: sign-in succeeded but the app
stayed on the login card with `location.hash === ""`).

1. Install a **DEBUG** apk (WebView debugging enabled).
2. Forward the WebView's DevTools socket to localhost:

   ```bash
   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   # discover the socket name with:  adb shell cat /proc/net/unix | grep webview_devtools
   ```

3. Drive the page over the **Chrome DevTools Protocol** — connect a Node script to the CDP
   WebSocket (Node's global `WebSocket`) at `http://localhost:9222/json` to:
   - read **console** logs and **network** requests/responses live,
   - `Runtime.evaluate` against the live page to inspect state (e.g. `location.hash`,
     auth storage, whether a reCAPTCHA `bframe` is present).

This is how the SMS-path reCAPTCHA escalation was diagnosed (zero captcha frames after the TM-309
hook vs. an image puzzle before) and how cold-login / warm-restart were confirmed by reading
`location.hash` directly.

## Test credentials

| Path | Credential | Notes |
| --- | --- | --- |
| Email code | `basit@10xai.co.uk` | "Email me a code", read the 6-digit code from the inbox. Fully automatable on Layer 1. |
| SMS / phone | `+16505550100` → fixed code `123456` | Firebase **test phone number** (registered, TM-241). Bypasses the real SMS send. |

### SMS path needs the e2e hook (TM-309)

Firebase test phone numbers bypass the SMS send but **not** the reCAPTCHA gate. In a scripted
emulator WebView the session scores as bot-like, so reCAPTCHA serves an interactive image puzzle
instead of passing silently. To drive SMS on Layer 1 without a human solving a captcha, the build
sets `auth.settings.appVerificationDisabledForTesting = true`, gated behind the injected e2e flag
**`window.__TM_E2E_PHONE_TEST__`** (TM-309) — honoured because we run inside the native Capacitor
shell. With the hook active, `+16505550100` + `123456` signs in with no captcha and no real SMS.

> The hook is **test-only** and gated — not a production change. On a real device (Layer 2)
> reCAPTCHA passes silently for a legitimate device, so the hook isn't needed for device sign-off.

A planned **test-email hook (TM-312)** will give the email-code path the same kind of deterministic
test fixture.

## CI automation

The manual Layer-1 process is being automated:

- **TM-302** — the emulator-e2e GitHub Actions workflow (boots the AVD in CI and runs the flows).
- **TM-314** — the Maestro flows driving the login + smoke paths.

Manual Layer 1 stays useful for exploratory testing and new paths; Layer 2 (physical device)
remains a human sign-off gate.
