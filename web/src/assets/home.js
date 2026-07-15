// Home screen (TM-512) — the "Events near you" feed + first-run empty state, refreshed to the
// approved wireframe (design-kit `paper-home` / `app-home` and `paper-empty-home`), rendered inside
// the bottom-nav shell (TM-434) and on the production default theme via tokens only.
//
// A framework-free view module in the events.js / profile.js / admin.js mould: the router (TM-109)
// owns the #/home route + visibility and calls `enterHome()` on entry; this module fetches and builds
// the feed into #tm-home-feed (inside the #auth-signed-in home panel index.html already routes there).
//
// ALL decision logic (the listing split, local-time "when", the "N going" copy, the RSVP-state
// affordance, the empty-vs-populated decision) lives in the pure, unit-tested home-core.js (which in
// turn reuses events-core.js). This file is the thin DOM shell around it.
//
// XSS-safety is inherited from ui.js `el()` (textContent only, no innerHTML seam) — event headings,
// locations and the city are all untrusted and can never inject markup. Icons are built with a small
// SVG-namespaced factory (attribute-only, like doodles.js `s()`), and are DELIBERATELY plain inline
// SVG rather than the sketchy-gated `doodle()` pack (doodles render only when the wavy/sketchy toggle
// is on, so they'd be invisible in clean Paper — the Home icons must show in both toggle states).

import { listEvents, getMe } from "./api.js";
import { el, clear } from "./ui.js";
import { viewerTimeZone } from "./events-core.js";
import { homeContextLine, homeFeed } from "./home-core.js";

const FEED_ID = "tm-home-feed";
const CONTEXT_ID = "tm-home-context";

// Viewer formatting context: the browser's timezone + locale so instants render in local time (the
// events-core.js AC), both failing soft to sensible defaults.
const VIEWER_TZ = viewerTimeZone() || undefined;
const LOCALE = (typeof navigator !== "undefined" && navigator.language) || "en-GB";

// Monotonic guard so a slow fetch that resolves after the user has navigated away (or re-entered)
// can't paint stale content over the current view — mirrors events.js / the router's discipline.
let renderToken = 0;

const $ = (id) => document.getElementById(id);

// ── SVG icons (theme-agnostic, visible on every theme) ───────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an SVG-namespaced node (attribute-only, XSS-safe — no innerHTML). */
function svgNode(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c != null) node.append(c);
  }
  return node;
}

/** A small line icon: currentColor stroke so it inks with the theme (--fg / --muted / --accent). */
function icon(paths, { cls = "tm-home-i", viewBox = "0 0 24 24" } = {}) {
  return svgNode(
    "svg",
    {
      class: cls,
      viewBox,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    paths.map((d) => svgNode("path", { d })),
  );
}

// The wireframe's meta glyphs — a clock (when) and a map pin (where) — and the empty-state calendar.
const clockIcon = () => {
  const svg = icon(["M12 7.5V12l3 2"]);
  svg.prepend(svgNode("circle", { cx: 12, cy: 12, r: 8.5, fill: "none", stroke: "currentColor", "stroke-width": 1.8 }));
  return svg;
};
const pinIcon = () => {
  const svg = icon(["M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"]);
  svg.append(svgNode("circle", { cx: 12, cy: 10, r: 2.4, fill: "none", stroke: "currentColor", "stroke-width": 1.8 }));
  return svg;
};
const calendarIcon = () => {
  // A calendar: rounded body + header divider + two hangers (matches the `paper-empty-home` glyph).
  const svg = icon(["M3 9h18", "M8 3v4", "M16 3v4"], { cls: "tm-home-empty-icon" });
  svg.prepend(svgNode("rect", { x: 3, y: 5, width: 18, height: 16, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }));
  return svg;
};

// ── entry point (router calls this on every #/home entry) ────────────────────────────────────────

/**
 * Router entry (TM-109): fetch the listing (+ the viewer's city, best-effort, for the context line)
 * and paint the feed or the empty-home state into #tm-home-feed. Re-invoked on every entry so counts
 * / RSVP state are always fresh.
 */
export async function enterHome() {
  const feed = $(FEED_ID);
  if (!feed) return; // markup not present (defensive) — never throw.
  const mine = ++renderToken;

  setContext(homeContextLine(null)); // neutral until /me resolves
  clear(feed).append(el("p", { class: "tm-muted tm-home-loading", "data-testid": "home-loading", text: "Finding meetups near you…" }));

  // Fetch the listing and /me together. /me is BEST-EFFORT (only powers the "near <city>" location hint
  // in the context line); its failure must never blank the feed, so it degrades to null.
  let data;
  let me = null;
  try {
    [data, me] = await Promise.all([listEvents(), loadMe()]);
  } catch (err) {
    if (mine !== renderToken) return;
    renderError(feed);
    console.warn("[home] listing load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken) return;

  setContext(homeContextLine(me?.city));

  const cards = Array.isArray(data?.items) ? data.items : [];
  const model = homeFeed(cards, { tz: VIEWER_TZ, locale: LOCALE });

  clear(feed);
  if (model.isEmpty) {
    feed.append(emptyState());
    return;
  }
  const list = el("div", { class: "tm-home-list", "data-testid": "home-feed-list" });
  for (const card of model.cards) list.append(feedCard(card));
  feed.append(list);
}

/** Fetch /me for the city context line — degrades to null (city "unknown") on any failure. */
async function loadMe() {
  try {
    return await getMe();
  } catch (err) {
    console.warn("[home] GET /me failed (city context degrades to 'Near you'):", err?.message ?? err);
    return null;
  }
}

/** Set the section context subtitle text (the "Upcoming meetups near <city>" line, TM-734). */
function setContext(text) {
  const node = $(CONTEXT_ID);
  if (node) node.textContent = text;
}

// ── feed card ────────────────────────────────────────────────────────────────────────────────────

/**
 * One Home feed card — the whole card is a link to the event detail (the tap target), matching the
 * #/events browse card. Layout follows `paper-home`: optional live/tag chip, title, a "when" and a
 * "where" meta row (clock + pin glyphs), then a row of the "N going" pill and the RSVP-state
 * affordance. The state affordance is a styled span (not a nested button — invalid inside an anchor):
 * it leads to the detail, where the actual, gated RSVP lives (events.js / events-core.js).
 */
function feedCard(model) {
  const chips = el("div", { class: "tm-home-card-chips" }, [
    model.live ? el("span", { class: "tm-home-live", text: "Live now" }) : null,
    model.tag ? el("span", { class: "tm-home-tag", text: model.tag }) : null,
  ]);

  return el(
    "a",
    {
      class: `tm-home-card${model.live ? " tm-home-card-live" : ""}`,
      href: model.href,
      "data-testid": "home-event-card",
      dataset: { eventId: String(model.id) },
    },
    [
      // Only render the chip row when there's a chip to show (keeps spacing tight when empty).
      model.live || model.tag ? chips : null,
      el("h3", { class: "tm-home-card-title", text: model.title }),
      el("p", { class: "tm-home-meta" }, [clockIcon(), el("span", { text: model.when })]),
      el("p", { class: "tm-home-meta" }, [pinIcon(), el("span", { text: model.where })]),
      el("div", { class: "tm-home-card-row" }, [
        el("span", { class: "tm-home-going", "data-testid": "home-going-count", text: model.going }),
        el("span", { class: `tm-home-state tm-home-state-${model.state.kind}`, text: model.state.label }),
      ]),
    ],
  );
}

// ── empty + error states ─────────────────────────────────────────────────────────────────────────

/** The `paper-empty-home` first-run state: dashed art tile, heading, lede, and the primary CTA. */
function emptyState() {
  return el("div", { class: "tm-home-empty", "data-testid": "home-empty" }, [
    el("div", { class: "tm-home-empty-art", "aria-hidden": "true" }, [calendarIcon()]),
    el("h3", { class: "tm-home-empty-title", text: "No events yet" }),
    el("p", { class: "tm-home-empty-text", text: "You haven't joined anything. Find a meetup near you — your first event is free." }),
    // reconcile with TM-511 component library — the CTA reuses the shared .tm-btn primary button.
    el("a", { class: "tm-btn tm-btn-primary tm-home-empty-cta", href: "#/events" }, "Find events near you"),
  ]);
}

/** A friendly load-failure state with a retry (never a dead blank feed). */
function renderError(feed) {
  clear(feed).append(
    el("div", { class: "tm-home-empty", "data-testid": "home-error" }, [
      el("div", { class: "tm-home-empty-art", "aria-hidden": "true" }, [calendarIcon()]),
      el("h3", { class: "tm-home-empty-title", text: "Couldn't load events" }),
      el("p", { class: "tm-home-empty-text", text: "Something went wrong. Please try again." }),
      // reconcile with TM-511 component library — reuses the shared .tm-btn button.
      el("button", { class: "tm-btn", type: "button", onClick: () => enterHome() }, "Retry"),
    ]),
  );
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmHome = { enterHome };
}
