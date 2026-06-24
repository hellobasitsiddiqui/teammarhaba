// Doodle decoration for the STATIC page panels (TM-215). index.html's landing header, the login
// card, and the signed-in "home" card are plain markup (not built by the el() kit), so this small
// module mounts a few tasteful doodles from the TM-214 pack into them once the DOM is ready.
//
// Visual-only: it never reads user data, changes layout flow (doodles are decorative inline SVG),
// or touches app logic. The doodles are authored with stroke="currentColor" and are sized/spaced by
// the `[data-theme="doodle"]` rules in styles.css; a companion CSS rule there hides any `.tm-doodle`
// that isn't under the doodle theme, so this is inert on `clean` even though the nodes are mounted.
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

  // 1) Landing header — a "hello"/marhaba wave beside the app title, then a hello! divider under
  //    the tagline. This is the first thing an unconfigured (now doodle-default) deploy shows.
  decorateHeader(document.querySelector(".app h1"), "hello", "Marhaba — welcome");
  dividerAfter(document.querySelector(".app .tagline"), { tag: true });

  // 2) Login card — a small wave on the "Sign in" heading. Decorative: no title (it would just
  //    repeat the "Sign in" heading text), so it renders aria-hidden.
  decorateHeader($("auth-signed-out")?.querySelector("h2"), "hello");

  // 3) Signed-in home card — a celebration on the "Signed in" heading, then a divider before the
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
