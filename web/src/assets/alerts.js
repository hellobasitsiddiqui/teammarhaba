// Site-wide alert banners (TM-243) — the DOM-mounting half.
//
// Mounts a banner host in the app SHELL (main.app), so a global operator notice — e.g. a heatwave
// "events temporarily cancelled" warning — renders on EVERY route (landing, login, home, profile,
// admin, tour) and, because the Android WebView loads this same hosted build, inside the native shell
// too. There is nothing per-page to wire: render it once here and all surfaces get it for free.
//
// The banners are driven entirely by data (GET /api/v1/alerts/active, polled ~5 min), so an operator
// sends or pulls one WITHOUT a redeploy. "Active" is decided server-side; this module only renders what
// the endpoint returns and layers the client dismissal semantics (alerts-core.js) on top:
//   • ACKNOWLEDGE → "OK" persisted in localStorage (keyed by id + content hash; an edit re-shows).
//   • DISMISS     → "✕" persisted in sessionStorage (returns next session until expiry).
//   • PERSISTENT  → no control; clears only when the server stops returning it.
//
// Theme-safe: built from ui.js's el() + Paper theme tokens only (no hard-coded colours), so it renders
// correctly under Paper (and its wavy/sketchy variants). XSS-safe: only textContent, never innerHTML —
// the message is a public broadcast, still never trusted as markup. The public read is unauthenticated
// (getActiveAlerts bypasses the auth redirect), so a warning shows even pre-login.

import { getActiveAlerts } from "./api.js";
import { el, clear } from "./ui.js";
import { visibleAlerts, alertsSignature, recordDismissal, levelClass, ariaRole, showsDismissControl, dismissControl } from "./alerts-core.js";

const HOST_ID = "tm-alerts";
const POLL_MS = 5 * 60 * 1000; // ~5-minute light poll; the banner is not real-time.

// The last active set fetched from the server — re-rendered locally (without a refetch) when the user
// dismisses one, so the dismissed banner disappears immediately.
let lastActive = [];

/**
 * A safe adapter over a Web Storage area: localStorage / sessionStorage can throw in private mode or
 * when disabled, so every access is guarded. A read failure reads as "not dismissed" (show the notice);
 * a write failure is swallowed (we just can't remember the dismissal — the banner reappears, which is
 * the safe direction for an important notice).
 */
function safeStore(getArea) {
  return {
    getItem(key) {
      try {
        return getArea()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        getArea()?.setItem(key, value);
      } catch {
        /* storage unavailable — non-fatal; the notice will simply show again. */
      }
    },
  };
}

const stores = {
  ackStore: safeStore(() => (typeof localStorage !== "undefined" ? localStorage : null)),
  sessionStore: safeStore(() => (typeof sessionStorage !== "undefined" ? sessionStorage : null)),
};

/** The banner host, created once and prepended at the very top of the app shell. Null until mountable. */
function host() {
  if (typeof document === "undefined") return null;
  let node = document.getElementById(HOST_ID);
  if (node) return node;
  const app = document.querySelector("main.app");
  if (!app) return null;
  node = el("div", { id: HOST_ID, class: "tm-alerts", hidden: true });
  // Top of the viewport — a site-wide notice sits above everything else on the page.
  app.prepend(node);
  return node;
}

/** Build one banner element for an alert. */
function banner(alert) {
  const node = el("div", {
    class: `tm-alert ${levelClass(alert.level)}`,
    role: ariaRole(alert.level),
    // CRITICAL interrupts assertively; others announce politely (mirrors the role).
    "aria-live": alert.level === "CRITICAL" ? "assertive" : "polite",
  });

  node.appendChild(el("span", { class: "tm-alert-icon", "aria-hidden": "true" }));
  node.appendChild(el("span", { class: "tm-alert-text", text: alert.message }));

  if (showsDismissControl(alert.dismissal)) {
    const control = dismissControl(alert.dismissal);
    node.appendChild(el("button", {
      type: "button",
      class: "tm-alert-dismiss",
      "aria-label": control.ariaLabel,
      text: control.text,
      onClick: () => {
        recordDismissal(alert, stores);
        render(); // re-render from the cached active set so this banner drops immediately.
      },
    }));
  }
  return node;
}

/** Paint the currently-visible banners (active set minus this client's dismissals). */
function render() {
  const node = host();
  if (!node) return;
  const visible = visibleAlerts(lastActive, stores);
  const signature = alertsSignature(visible);
  // TM-572: skip the clear()+rebuild when the visible set hasn't changed. render() runs on every ~5-min
  // poll; re-inserting each .tm-alert live-region node (role="alert"/aria-live) makes screen readers
  // RE-ANNOUNCE a still-active alert, and a PERSISTENT CRITICAL notice would loop assertively forever.
  // The signature is keyed by id + content-hash, so a new/edited/removed/reordered alert (a real change
  // worth announcing) still repaints, while an identical set is left mounted and untouched. We stash it
  // ON THE HOST NODE (not a module variable) so a freshly (re)created host — empty, no signature — is
  // always repainted rather than skipped as "unchanged".
  if (node.dataset.tmAlertsSig === signature) return;
  clear(node);
  for (const alert of visible) {
    node.appendChild(banner(alert));
  }
  node.hidden = visible.length === 0;
  node.dataset.tmAlertsSig = signature;
}

/**
 * Fetch the active alerts and re-render. Best-effort: getActiveAlerts() already swallows network/HTTP
 * errors to [] (the poll must never throw into the shell), so a transient outage just leaves the last
 * rendered state until the next tick.
 */
export async function refresh() {
  if (typeof document === "undefined") return;
  applyActive(await getActiveAlerts());
}

/**
 * Adopt a known active set and repaint. Split out of refresh() so the fetch and the render are testable
 * apart: a test can drive the exact rebuild-vs-skip behaviour (TM-572) without stubbing the network.
 */
export function applyActive(alerts) {
  lastActive = Array.isArray(alerts) ? alerts : [];
  render();
}

// Poll on load + every ~5 minutes. Guarded so importing this module in Node (tests) does nothing.
if (typeof window !== "undefined") {
  const start = () => {
    refresh();
    window.setInterval(refresh, POLL_MS);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  window.tmAlerts = { refresh };
}
