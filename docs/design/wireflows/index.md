# Wireflows — core user journeys (TM-377)

Low-fidelity **wireflows** (storyboards: wireframe screens + flow arrows) for the app's three
core journeys, so build tickets share one picture of the screens and transitions before code.

| Journey | Wireflow | Source | Frames |
| --- | --- | --- | --- |
| 1 · Auth & onboarding | [`auth.md`](./auth.md) / ![png](./auth.png) | [`auth.html`](./auth.html) | 7 |
| 2 · 1:1 messaging (per [TM-376]) | [`messaging.md`](./messaging.md) / ![png](./messaging.png) | [`messaging.html`](./messaging.html) | 7 |
| 3 · Events & meetups | [`events.md`](./events.md) / ![png](./events.png) | [`events.html`](./events.html) | 6 |

Reading them: **arrow label** = the user action that advances the flow · **sticky note** =
key error/edge state, annotated inline (no full alternate flows at this stage) · **hand-drawn
ring** = the tap target on that screen.

## Why these look exactly like the app (the owner requirement)

The frames are not drawn in a generic wireframe style — each journey is an HTML page that
**renders with the app's shipped Sketch theme assets**:

1. Every page sets `data-theme="sketch"` on `<html>` and links the app's real stylesheet,
   **unmodified**: `web/src/assets/styles.css`. That activates the shipped Sketch token block
   (`[data-theme="sketch"]`, `styles.css` lines 762–921): the graphite-on-paper palette, 2px
   pencil borders, irregular hand-drawn radii, flat pencil-offset shadows, and the ruled
   graph-paper grid (`[data-theme="sketch"] body`, lines 832–845).
2. The hand-drawn edge is the app's own `#wobble-soft` SVG filter
   (`feTurbulence` + `feDisplacementMap`), copied **verbatim** from `web/src/index.html`
   lines 25–30 into each page, so `filter: url(#wobble-soft)` displaces edges exactly as live.
3. The typography is the same web-font load as the app shell (`web/src/index.html` line 16):
   Patrick Hand (body), Gochi Hand (headings/buttons), Shadows Into Light (handwritten
   accents — used here for the annotations, via the app's own `.tagline` rule).
4. Screens reuse the app's real component classes wherever they exist (`.auth-card`, `.field`,
   `.auth button`, `.app-nav`, `.tm-btn`, `.tm-badge`, `.tm-dialog`/`.tm-modal`, `.store-badge`,
   `.build-info`), so those pieces are pixel-for-pixel the shipped components. Storyboard-only
   primitives (phone frame, arrows, stickies, chat bubbles, list rows) live in
   [`wireflow.css`](./wireflow.css) and are **layout-only**: every colour/border/radius/shadow
   in them reads the theme tokens via `var(--token)` and reuses `url(#wobble-soft)` — the same
   discipline the app's components follow. Nothing visual is hard-coded or re-invented.

Change the app's Sketch theme and a re-render changes these storyboards with it.

## Re-rendering the PNGs

From the repo root (needs Google Chrome; network access for the Google-Fonts load — offline it
degrades to system faces exactly as the app does):

```sh
./docs/design/wireflows/render.sh
```

Or open any `*.html` in a browser. The pages are static — no server, no JS.

## Out of scope (per the ticket)

Hi-fi visual design, interactive/clickable prototypes, final copy, and full alternate/error
flows (edge states are annotated inline on the affected frame instead).

[TM-376]: https://10xai.atlassian.net/browse/TM-376
