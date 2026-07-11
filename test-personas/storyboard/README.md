# Storyboard compositor — the 2×4 phone wall (TM-636 / TM-628)

Proof-of-concept for the persona-simulation **screenshot storyboard**: shoot N screens at a phone
viewport (one per persona/step), then tile them into a **2-rows × 4-cols grid** — "everyone's screen
at the same step" — and screenshot that into one attachable proof PNG (`storyboard-grid.png`).

This first cut renders the committed **design-kit `paper` wireframes** (they render fully offline and
are phone-shaped), so it proves the *compositor + the 2×4 visual* without needing the live stack. The
real lockstep journey — 8 personas driven through the actual app in separate Playwright contexts,
screenshotting real state at each step — lands with **TM-528** (multi-context e2e) + the TM-628 harness.

## Run
```
npm i playwright@1.49.1
npx playwright install chromium
node build-storyboard.mjs
```
Outputs: `panels/panel-1..8.png` (the phone shots), `index.html` (the grid page), `storyboard-grid.png`
(the single proof image).

## Next (TM-628)
- Swap the `paper` file:// screens for **live app screens** driven by the seeded personas (Joe/Sarah/
  Marcus/Priya/Aisha) in separate `newContext()` sessions.
- Drive **lockstep**: advance all personas one step, screenshot each, emit the grid, repeat → a
  sequence of grids = the full storyboard.
- Post the grids to the sprint test ticket via the TM-195 screenshot-evidence pipeline.
