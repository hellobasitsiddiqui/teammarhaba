# web

The TeamMarhaba web front end (single-page app). Built and deployed as static
assets to Firebase Hosting, and also shipped as a self-contained nginx container
(the same bundle the WebView wrapper reuses).

## Layout

- `src/` — the static one-page app (`index.html` + `assets/`).
- `tools/` — build tooling: `fingerprint.mjs` content-hashes the built assets (TM-144), run by the
  deploy/preview workflows. `node --test web/tools/*.test.mjs` covers it on the PR gate.
- `nginx.conf` — runtime server config: SPA fallback (`try_files … /index.html`)
  and caching headers.
- `Dockerfile` — multi-stage build: assembles `src/` into `/dist` (the documented
  build seam for a real bundler later), then serves it from `nginx:1.27-alpine`.

## Caching & cache-busting (TM-144)

The deploy (`.github/workflows/deploy.yml` → Firebase Hosting) copies `src/ → dist/`, injects the
backend URL + build SHA into `config.js`, then runs `node tools/fingerprint.mjs web/dist`. That
content-hashes every `assets/*.{js,css}` to `name.<hash>.ext`, rewriting both `index.html` and the
ES-module import specifiers — **transitively**, so changing one module busts everything that imports it.

`firebase.json` then serves:

- `index.html` (and any non-asset path) `Cache-Control: no-cache` — always revalidated, so it always
  points at the newest hashed assets;
- `/assets/**` `public, max-age=31536000, immutable` — safe to cache forever, because the URL changes
  whenever the content does.

Net effect: after a deploy a returning user gets the new CSS/JS on a **normal** reload — no hard
refresh (TM-144). `index.html` stays unhashed (it's the entry). The e2e harness serves `src/` directly,
so it's unaffected. (Follow-up: the nginx container path still serves stable URLs — fingerprint it too
if the WebView bundle needs the same guarantee.)

## Build & run

```bash
# from web/
docker build -t teammarhaba-web .
docker run --rm -p 8080:8080 teammarhaba-web
# open http://localhost:8080
```

The container listens on port **8080**. Deep links / hard refreshes on a
sub-path fall back to `index.html` (SPA routing).

## Auth (TM-105)

Firebase Auth is initialised by `src/assets/auth.js` (ES module, Firebase JS SDK from the
gstatic CDN — no bundler). It exposes `getIdToken()`, `onAuthChanged()`, and `currentUser`
(also mirrored on `window.tmAuth` for the framework-free page). The public web config lives
in `src/assets/firebase-config.js` (the Firebase web `apiKey` is a public project identifier,
not a secret — see `/.gitleaks.toml`). The sign-in UI (TM-106) and Bearer-token wiring
(TM-108) build on this.

## Doodle asset pack (TM-214)

`src/assets/doodles.js` is a small pack of hand-drawn, MVP-rough **SVG line-art doodles** for the
**`doodle` theme** (TM-213). Motifs are social-events only — people meeting at events (dates, RSVPs,
places, a crowd, a hello wave, a celebration). They decorate doodle-theme **headers**, **empty states**
(e.g. "no events yet") and **dividers**. They are **visual only**; TM-215 wires them into pages.

Properties:

- **Themeable** — every doodle uses `stroke="currentColor"` + `fill="none"` (solids use
  `currentColor`), so it inks with the TM-210/211 tokens (`var(--fg)`) wherever it's mounted and flips
  with the doodle dark variant. No hardcoded colours.
- **XSS-safe** — built from a namespaced element factory (attributes + a single static `<text>` via
  `textContent`); no innerHTML, no user data. Every doodle is static inline SVG.
- **Doodle-theme-only** — mount under `[data-theme="doodle"]`; the pack adds **nothing** to `clean`.
- **No owls / mascots / animals.**

Motifs: `calendar` · `ticket` (RSVP) · `pin` (location/map) · `crowd` (group of people) · `chat`
(speech bubble) · `hello` (waving hand) · `celebrate` (confetti popper) · `clock` (time) · `host`
(host badge) · `divider` (squiggle, optional `hello!` tag).

Usage (framework-free, mirrors the `el()` kit in `ui.js`):

```js
import { doodles, doodle, doodleNames } from "./doodles.js";

// by name (data-driven), with the header size variant:
header.append(doodle("calendar", { size: 56, class: "tm-doodle-header" }));

// or call the builder directly — empty-state hero with an accessible label:
emptyState.prepend(doodles.crowd({ class: "tm-doodle-empty", title: "No events yet" }));

// a full-width divider between sections:
section.after(doodles.divider({ class: "tm-doodle-divider", tag: true }));
```

Each builder returns a fresh detached `<svg>` element. Options: `size` (px), `title` (adds `<title>`
+ `role="img"`/`aria-label`; omit → `aria-hidden` decorative), `class` (extra classes appended after
`tm-doodle`), `wobble:true` (adds `tm-wobble-soft` to pick up the theme's hand-drawn jitter filter).
Sizing/spacing classes (`.tm-doodle`, `.tm-doodle-header`, `.tm-doodle-empty`, `.tm-doodle-divider`)
live under `[data-theme="doodle"]` in `styles.css`.

## Deploy

Merges to `main` deploy this app to Firebase Hosting (live channel) via
`.github/workflows/deploy.yml`. See `infra/gcp/firebase-hosting.md` for the
build seam, keyless auth, and rollback.

## Out of scope (later tickets)

- The native WebView wrapper (surface epic)
- A real JS bundler / framework
