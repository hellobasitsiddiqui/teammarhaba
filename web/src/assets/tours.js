// App product tours + triggers (TM-135). Defines the whole-site walkthrough and the per-page
// tours (data-driven — adding a tour is editing this config, not the engine), and wires when they
// run: the site tour auto-starts once on first login; each page tour auto-starts once on the user's
// first visit to that page; all are replayable from the Help menu in the nav.

import { isTourActive, isTourCompleted, runTour } from "./tour.js";
import { currentUser, onAuthChanged } from "./auth.js";
import { el } from "./ui.js";

// Whole-site walkthrough — the overview, shown once on first login. Targetless steps are centered
// cards; steps whose target is hidden (e.g. the admin link for a non-admin) are skipped automatically.
const SITE_TOUR = {
  id: "site",
  steps: [
    {
      title: "Welcome to TeamMarhaba 👋",
      body: "A quick 30-second tour of the basics. You can skip anytime — and replay it from Help whenever you like.",
    },
    { target: "#me", title: "This is you", body: "Your identity, verified by the backend. Your profile lives here." },
    {
      target: "#nav-admin",
      title: "Admin console",
      body: "Admins manage user accounts here — roles, access, enable/disable.",
    },
    { target: "#nav-help", title: "Need it again?", body: "Replay this tour (or this page's tour) anytime from Help." },
    { target: "#signout-btn", title: "That's it!", body: "Sign out here when you're done. Welcome aboard 🎉" },
  ],
};

// Per-page tours, keyed by hash route — auto-started once on first visit to that page.
const PAGE_TOURS = {
  "#/admin": {
    id: "admin",
    steps: [
      { title: "Admin users console", body: "Everything you need to manage who can access the app." },
      { target: ".tm-stats", title: "At a glance", body: "Live totals: users, admins, enabled and disabled accounts." },
      { target: ".tm-toolbar", title: "Find anyone", body: "Search by email or name, filter by role/status, and sort." },
      {
        target: ".tm-table tbody .tm-actions",
        title: "Per-user actions",
        body: "Enable/disable an account or change its role — each behind a confirm, with undo.",
      },
    ],
  },
  "#/home": {
    id: "home",
    steps: [{ target: "#me", title: "Your home", body: "Your verified identity and profile, fetched from the backend." }],
  },
};

const HOME_ROUTES = new Set(["", "#", "#/", "#/home"]);

// Let the target view finish rendering before a tour measures/spotlights it.
let pending;
function schedule(fn) {
  clearTimeout(pending);
  pending = setTimeout(fn, 350);
}

/** Decide whether to auto-run a tour for the current (route, auth) state. */
function maybeAutoTour() {
  if (isTourActive() || !currentUser()) return;
  const route = window.location.hash;

  // The site tour takes priority on first login; page tours wait until it's done.
  if (!isTourCompleted("site")) {
    if (HOME_ROUTES.has(route)) schedule(() => runTour(SITE_TOUR));
    return;
  }
  const pageTour = PAGE_TOURS[route];
  if (pageTour && !isTourCompleted(pageTour.id)) schedule(() => runTour(pageTour));
}

// --- Help menu (replay on demand) ----------------------------------------------------------

function closeHelpMenu() {
  document.getElementById("tm-help-menu")?.remove();
}

function toggleHelpMenu(button) {
  if (document.getElementById("tm-help-menu")) {
    closeHelpMenu();
    return;
  }
  const pageTour = PAGE_TOURS[window.location.hash];
  const menu = el("div", { id: "tm-help-menu", class: "tm-help-menu", role: "menu" }, [
    el(
      "button",
      {
        class: "tm-help-item",
        type: "button",
        role: "menuitem",
        onClick: () => {
          closeHelpMenu();
          runTour(SITE_TOUR, { force: true });
        },
      },
      "Take the full tour",
    ),
    pageTour
      ? el(
          "button",
          {
            class: "tm-help-item",
            type: "button",
            role: "menuitem",
            onClick: () => {
              closeHelpMenu();
              runTour(pageTour, { force: true });
            },
          },
          "Tour this page",
        )
      : null,
  ]);
  document.body.append(menu);
  const r = button.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  // Close on the next outside click.
  setTimeout(() => document.addEventListener("click", closeHelpMenu, { once: true }), 0);
}

function wireHelp() {
  const button = document.getElementById("nav-help");
  if (!button) return;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHelpMenu(button);
  });
}

// --- triggers ------------------------------------------------------------------------------

if (typeof window !== "undefined") {
  wireHelp();
  // The Help control is only useful (and most steps only exist) once signed in.
  onAuthChanged((user) => {
    const help = document.getElementById("nav-help");
    if (help) help.hidden = !user;
    maybeAutoTour();
  });
  window.addEventListener("hashchange", maybeAutoTour);
}
