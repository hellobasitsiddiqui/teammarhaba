# ADMIN-AGENT — lane playbook

Lane: the admin surface — the five admin consoles (`#/admin/users`, `#/admin/events`,
`#/admin/venues`, `#/admin/interests`, `#/admin/messages`), the admin navigation/chrome (the
role-conditional Admin tab + the `#/admin` hub), and the `wave-admin-*` waves.
Written after sprint **wave-admin-1** (sprint 905; TM-916 Admin tab + TM-917/918 admin hub +
TM-756 stats zero-flash; 2026-07-20). Cross-lane sprint mechanics live in
[CROSS-AGENT.md](CROSS-AGENT.md) — read that first on a new sprint.

## Architecture contracts on the admin layer (post-TM-916/917/918)

The admin area is a **second-level layer** reached from the bottom bar, not a set of loose URLs.
Before touching it, read `tabbar-core.js`, `tabbar.js`, `admin-hub.js`, and the admin block of
`router.js` — then honour these:

- **The four user tabs are LOCKED (TM-434); the Admin tab is separate.** `tabbar-core.js` keeps the
  four in a frozen `TABS`; the Admin tab is a distinct `ADMIN_TAB` composed in by
  `tabsFor({isAdmin})` — **never add it to `TABS`**. `activeTab()` maps every `#/admin*` route →
  `"admin"` (a pure route map, role-independent).
- **The Admin tab is INJECTED, never static.** `tabbar.js` `updateTabbar({signedIn, gated, route,
  isAdmin})` injects `#tab-admin` only for a verified admin and removes it otherwise — so a normal
  user's DOM contains no admin affordance at all. It also sets `nav.dataset.tabs` for the 5-column
  CSS variant `.app-tabbar[data-tabs="5"]`. `isAdmin` **fails safe to false** until the role
  resolves, so no admin tab flashes for a non-admin.
- **`#/admin` is the HUB, not the users console.** `admin-hub.js` (`enterAdminHub` → `#admin-hub-view`)
  renders a paper list of the five consoles; the pure routes + frozen `ADMIN_HUB_ROWS` model live in
  `admin-hub-route.js`. The users console **moved to `#/admin/users`** (`admin.js` `enterAdmin` →
  `#admin-view`). The Admin tab AND the desktop `#nav-admin` link both open the hub; consoles are
  reached from the hub's rows. Landing (TM-141) is unchanged: admins land on `#/admin` = the hub.
- **Every admin route needs TWO gates in `router.js` — miss either and you ship the TM-917
  regression.** (1) Membership in the `PROTECTED` set (auth gate: a signed-out deep-link is
  remembered via `INTENDED_KEY` and bounced to `#/login`), AND (2) a
  `shouldBounceNonAdmin({ isAdmin, roleResolved })` role-bounce clause. `roleResolved`-awareness is
  mandatory (the TM-733 reload race — a bounce reading only `isAdmin` flash-bounces a real admin).
  `router-gate-chain-guard.test.mjs` enforces one bounce per enumerated route; a new admin route
  that skips `PROTECTED` flashes the console to signed-out visitors + raises a spurious "Admins
  only." toast.
- **Per-route lifecycle.** Each admin route owns an entry flag (`adminHubActive`, `adminActive`,
  `adminEventsActive`, …) set on entry / reset on leaving so re-entry re-mounts, plus a
  view-visibility toggle (`view.hidden = route !== ROUTE`). Follow the pattern for anything new.
- **Security is server-side.** Tab visibility, the hub, and the client bounce are all UX-only. The
  real authority is the verified ID-token role claim (TM-110) + backend RBAC (TM-111/TM-133). No
  admin data may load before the gate passes.
- **Pure/DOM split.** Testable logic goes in a pure `*-core.js` / `*-route.js` (unit-tested in
  `web/tools/`); the DOM half imports it. The console DOM modules can't be imported under
  `node --test` (they pull `api.js` → the Firebase CDN chain), so their logic MUST be extracted to
  be unit-tested — e.g. `admin-stats-core.js`, `admin-hub-route.js`.

## Gotchas that cost us real time

- **Reshaping the admin nav = migrate EVERY consumer, including ones with no literal `#/admin`.**
  The `#nav-admin` top-nav link and three specs (`admin-walkthrough`, `admin-suspend-blocks-api`,
  `broadcast-admin`) reach the users console by *clicking the link*, not by a hash literal — so a
  grep for `#/admin` misses them. Grep for `nav-admin` too. (An adversarial review caught this; the
  fix routes those specs through the hub's Users row `.admin-hub-row[href="#/admin/users"]`.)
- **The product tour keys highlights by route.** `tour-highlights.js` / `tours.js`
  (`PAGE_HIGHLIGHTS` / `PAGE_TOURS`) described `#/admin` = the users console (`.tm-stats`, etc.); on
  the move it had to re-key to `#/admin/users`. Move the tour whenever a console's route moves.
- **Don't over-migrate.** Consumers that treat `#/admin` as a *generic route* — deeplink
  `KNOWN_ROUTES` (`push-deeplink.js`), broadcast route options, footer-hide, notification panel,
  `ROUTE_LABELS` — are FINE unchanged, because `#/admin` is still a valid route (now the hub).
- **e2e fixtures import from `../fixtures.mjs`.** `fixtures.mjs` lives in `web/e2e/`, specs in
  `web/e2e/tests/` — `./fixtures.mjs` makes the whole spec fail to load (proving nothing). Every
  other spec uses `../fixtures.mjs`.
- **Admin console stats bars flash all-zero before data (TM-756 bug class).** Every console's
  `renderStats` computes counts from still-empty state on the pre-data render, painting "Total 0 /
  Admins 0 / …" as if real. Route the cards through the pure `statsCards(cards, loading)`
  (`admin-stats-core.js`) → em-dash placeholder while `state.loading`. All four consoles
  (users/events/venues/interests) had it; the table was already loading-gated, the stats path wasn't.

## Testing this lane

- **Admin API access is self-serve on prod.** Email-code login as `basit@10xai.co.uk` (ADMIN):
  `POST /api/v1/auth/email-code/request` → read the 6-digit code from the connected Gmail →
  `POST /api/v1/auth/email-code/verify` → `customToken` → exchange via identitytoolkit
  `signInWithCustomToken` → `idToken` (store in a file, don't print). Use the **direct Cloud Run
  URL** `https://teammarhaba-backend-tllkdjjakq-nw.a.run.app`, NOT the `/api` proxy (the proxy 200s
  the SPA on POST). Full recipe: `teammarhaba-admin-api-connect` memory + the `qa-events` skill.
- **Seed QA events:** the `qa-events` skill (`POST /admin/events`; `startAt` must be strictly > now
  AND > `visibilityStart` or it 400s; obvious "QA … (delete me)" titles; cancel via
  `POST /admin/events/{id}/cancel`). These are LIVE on prod — always label + offer cleanup.
- **Unit suites (Node 20 — `node --test web/tools/*.test.mjs`):** `admin-*.test.mjs`,
  `tabbar-core.test.mjs`, `admin-hub-route.test.mjs`, `router-gate-chain-guard.test.mjs`.
- **e2e (off the PR gate — dispatch `e2e.yml --ref <branch>`, require green before merge):**
  `admin-hub.spec.mjs` (role-visibility: USER sees no admin affordance + is bounced; ADMIN sees the
  tab, hub, and all five consoles with the Admin tab active), `admin-walkthrough`,
  `admin-suspend-blocks-api`, `broadcast-admin`, `admin-events`. The seeded **ADMIN** fixture carries
  the `role=ADMIN` claim (global-setup); the non-admin fixture is **TARGET**.
- **390px evidence harness:** serve `web/src` statically, load a tiny page that imports the REAL
  module (`updateTabbar` / `enterAdminHub` / `statsCards`) + `styles.css` and drives it, then
  screenshot the element at 390×844. Render one shot to check it before attaching (bad evidence gets
  caught this way). Playwright resolves from `web/e2e/node_modules` via `createRequire` under Node 20.

## Lane map (as of wave-admin-1 close, sprint 905)

- **Shipped + DEPLOYED (prod rev `1e2366f`):** TM-916 (role-conditional Admin tab), TM-756 (stats
  zero-flash → loading placeholder), TM-917 (hub at `#/admin`), TM-918 (consumer migration +
  role-visibility e2e), TM-922 (CROSS-AGENT merge-cadence doc).
- **Close-gates (wave-admin-1):** TM-919 (human manual test — assigned to Basit, doable on prod now),
  TM-920 (sprint code-review gate — **NOT yet run**; runs on the merged combined state on main),
  TM-921 (deploy gate — **DONE**: deployed + serving-asserted `1e2366f`).
- **Groomed follow-ups in Refinement:** TM-878 (admin-managed locations catalogue,
  `wave-admin-location-1`, 8sp — supersedes the hardcoded city list from TM-877), TM-832 (interests
  selection analytics, `wave-admin-2`, 3sp — the M/F split is blocked on TM-831 adding a gender
  field), TM-172 (admin edit of another user's profile fields, `wave-admin-2`, 5sp — old blockers
  Done), TM-592 (event capacity + roster + evict, `wave-admin-2`, 5sp — the refund path is cross-lane
  to payments/TM-870), TM-834 (QA roam of the admin surface, `wave-admin-2`, 3sp).
- **Related but NOT this lane (ticket + hand off, never claim):** admin-messaging family
  TM-432/358/373; TM-849 (broadcast one-way invariant, security); TM-870 (cancel-refund fan-out,
  payments); TM-187 (profile change audit, profile lane). TM-772 (free-text city) →
  recommended close-as-duplicate of TM-878 (linked).
- **Lessons banked:** run an **ultracode adversarial review on any nav/route reshape** — on wave-admin-1
  it caught a real signed-out auth-gate regression (`#/admin/users` missing from `PROTECTED`) and a
  dead-spec fixtures import that a single inline pass missed. The Workflow `args` channel didn't reach
  the script (rendered `"undefined"`) — bake per-run literals into the script instead.
