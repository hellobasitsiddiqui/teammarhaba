# Design tokens — the single source of truth

The TeamMarhaba UI is driven by one authoritative set of **CSS custom properties** defined in
[`web/src/assets/styles.css`](../../web/src/assets/styles.css). This is the design system's source of
truth: every screen and the shared component library read these tokens via `var(--token)` and **never**
hard-code a colour, spacing or type value. A theme family (`clean`, `doodle`, `sketch`) is therefore a
pure token swap — no per-component edits — and the `doodle` + `sketch` wireframe families resolve their
neutrals from the same ramp documented here (see "How the themes resolve" below).

Reconciled (TM-510) against the approved wireframe kit — the TM-377 storyboards in
[`docs/design/wireflows/`](wireflows/) and `blunt.css` — plus the shipped theme contract
(TM-210 / TM-211 / TM-236 / TM-323).

## Two tiers

1. **Primitives** — raw palette / spacing / type values, defined once on `:root`. Not read directly by
   components (except plain white/ink chrome); the semantic tokens alias them.
2. **Semantic tokens** — meaning-named tokens (`--fg`, `--surface`, `--accent`, …) that components read.
   `clean` is the base `:root` contract; `doodle` and `sketch` override the semantic tokens in a
   `[data-theme="…"]` block (and its dark variant), aliasing the primitive ramp where they can.

---

## Primitive tokens (`:root`)

### Neutral / ink ramp — grayscale, lightest → darkest (the wireframe-kit palette)

| Token | Value | Usage |
| --- | --- | --- |
| `--white` | `#ffffff` | Pure white — always-white chrome (toggle thumbs, crisp cards). |
| `--g1` | `#fafafa` | Off-white paper — the lightest surface (sketch `--page-bg` / `--surface`). |
| `--g2` | `#f0f0f0` | Faint raised surface / hairline fill (sketch `--surface-2`). |
| `--g3` | `#e0e0e0` | Dividers, disabled fills. |
| `--g4` | `#c4c4c4` | Placeholder ink, faint strokes. |
| `--g5` | `#6a6a6a` | Muted / secondary text (sketch `--muted`). |
| `--g6` | `#3a3a3a` | Strong secondary ink. |
| `--ink` | `#2b2b2b` | Graphite pencil ink — the kit's primary "colour" (sketch `--fg` / `--accent`). |

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
| `--font-sans` | system stack (Inter/system) | Body face. `doodle`/`sketch` swap in Patrick Hand. |
| `--font-display` | `= --font-sans` (clean) | Headings + buttons. `doodle`/`sketch` swap in Gochi Hand. |
| `--font-accent` | `= --font-sans` (clean) | Taglines / script accents. `doodle`/`sketch` swap in Shadows Into Light. |
| `--fs-1` … `--fs-6` | `0.75` / `0.875` / `1` / `1.25` / `1.5` / `2rem` | Size steps: meta → page heading. |
| `--fs-hero` | `2.5rem` | Landing wordmark (`.app h1`). |

---

## Semantic tokens (`:root` = `clean`)

| Token | Value (clean) | Usage |
| --- | --- | --- |
| `--fg` | `#1a1a2e` | Foreground text/icons. |
| `--accent` | `#0f9d8c` | Primary/brand fills, links, focus rings. |
| `--accent-light` | `color-mix(--accent 45%, --white)` | Lightened accent for soft fills / hovers. |
| `--on-accent` | `#fff` | Text/icons on an `--accent` fill. |
| `--page-bg` | `#f6f7fb` | Page background. |
| `--surface` | `#ffffff` | Panels / raised surfaces (darkens in dark mode). |
| `--surface-2` | `#f1f2f8` | Secondary surface. |
| `--surface-card` | `#fff` | Auth/onboarding card + input chrome. |
| `--muted` | `rgba(26,26,46,.6)` | Secondary text. |
| `--border` / `--border-width` | `rgba(26,26,46,.12)` / `1px` | Hairline colour + weight. |
| `--fg-line*` / `--accent-line` / `--accent-soft` | `color-mix(...)` | Derived border / wash tints that track the theme. |
| `--danger` / `--success` | `#b00020` / `#0a7d57` | Status colours. |
| `--radius-sm/-md/-/-lg/-pill` | `6/10/8/12/999px` | Corner scale (themes reshape all at once). |
| `--shadow-sm/-md/-lg/-menu` | drop-shadow ramp | Elevation. |
| `--shadow-card` | `0 6px 24px rgba(0,0,0,.06)` | Soft raised-card ambient (onboarding / help / diagnostics cards). |
| `--overlay` / `--overlay-strong` | `rgba(0,0,0,.45/.55)` | Modal backdrop / tour spotlight dim. |

The **wobble filter** — `filter: url(#wobble-soft)` — is the shared hand-drawn edge for the wireframe
themes. Its `feTurbulence` + `feDisplacementMap` def ships in
[`web/src/index.html`](../../web/src/index.html); it is decorative only and dropped under
`prefers-reduced-motion`.

---

## How the themes resolve

- **`clean`** — no override block; it *is* the base `:root` contract (coloured teal/navy palette).
- **`sketch`** (default, TM-323) — a `[data-theme="sketch"]` block re-points the semantic tokens onto the
  neutral ramp: `--fg: var(--ink)`, `--surface: var(--g1)`, `--surface-2: var(--g2)`,
  `--surface-card: var(--white)`, `--muted: var(--g5)`, plus hand faces via `--font-display` /
  `--font-accent`. So the whole app restyles from the single ramp with no per-component edits.
- **`doodle`** — same mechanism, a warm-paper variant of the wireframe language (its own paper tints;
  same `--font-display` / `--font-accent` faces).

Each family also defines a dark variant under `@media (prefers-color-scheme: dark)`.

## Rules

- Components read **semantic** tokens via `var()` — never a raw hex/px, and not the primitive ramp
  directly (bar `--white` / `--ink` for genuinely fixed chrome).
- Add a new theme = add a `[data-theme="<name>"]` block overriding only the tokens it changes + register
  the name in [`web/src/assets/theme.js`](../../web/src/assets/theme.js). No component edits.
- Guarded by [`web/tools/theme-tokens.test.mjs`](../../web/tools/theme-tokens.test.mjs) (runs in CI via
  `node --test web/tools/*.test.mjs`).
