# LOGIN-AGENT — lane playbook

Lane: sign-in / login screen / OTP code entry / social login / auth identity.
Written after sprint **wave-login-1** (TM-867 six-box OTP + TM-866 resend cooldown; 2026-07-18).
Cross-lane sprint mechanics live in [CROSS-AGENT.md](CROSS-AGENT.md) — read that first on a new sprint.

## Architecture contracts on the code-entry screen (post-TM-867/866)

The login screen is NOT a plain form anymore. Before touching it, read `web/src/assets/login.js`
top to bottom — then honour these contracts:

- **Auto-submit contract.** Filling the six-box OTP (`otp-input.js` + `otp-input-core.js`) with a
  full code auto-invokes the verify action. **Nothing may click `#emailcode-verify-btn`** — not
  specs, not standalone capture scripts. `web/tools/e2e-hygiene.test.mjs` enforces this repo-wide;
  if it goes red you added a stale click.
- **`onComplete` fires on ANY input that leaves all six boxes filled** — not just the transition
  into complete. A caller that keeps a rejected code in the boxes gets a mixed old/new submit on
  the first correcting keystroke. That is why `run()`'s catch **clears the widget on a failed
  verify** (standard OTP recovery: clear + refocus box 1). Keep that invariant.
- **`run()` / `makeSingleFlight` is the only door to verify/send actions.** Auto-submit, buttons,
  and future paths (TM-407 autofill via `setValue()`) all go through it. Never add a second path.
- **`setBusy(false)` re-enables every control in `controls()`.** Any state that holds a button
  disabled across the busy window (the resend cooldown does) must re-assert itself after busy
  closes (`syncDisabled` pattern in `resend-cooldown.js`). A new held control that skips this will
  flicker-enable.
- **Focus is deferred, never direct.** Inside the busy window inputs are disabled and `focus()`
  silently no-ops (disabled elements are unfocusable). Queue focus via `requestFocus()` /
  `pendingFocus`; it is applied in `run()`'s `finally` after `setBusy(false)`.
- **Core/DOM split.** Pure logic lives in `*-core.js` (unit-tested in `web/tools/`, injected
  clock/timestamps, no DOM); DOM wiring in the sibling module. Follow it for anything new.

## Gotchas that cost us real time

- **Eastern Arabic digits.** Arabic-locale keypads emit ٠١٢٣٤٥٦٧٨٩ / ۰-۹. `sanitizeDigits`
  normalises them to ASCII before the digit filter — without it every keystroke silently vanishes
  for the Saudi user base. Any new numeric input on this screen needs the same normalisation.
- **Gochi Hand has no `tnum`.** `font-variant-numeric: tabular-nums` is inert in the display font
  (its only GSUB feature is `liga`). A ticking label ("Resend in 0:29") therefore changes width
  every second → reflow/wrap-flip at 390px. Fix = reserve the width up front (`reserveWidth()` in
  `resend-cooldown.js`), release on expiry. Applies to ANY per-second text in the paper theme.
- **Select-on-focus is collapsed by the click's mouseup** in Chrome/Safari — typing into a filled
  box INSERTS beside the old digit instead of replacing. The widget re-selects on `pointerup` AND
  treats a 2-char value as replace-in-place. Don't simplify either away.
- **Client cooldown ≠ server cooldown.** The server email send-cooldown is **60s**
  (`application.yml` `send-cooldown`, enforced in `EmailCodeService`); the client countdown is
  30s — the t=30–60 gap 429s (tracked: TM-895, options = 60s default or `Retry-After` seeding).
  Check the server number before promising anything in the UI.
- **The SMS code step must carry its own resend affordance** (`#sms-resend-btn` "Text me another
  code") — the phone step (and its send button) is hidden the whole time the code step shows.
  A countdown on a hidden button is not shipped UX. Also: the SMS step still names no destination
  number (tracked: TM-896).

## Testing this lane

- **Cold login on prod is self-serve:** request a code for any 10xai.co.uk-deliverable address and
  read it from the connected Gmail **Sent** folder (codes are sent from basit@10xai.co.uk, so they
  appear in Sent regardless of recipient). File-poll pattern: a background Playwright script polls
  a scratch file for the code while the orchestrator fetches it from Gmail.
- e2e: the emulator-only `peek` endpoint hands specs the code (inert in prod); countdown specs use
  Playwright fake-clock rather than 30s sleeps; sign-in success assert = route/shell state, **not**
  `#signout-btn`, which hides at phone width and on the onboarding gate (a live-QA false-FAIL).
- Unit suites: `web/tools/otp-input-*.test.mjs`, `resend-cooldown-*.test.mjs` run on the PR gate.

## Lane map (as of sprint close)

- **Shipped:** TM-867 (6-box OTP auto-submit), TM-866 (resend cooldown), TM-897 (hygiene + guard).
- **Groomed follow-ups in Refinement:** TM-895 (30/60 cooldown), TM-896 (SMS destination copy),
  TM-685 (inline validation), TM-702 (warm-login flash — no `authStateReady()` gate), TM-375
  (OTP-in-bounce, High), TM-306 (identity dedup, High), TM-407 (OTP autofill — uses the
  `setValue()` seam), TM-661 (host portal, epic-seed).
- **Parked (wave-login-3, do NOT start):** TM-647 Apple + TM-868 Facebook + TM-682 reopened Apple
  stub. Known discrepancy: TM-200/TM-682 are marked Done but only Google OAuth is actually wired —
  consolidate to one canonical Apple ticket when that wave grooms. Apple/Meta console credentials
  are human-only steps.
