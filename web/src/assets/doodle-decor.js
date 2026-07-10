// Doodle decoration for the STATIC page panels (TM-215). index.html's signed-in "home" card is
// plain markup (not built by the el() kit), so this small module mounts a couple of tasteful
// doodles from the TM-214 pack into it once the DOM is ready. (TM-596 removed the landing-header
// and login-card decorations so the brand lockup stays a clean centred wordmark + one tagline.)
//
// Visual-only: it never reads user data, changes layout flow (doodles are decorative inline SVG),
// or touches app logic. The doodles are authored with stroke="currentColor" and are sized/spaced by
// the `[data-sketchy="on"]` rules in styles.css; a companion CSS rule there hides any `.tm-doodle`
// in clean Paper, so this is inert (mounted but not shown) when the wavy/sketchy toggle is off.
// The router/login modules own the panels' visibility — we only prepend decorations, idempotently.
//
// XSS-safe: doodles come from the structural builder in doodles.js (attributes + a static <title>
// only, no innerHTML), and we mount with append/prepend. No untrusted string ever flows in.

import { doodle, doodles } from "./doodles.js";

/**
 * Prepend a header-sized doodle to `host` (once), if `host` exists. Pass `title` only when it adds
 * info beyond the heading text; omit it for a doodle whose label would just repeat the visible
 * heading, so it renders aria-hidden and screen readers don't announce the same words twice.
 */
function decorateHeader(host, name, title) {
  if (!host || host.querySelector(":scope > .tm-doodle")) return;
  const svg = doodle(name, { class: "tm-doodle-header", title });
  if (svg) host.prepend(svg);
}

/** Insert a full-width squiggle divider after `node` (once), if `node` exists. */
function dividerAfter(node, { tag = false } = {}) {
  if (!node || node.nextElementSibling?.classList?.contains("tm-doodle-divider")) return;
  node.after(doodles.divider({ class: "tm-doodle-divider", tag }));
}

function decorate() {
  const $ = (id) => document.getElementById(id);

  // TM-596: the landing header and the login-card heading no longer get doodle decoration. The
  // "hello"/marhaba wave that used to sit beside the ".app h1" wordmark (the "hand"), the wavy
  // "hello!" divider that used to sit under the ".app .tagline" (the TM-529 wavy motif), and the
  // small wave on the "Sign in" heading are all removed here so the brand lockup is a clean centred
  // wordmark + single tagline on every surface (web / mobile-web / Android WebView). The signed-in
  // home card below is out of scope for that lockup and keeps its welcome flourish.

  // 1) Signed-in home card — a celebration on the "Signed in" heading, then a divider before the
  //    admin link block so the card reads as a little welcome.
  const homeCard = $("auth-signed-in");
  decorateHeader(homeCard?.querySelector("h2"), "celebrate", "You're in");
  dividerAfter(homeCard?.querySelector("#me"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", decorate, { once: true });
} else {
  decorate();
}
