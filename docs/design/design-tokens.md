# Design tokens — the single source of truth

The TeamMarhaba UI is driven by one authoritative set of **CSS custom properties** defined in
[`web/src/assets/styles.css`](../../web/src/assets/styles.css). This is the design system's source of
truth: every screen and the shared component library read these tokens via `var(--token)` and **never**
hard-code a colour, spacing or type value. **Paper is the single theme (TM-529)** — the multi-theme
family system (`clean`/`doodle`/`sketch`) is retired. The only two things a user personalises are token
swaps, applied at runtime with no per-component edits:

- **accent** — one colour, from a **fixed curated palette** (the `--accent-paper-*` swatches), re-points
  `--accent` (and `--on-accent`); and
- **wavy/sketchy** — an on/off toggle on `<html data-sketchy>` that layers the hand-drawn skin (wobble
  filter + ruled-paper grid + irregular corners + doodles) over the same palette.

Reconciled (TM-510) against the approved wireframe kit — the TM-377 storyboards in
[`docs/design/wireflows/`](wireflows/) and `blunt.css` — plus the shipped theme contract
(TM-210 / TM-211 / TM-236 / TM-323), then consolidated to Paper only (TM-529).

## Two tiers

1. **Primitives** — raw palette / spacing / type values, defined once on `:root`. Not read directly by
   components (except plain white/ink chrome); the semantic tokens alias them.
2. **Semantic tokens** — meaning-named tokens (`--fg`, `--surface`, `--accent`, …) that components read.
   Paper is the base `:root` contract (it aliases the primitive ramp); the wavy/sketchy skin adds a
   `[data-sketchy="on"]` layer (irregular radii + grid + wobble), and the per-user accent re-points
   `--accent`/`--on-accent` at runtime. Each has a dark variant under `prefers-color-scheme: dark`.

---

## Primitive tokens (`:root`)

### Neutral / ink ramp — grayscale, lightest → darkest (the wireframe-kit palette)

| Token | Value | Usage |
| --- | --- | --- |
| `--white` | `#ffffff` | Pure white — always-white chrome (toggle thumbs, crisp cards). |
| `--g1` | `#fafafa` | Off-white paper — the lightest surface (Paper `--page-bg` / `--surface`). |
| `--g2` | `#f0f0f0` | Faint raised surface / hairline fill (Paper `--surface-2`). |
| `--g3` | `#e0e0e0` | Dividers, disabled fills. |
| `--g4` | `#c4c4c4` | Placeholder ink, faint strokes. |
| `--g5` | `#6a6a6a` | Muted / secondary text (Paper `--muted`). |
| `--g6` | `#3a3a3a` | Strong secondary ink. |
| `--ink` | `#2b2b2b` | Graphite pencil ink — the kit's primary ink (Paper `--fg`; the coloured `--accent` is per-user). |

### Spacing scale — 4px-based rhythm

| Token | Value | | Token | Value |
| --- | --- | --- | --- | --- |
| `--space-1` | `0.25rem` | | `--space-5` | `1.5rem` |
| `--space-2` | `0.5rem` | | `--space-6` | `2rem` |
| `--space-3` | `0.75rem` | | `--space-7` | `3rem` |
| `--space-4` | `1rem` | | | |

### Type scale

| Token | Value | Usage |
| --- | --- | --- |
| `--font-sans` | Patrick Hand → system | Body face (the Paper hand face; degrades to the system stack). |
| `--font-display` | Gochi Hand → system | Headings + buttons. |
| `--font-accent` | Shadows Into Light → Patrick Hand | Taglines / script accents. |
| `--fs-1` … `--fs-6` | `0.75` / `0.875` / `1` / `1.25` / `1.5` / `2rem` | Size steps: meta → page heading. |
| `--fs-hero` | `2.5rem` | Landing wordmark (`.app h1`). |

---

## Semantic tokens (`:root` = Paper)

| Token | Value (Paper) | Usage |
| --- | --- | --- |
| `--fg` | `var(--ink)` | Foreground text/icons (graphite ink). |
| `--accent` | `var(--accent-paper-teal)` | Primary/brand fills, links, focus rings — the **per-user** colour. |
| `--accent-light` | `color-mix(--accent 45%, --white)` | Lightened accent for soft fills / hovers. |
| `--on-accent` | `#fff` | Text/icons on an `--accent` fill (the picker flips it per swatch). |
| `--page-bg` | `var(--g1)` | Off-white paper page background. |
| `--surface` | `var(--g1)` | Panels / raised surfaces (darkens in dark mode). |
| `--surface-2` | `var(--g2)` | Secondary surface. |
| `--surface-card` | `var(--white)` | Card + input chrome (crisp white so the grid shows through). |
| `--muted` | `var(--g5)` | Secondary text. |
| `--border` / `--border-width` | `color-mix(--fg 72%, transparent)` / `2px` | Inky Paper line colour + weight. |
| `--fg-line*` / `--accent-line` / `--accent-soft` | `color-mix(--fg …)` | Derived inky border / wash tints. |
| `--danger` / `--success` | `#b00020` / `#0a7d57` | Status colours (Paper keeps hue). |
| `--radius-sm/-md/-/-lg/-pill` | `6/10/8/12/999px` | Crisp clean-Paper corners (sketchy swaps in irregular). |
| `--shadow-sm/-md/-lg/-menu` | inky offset ramp (`Npx Npx 0`) | Paper "sketched drop-shadow" elevation. |
| `--shadow-card` | `0 6px 24px rgba(0,0,0,.06)` | Soft raised-card ambient (onboarding / help / diagnostics cards). |
| `--overlay` / `--overlay-strong` | `color-mix(--fg 40/50%)` | Modal backdrop / tour spotlight dim. |

### Curated accent palette (per-user)

The one coloured token, `--accent`, is chosen from a fixed set of swatches (no free colour picker). Each
is defined as a token and mirrored in [`appearance-core.js`](../../web/src/assets/appearance-core.js):

| Swatch token | Value | Id (default first) |
| --- | --- | --- |
| `--accent-paper-teal` | `#0f9d8c` | `teal` — the default (the shipped TM-510 `--accent`) |
| `--accent-paper-indigo` | `#4f46e5` | `indigo` |
| `--accent-paper-coral` | `#d1495b` | `coral` |
| `--accent-paper-amber` | `#b45309` | `amber` |
| `--accent-paper-plum` | `#7c3aed` | `plum` |
| `--accent-paper-ink` | `#2b2b2b` | `ink` |

The **wobble filter** — `filter: url(#wobble-soft)` — is the hand-drawn edge for the **wavy/sketchy**
skin. Its `feTurbulence` + `feDisplacementMap` def ships in
[`web/src/index.html`](../../web/src/index.html); it is decorative only, applied under
`[data-sketchy="on"]`, and dropped under `prefers-reduced-motion`.

---

## How Paper resolves + the two per-user axes

- **Base (`:root`)** — Paper: the semantic tokens alias the neutral ramp (`--fg: var(--ink)`,
  `--surface: var(--g1)`, `--surface-2: var(--g2)`, `--surface-card: var(--white)`, `--muted: var(--g5)`),
  2px inky borders, offset shadows and the hand faces. This alone renders **clean Paper**.
- **Accent (per-user)** — `--accent`/`--on-accent` are re-pointed to the chosen curated swatch at runtime
  (`appearance.js` on boot from a localStorage hint; `appearance-sync.js` from `GET /api/v1/me`, the
  source of truth). Default = `teal`.
- **Wavy/sketchy (per-user)** — `[data-sketchy="on"]` (default ON) layers irregular hand-drawn corners, a
  ruled-paper grid, the doodle decorations, and the wobble filter over the same palette. `off` = clean
  Paper. Persisted per user (`users.theme_sketchy`).

Both per-user axes persist server-side (`PATCH /api/v1/me` → `users.theme_accent` / `users.theme_sketchy`)
and the palette + apply logic live in
[`appearance-core.js`](../../web/src/assets/appearance-core.js).

## Rules

- Components read **semantic** tokens via `var()` — never a raw hex/px, and not the primitive ramp
  directly (bar `--white` / `--ink` for genuinely fixed chrome). Never read/apply appearance yourself —
  inherit `--accent` and `[data-sketchy]`.
- There is **no** second theme to add. Personalisation is the fixed accent palette + the sketchy toggle;
  extend the palette by adding a swatch token here **and** in `appearance-core.js` (guarded so they can't
  drift). Never reintroduce a `data-theme` family.
- Guarded by [`web/tools/theme-tokens.test.mjs`](../../web/tools/theme-tokens.test.mjs) +
  [`web/tools/appearance-core.test.mjs`](../../web/tools/appearance-core.test.mjs) (CI via
  `node --test web/tools/*.test.mjs`).
