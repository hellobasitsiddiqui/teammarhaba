// Shared per-screen "highlight points" — the single source of truth for which controls each screen
// calls out, reused by BOTH the live product tour (tours.js / TM-135) and the static annotated help
// guide (help-guide.js / TM-178). Keeping the copy here means the interactive walkthrough and the
// illustrated guide can never drift apart: change a callout's title/body once and both surfaces pick
// it up.
//
// A highlight point is plain data: { target?, title, body }.
//   • target  — a CSS selector for the live UI element the tour spotlights (omit for an intro/outro
//                card with no anchor). The static guide also uses it as a stable KEY to position its
//                callout over the matching spot on its representative mock (see help-guide.js).
//   • title   — short heading for the callout.
//   • body    — one or two sentences explaining the control.
//
// This module is intentionally framework-free and import-free so it stays a pure data island that any
// surface can consume. To add a highlight to an existing screen, push another entry onto its array; to
// add a whole new screen, add a new keyed array here and (for the guide) a screen mock in help-guide.js.

/**
 * The whole-site walkthrough's highlight points, in order. The first (targetless) entry is the
 * welcome card; the rest spotlight the nav/identity controls a first-run user should know about.
 * @type {ReadonlyArray<{target?: string, title: string, body: string}>}
 */
export const SITE_HIGHLIGHTS = [
  {
    title: "Welcome to Circle 👋",
    body: "A quick 30-second tour of the basics. You can skip anytime — and replay it from the Take a tour button whenever you like.",
  },
  { target: "#me", title: "This is you", body: "Your identity, verified by the backend. Your profile lives here." },
  {
    target: "#nav-admin",
    title: "Admin hub",
    body: "Admins start here — one place linking every admin console: users, events, venues, interests, messages.",
  },
  // TM-1024: the Take-a-tour launcher (#nav-help) was removed from the top nav when the desktop nav
  // became the four tabs, so this callout's target no longer exists and tour.js auto-skips this step
  // (it filters out any step whose target isn't rendered). Kept here (not silently deleted) so wave-help-1
  // — which re-homes the tour launcher — can re-point it at the launcher's new home rather than rewrite it.
  { target: "#nav-help", title: "Need it again?", body: "Replay this tour (or this page's tour) anytime from here." },
  // TM-906: the closing step used to spotlight the top-nav sign-out button, which no longer exists —
  // sign-out moved to the Profile hub's menu (behind a confirm). The closer is re-anchored to the
  // Profile nav entry (the way TO the sign-out row from this screen); the literal row only exists on
  // #/profile, so anchoring the site tour to it would always be auto-skipped as off-screen.
  { target: "#nav-profile", title: "That's it!", body: "Your profile lives here — including Sign out when you're done. Welcome aboard 🎉" },
];

/**
 * Per-page highlight points, keyed by hash route. Each is an ordered array of highlight points for
 * that screen; the first entry is typically a targetless intro card.
 * @type {Readonly<Record<string, ReadonlyArray<{target?: string, title: string, body: string}>>>}
 */
export const PAGE_HIGHLIGHTS = {
  // TM-917: the users console moved off #/admin (now the admin hub) to #/admin/users — this tour
  // describes that console (its .tm-stats / .tm-toolbar / .tm-table), so it is keyed to the new route.
  "#/admin/users": [
    { title: "Admin users console", body: "Everything you need to manage who can access the app." },
    { target: ".tm-stats", title: "At a glance", body: "Live totals: users, admins, enabled and disabled accounts." },
    { target: ".tm-toolbar", title: "Find anyone", body: "Search by email or name, filter by role/status, and sort." },
    {
      target: ".tm-table tbody .tm-actions",
      title: "Per-user actions",
      body: "Enable/disable an account or change its role — each behind a confirm, with undo.",
    },
  ],
  "#/home": [
    { target: "#me", title: "Your home", body: "Your verified identity and profile, fetched from the backend." },
  ],
};
