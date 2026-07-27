// Developer tools — the admin Operations panel, lifted to its own screen (TM-972; originally TM-183).
//
// This is the DOM half of the Operations panel that used to live at the FOOT of the users console
// (admin.js buildOps). TM-972 relocates it to its own admin-hub fold at #/admin/ops ("Developer
// tools") — behaviour unchanged, just moved. It mounts into #admin-ops-view; the router (TM-133) gates
// the route ADMIN-only, same as every other #/admin route, so this only surfaces to an admin.
//
// A panel of operational links — health, diagnostics, API docs, and the cloud/dev consoles — so an
// admin can jump to them without hunting for URLs. Built entirely with the XSS-safe `el()` helper (no
// innerHTML). The resolvable URL/model logic stays in the unit-tested pure core admin-ops-core.js
// (never a hardcoded host — every URL comes from injected config); this file only renders it + does the
// one authenticated diagnostics fetch (which needs the admin's bearer token).

import { el, clear } from "./ui.js";
import { getIdToken } from "./auth.js";
import { doodle } from "./doodles.js";
import { appLinks, consoleLinks, DIAGNOSTICS, diagnosticsUrl } from "./admin-ops-core.js";

/** The runtime config (`window.TEAMMARHABA_CONFIG`) — the injected API base + the `ops*` console ids. */
function opsConfig() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
}

/**
 * Fetch one protected diagnostics endpoint WITH the admin's bearer token and render its JSON into `out`.
 *
 * These endpoints (`/actuator/info`, `/actuator/metrics`) require a Firebase token, so a plain <a href>
 * would 401 (no Authorization header) — hence they're fetched here, not linked. The token comes from
 * auth.js `getIdToken()` (the app's single token source). We deliberately do NOT route through api.js's
 * `apiFetch`: its 401 path force-refreshes and then REDIRECTS to the login screen, whereas a diagnostics
 * widget should degrade to a friendly inline note (per the AC), never bounce the admin out of the console.
 */
async function loadDiagnostic(item, out) {
  const url = diagnosticsUrl(opsConfig(), item.path);
  if (!url) {
    out.textContent = "No API base is configured, so diagnostics can't be reached.";
    return;
  }
  out.textContent = "Loading…";
  let token = null;
  try {
    token = await getIdToken();
  } catch {
    token = null;
  }
  if (!token) {
    // Signed out / no token: a plain link would 401 here. Say so plainly rather than firing a request.
    out.textContent = "Sign in as an admin to view this diagnostic.";
    return;
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      out.textContent = "Not available — the backend rejected the token. Sign in again as an admin.";
      return;
    }
    if (!res.ok) {
      out.textContent = `Request failed (${res.status}).`;
      return;
    }
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch {
    out.textContent = "Couldn't reach the backend.";
  }
}

/** A <ul> of anchor links (App endpoints / Consoles): each row is a new-tab anchor + a one-line note.
 *  `rel="noopener noreferrer"` on every external anchor (no reverse tab-nabbing, no referrer leak). */
function opsLinkList(links) {
  return el("ul", { class: "tm-ops-list" }, links.map((l) =>
    el("li", { class: "tm-ops-item" }, [
      el("a", { class: "tm-ops-link", href: l.href, target: "_blank", rel: "noopener noreferrer" }, l.label),
      el("span", { class: "tm-muted tm-ops-desc", text: l.desc }),
    ])));
}

/** The Diagnostics group: one collapsible <details> per protected endpoint. Fetched LAZILY on first
 *  expand (an admin who never opens it makes no request), with a Refresh button to re-fetch on demand. */
function opsDiagnostics() {
  return el("ul", { class: "tm-ops-list" }, DIAGNOSTICS.map((item) => {
    const out = el("pre", { class: "tm-ops-json", tabindex: "0", "aria-label": `${item.label} response` }, "Not loaded yet.");
    const refresh = el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => loadDiagnostic(item, out) }, "Refresh");
    let loadedOnce = false;
    const details = el("details", { class: "tm-ops-diag" }, [
      el("summary", { class: "tm-ops-diag-summary" }, [
        el("span", { class: "tm-ops-link", text: item.label }),
        el("span", { class: "tm-muted tm-ops-desc", text: item.desc }),
      ]),
      el("div", { class: "tm-ops-diag-body" }, [refresh, out]),
    ]);
    details.addEventListener("toggle", () => {
      if (details.open && !loadedOnce) {
        loadedOnce = true;
        loadDiagnostic(item, out);
      }
    });
    return el("li", { class: "tm-ops-item" }, [details]);
  }));
}

/** Build the whole Operations panel. One heading-first <section> holding the three grouped kinds; every
 *  URL comes from injected config via admin-ops-core.js — nothing hardcoded here. Heading-first per the
 *  chrome rules (TM-908/909/910): the screen renders its own <h1>. */
function buildOps() {
  const cfg = opsConfig();
  const app = appLinks(cfg);
  const consoles = consoleLinks(cfg);

  const group = (title, intro, content) =>
    el("div", { class: "tm-ops-group" }, [
      el("h2", { class: "tm-ops-group-title", text: title }),
      el("p", { class: "tm-muted tm-ops-group-intro", text: intro }),
      content,
    ]);

  return el("section", { class: "tm-ops", id: "admin-ops", "aria-label": "Developer tools" }, [
    el("div", { class: "tm-ops-head" }, [
      el("h1", {}, [doodle("crowd", { class: "tm-doodle-header" }), "Developer tools"]),
    ]),
    el("p", { class: "tm-muted tm-ops-note", text: "Quick links to health, diagnostics, API docs, and the cloud/dev consoles." }),
    group(
      "App endpoints",
      "Public backend endpoints — open in a new tab.",
      app.length ? opsLinkList(app) : el("p", { class: "tm-muted", text: "No API base is configured." }),
    ),
    group(
      "Diagnostics",
      "Protected actuator endpoints — fetched with your admin token (a plain link would return 401). Expand to load.",
      opsDiagnostics(),
    ),
    group(
      "Consoles",
      "External cloud and developer consoles for this deployment.",
      consoles.length ? opsLinkList(consoles) : el("p", { class: "tm-muted", text: "No console config has been injected." }),
    ),
  ]);
}

/**
 * Router entry (TM-972): mount the Developer-tools screen into #admin-ops-view. Static content (the
 * links resolve from injected config at build time; diagnostics fetch lazily on expand), so it's built
 * once and reused on every re-entry — mirrors the admin hub's build-once idempotence. The router gates
 * the ADMIN-only #/admin/ops route before calling this.
 */
let built = false;
export function enterAdminOps() {
  const view = document.getElementById("admin-ops-view");
  if (!view || built) return;
  built = true;
  clear(view).append(buildOps());
}

// Bridge for the router (which imports this) + ad-hoc use, mirroring window.tmAdmin in admin.js.
if (typeof window !== "undefined") {
  window.tmAdminOps = { enterAdminOps };
}
