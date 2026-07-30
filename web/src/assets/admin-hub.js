// Admin hub screen — DOM wiring (TM-917). The second-level admin nav opened by the bottom-bar Admin
// tab (TM-916): `#/admin` renders this hub (a paper-style list, one row per console), and each row is
// a plain hash link to an existing console — reused as-is, this is nav chrome not a console rebuild.
// Mounts into `#admin-hub-view`; the router (TM-133) gates the route server-side, so this only
// surfaces entries an admin already reaches. The pure row model + routes live in admin-hub-route.js
// (unit-tested); this file only touches the DOM (built once — the hub content is static).
//
// Back-to-hub: there is no per-console back button — the bottom-bar Admin tab IS the return affordance
// (its href is `#/admin` = this hub), so tapping Admin from inside any console comes back here.

import { el, clear } from "./ui.js";
import { ADMIN_HUB_ROWS } from "./admin-hub-route.js";

let built = false;

/**
 * Build the hub into `#admin-hub-view` (idempotent — the content is static, so it's built once and
 * reused on every re-entry). Heading-first + self-headed, per the chrome rules (TM-908/909/910).
 */
export function enterAdminHub() {
  const view = document.getElementById("admin-hub-view");
  if (!view || built) return;
  built = true;
  clear(view).append(
    el("h1", { class: "admin-hub-title", text: "Admin" }),
    el("nav", { class: "admin-hub-list", "aria-label": "Admin sections" },
      ADMIN_HUB_ROWS.map((row) =>
        el("a", { class: "admin-hub-row", href: row.route }, [
          el("span", { class: "admin-hub-row-text" }, [
            el("span", { class: "admin-hub-row-label", text: row.label }),
            el("span", { class: "admin-hub-row-desc", text: row.desc }),
          ]),
          el("span", { class: "admin-hub-row-chevron", text: "›", "aria-hidden": "true" }),
        ]))),
  );
  // Ready hook (TM-1176). The rows above are appended synchronously here, but this mount only runs
  // AFTER the async role resolution flips `isAdmin` true (router.js) — and by then `render()` has
  // already unhidden `#admin-hub-view` on the route match ALONE (independent of isAdmin/the mount).
  // So on a slow cold-boot the view is VISIBLE with zero rows for the window between unhide and mount,
  // which is the admin-hub e2e race: `#admin-hub-view` toBeVisible() passes, then the row-count is
  // asserted before the rows paint. Stamp a stable `data-ready` on the view once the rows are attached
  // so tests (and any observer) wait on the actual mount, not the mere unhide. Set LAST, so it's only
  // present when every row is in the DOM; the count under it is deterministic (ADMIN_HUB_ROWS is static).
  view.setAttribute("data-ready", "");
}

// Bridge for the router (which imports this) + ad-hoc use, mirroring window.tmAdmin in admin.js.
if (typeof window !== "undefined") {
  window.tmAdminHub = { enterAdminHub };
}
