# PROFILE-AGENT — lane playbook

Lane: profile hub / edit form / completion gate / interests picker / avatar / identity.
Written after sprint **wave-profile-1** (sprint 872, 2026-07-18: TM-877/880/884 edit fields,
TM-883 names, TM-882 membership row, TM-881/846 strength+avatar, TM-885/886 shell, TM-860
interests scroll, TM-898/899/900/901 review-finding fixes).
Cross-lane sprint mechanics live in [CROSS-AGENT.md](CROSS-AGENT.md) — read that first on a new sprint.

## Architecture contracts (post wave-profile-1)

`web/src/assets/profile.js` is the lane's **hot file** (~1,100 lines) — 11 of this sprint's 14
tickets touched it. Same-file tickets are built in serial batches, never fanned out (see
CROSS-AGENT → hot-file sprints). The contracts:

- **The completion gate is a route, not a form state.** `router.js` `isOnboarded` =
  `onboardingCompleted && !needsPhoneNumber(profile)` (router.js:1041) — ANY signed-in account
  without a parseable stored E.164 phone is re-routed to `#/onboarding` on every navigation,
  existing accounts included, and the gate **deliberately hides the tab bar**
  (tabbar-core.js:66). A "profile has no bottom nav" report is almost certainly the gate
  screen — reproduce before "fixing" (that was TM-885). `needsPhoneNumber(null)` fails OPEN
  (degraded /me must not lock users out) — pinned by `web/tools/profile-regate-core.test.mjs`.
- **The gate endpoint validates like the edit form.** `POST /api/v1/me/onboarding` enforces
  NAME_LIKE on name+location and the allowed-cities list (`OnboardingRequest`), and the backend
  refuses onboarding-complete without an E.164 phone (`UserService.requirePhoneOnRecord`). It
  re-submits freely: displayName/city/age/phone overwrite, but **explicit first/last names are
  never overwritten** — the TM-883 seed fires only when BOTH are unset (UserService
  `seedNames`). Don't "fix" the seed guard into an overwrite.
- **City:** allowed list = London / Milton Keynes / Sharjah / Karachi (admin-managed list is
  TM-878 — don't hardcode more). A SAVED off-list city ("Dubai") round-trips untouched via the
  trimmed `Objects.equals` change-guard in `UserService.updateProfile`; only NEW off-list values
  400. `fillCitySelect` injects the saved value as an option client-side. `cityCountryHint`
  (countries.js) must map every list city or the phone picker's soft default silently breaks.
- **Age:** 18–99 for NEW values; existing out-of-band values are grandfathered — the client
  **deliberately omits an unchanged age from the PATCH** (profile.js `collectPatch`) and the
  service band-checks only behind the unchanged-guard. Don't "fix" the omission.
- **Identity header prefers firstName/lastName over displayName** (`identitySummary`,
  profile-core.js) — pinned by tests. `paintHub()` is the single painter of the header +
  strength card; repaint goes through it, not ad-hoc DOM pokes.
- **Avatar changes broadcast** via `avatar-events.js` — upload success announces once and nav
  avatar, control preview, identity header and strength % all subscribe (module-level, once —
  NOT per `buildShell`, or route remounts stack listeners). A new avatar surface subscribes; it
  does not poll `photoURL`.
- **The interests picker repaints in place** (`openInterestPicker` → `refreshPicker`): a chip
  tap flips that chip's class/`aria-pressed`, the count, at-max disabling and the error/Save
  pair — it must NEVER `clear()`/rebuild the body. Mobile engines clamp the scroll container to
  0 on rebuild (desktop Chromium does not — you cannot see this bug locally). Pinned by the
  DOM-identity test `web/tools/profile-interest-picker-inplace.test.mjs`.
- **The shell brand block is router-driven** (`shell-brand-core.js` `SELF_HEADED_ROUTES`:
  profile, public profile, onboarding, terms) — hide/show via the router's `updateShellBrand`,
  never per-screen CSS. The old `:has()` login-only scoping was exactly the TM-886 leak.
- **Strength-prompt jumps go through `focusOnPage(id)`** with the `profile-<key>` field ids —
  the one door for "take me to that field" (menu rows, interests CTA, strength gaps all use it).

## Gotchas that cost us real time

- **Making phone mandatory broke every account-provisioning path** — 6 e2e/seed specs plus a
  sibling PR's 4 new tests (CI red on #586 post-rebase). The sequence is now
  `PATCH /me {"phone":"+44…"}` → onboarding-complete → accept-terms (`web/e2e/global-setup.mjs`
  is the reference). Any new spec/script that provisions an account must do the same.
- **The interests scroll bug never reproduces in desktop Chromium** (TM-865 documented it;
  TM-860 fixed it). Assert DOM identity (same child nodes after toggle, no `clear()`), not
  `scrollTop` — the real-device check belongs to the manual gate.
- **A "shell bug" report can be two different non-bugs**: wave-profile-1's missing-tab-bar was
  the phone gate working as designed, and the brand/splash "leak" was the walking-skeleton brand
  block scoped off only the login route. Reproduce-first on every entry path (warm tab, cold
  deep link, login-return, re-gate) before writing a fix.
- **CI evidence can lie by duplication**: the golden-path "interests" step-shot was
  byte-identical to the terms-gate shot in BOTH projects — the capture fired after the picker
  closed (TM-903). md5-check consecutive step-shots when harvesting gate evidence.
- **Onboarding's id-scoped CSS out-specified the TM-781 phone picker** and crushed the gate's
  national-number input to a sliver — watch selector specificity when a shared component mounts
  inside an id-scoped screen (fix lives in styles.css, #587).
- **Dev CORS allows only `:8081`** — before/after captures serve each side on 8081 in turn (no
  parallel before+after servers).

## Testing this lane

- **Harness:** `web/e2e/serve.mjs` + `global-setup.mjs` (seeded ADMIN + fresh email-code user,
  now with the phone PATCH), Node 20 only (system Node hangs Playwright), ≥4s boot-splash settle
  before capturing, everything on :8081.
- **Fail-before proof by source-stash:** run the new test with `web/src` (or the single file)
  swapped to origin/main, show red, swap back, show green — batches B/C/D all proved their
  regressions this way, and batch C proved a router-term neuter turns the re-gate e2e red.
- **Key suites:** unit `profile-core`/`profile-interest-picker-inplace`/`profile-regate-core`/
  `shell-brand-core`/`profile-nudge-underline-a11y` (PR gate); e2e `profile-shell.spec.mjs`
  (tab bar + brand + splash per route), `profile-regate.spec.mjs` (control half + cleared-phone
  re-gate, seams via pg), `profile-edit`, `onboarding-gate`, `tm830-interests-modal-scroll`.
  Backend hub = `MeControllerIntegrationTest` (55+ tests); migration tests execute the shipped
  classpath SQL. Local Testcontainers needs
  `TESTCONTAINERS_RYUK_DISABLED=true ./mvnw verify -DargLine="-Dapi.version=1.44"`.
- **Per-ticket capture scripts are committed** (`web/e2e/capture-tm*.mjs`) — reuse them for
  before/after evidence instead of hand-driving; they encode the provisioning + settle rules.

## Lane map (as of sprint close)

- **Shipped (all merged + deployed, rev 0b2cd5b):** TM-877/880/884 (#587), TM-883 (#586),
  TM-882 (#585), TM-881+846 (#590), TM-885+886 (#591), TM-860 (#592, absorbed dup TM-865),
  TM-899+901 (#594), TM-898+900 (#595). TM-836 (picker Save-unreachable) shipped pre-sprint.
- **Groomed follow-ups (backlog):** TM-902 — two product decisions, undecided: seeded-name
  rename at the gate doesn't reach the identity header, and the legacy-bare-phone +
  out-of-band-age gate lockout. TM-903 — golden-path duplicate step-shot. TM-886 flagged a
  design follow-up: the brand block still shows on Home/Events/Chat/admin (deliberate;
  retiring it is a one-line `SELF_HEADED_ROUTES` addition).
- **Parked (do NOT start as-is):** TM-879 — the profile IA reorg (grouped/collapsible sections)
  is an 8-pt spike with no fixed AC and it holds the profile.js hot file hostage for a whole
  sprint; decompose-first, design-led. TM-878 — admin-managed city list (wave-admin-location-1,
  another lane); until it lands the 4-city list stays hardcoded in BOTH profile.js and
  OnboardingRequest/UserService.
- **Known discrepancies:** the public-profile preview still shows the glyph, not the photo
  (pre-existing, out of #590's scope — unticketed as of close). The strength nudge names at most
  the FIRST TWO gaps (profile-core copy rule) — later gaps become tappable as earlier ones fill;
  widening it is a product call.
