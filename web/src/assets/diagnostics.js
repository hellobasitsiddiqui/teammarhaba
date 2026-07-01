// Diagnostics screen (TM-297, epic TM-277) — a small QA-facing #/diagnostics view that makes the
// native capabilities directly testable from a real device, without wiring up a feature first.
//
// WHY. The native bits (GPS — TM-280, push/FCM — TM-279, camera, biometric) only do real work inside
// the Capacitor Android shell (TM-278), which loads this SAME hosted SPA via `server.url`. QA had no
// way to (a) trigger a geolocation fix and see the result, (b) read the device's FCM token to target a
// test push, or (c) confirm which native plugins the shell actually injected. This screen surfaces all
// three. It is deliberately UNOBTRUSIVE: reachable at a known hash route and via a small link in the
// profile/settings area, not promoted in the main nav.
//
// SAFE EVERYWHERE. Like the rest of the web layer this module is served to the browser too, so every
// probe is env-guarded and degrades to a "not on device" readout rather than throwing: the geolocation
// helper (geolocation.js) already returns a tagged result instead of throwing, the FCM token getter
// (push.js) returns null off-device, and the plugin probes just read presence off the Capacitor global.
//
// XSS-SAFETY is structural, inherited from the UX kit (TM-133): every node is built with `el()` which
// only ever sets text via `textContent`. No dynamic value (coords, error strings, the FCM token) is
// ever put through innerHTML — so a hostile token/error string can never inject markup.
//
// Mounting mirrors the other view modules (help.js / profile.js): the router (TM-109) owns
// #diagnostics-view visibility and calls enterDiagnostics() on entry; this builds the content into that
// container once (idempotent) and re-reads the live readouts each entry.

import { clear, el, copyToClipboard } from "./ui.js";
import { isWebViewEnv } from "./auth-env.js";
import { getCurrentPosition, isGeolocationSupported } from "./geolocation.js";
import { getCurrentToken } from "./push.js";

const $ = (id) => document.getElementById(id);

// The Capacitor plugin proxies we report on. Names match how each native half registers itself, so the
// presence check is just "did the shell inject a proxy under this key": PushNotifications (TM-279),
// Geolocation (TM-280), Camera (TM-166 native-camera.js), BiometricAuthNative (TM-282 biometric.js).
const PLUGIN_NAMES = ["PushNotifications", "Geolocation", "Camera", "BiometricAuthNative"];

/**
 * Read whether the Capacitor native runtime reports itself as a native platform. Defensive: a plain
 * browser has no `window.Capacitor`; even a partial web-Capacitor global has `isNativePlatform()`
 * returning false. Never throws.
 * @param {object} [win=globalThis]
 * @returns {boolean}
 */
function isNativePlatform(win = globalThis) {
  const cap = win && win.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

/**
 * Which of the known Capacitor plugins are present on `window.Capacitor.Plugins`. Pure given `win`,
 * so it's unit-testable with a fake window. Returns a name→boolean map (false for every plugin off
 * device, where there's no Capacitor global at all).
 * @param {object} [win=globalThis]
 * @returns {Record<string, boolean>}
 */
export function detectPlugins(win = globalThis) {
  const plugins = (win && win.Capacitor && win.Capacitor.Plugins) || {};
  const out = {};
  for (const name of PLUGIN_NAMES) out[name] = Boolean(plugins[name]);
  return out;
}

/** A labelled key/value row: a bold key and a value node (or text). */
function row(key, value) {
  return el("div", { class: "tm-diag-row" }, [
    el("span", { class: "tm-diag-key", text: key }),
    value && value.nodeType ? value : el("span", { class: "tm-diag-val", text: String(value) }),
  ]);
}

/** A yes/no chip — green for present/true, muted for absent/false. */
function boolChip(on) {
  return el("span", { class: `tm-diag-chip ${on ? "tm-diag-chip-on" : "tm-diag-chip-off"}`, text: on ? "yes" : "no" });
}

/** A titled diagnostics card: an <h3> heading followed by its body nodes. */
function card(title, ...body) {
  return el("section", { class: "tm-diag-card" }, [el("h3", { text: title }), ...body]);
}

// ---- GPS section ----------------------------------------------------------------------------------

// Human-readable copy for each tagged geolocation status (geolocation.js returns these tags, never
// throws). Keyed so we never interpolate a raw status into a sentence by hand.
const GPS_STATUS_TEXT = {
  denied: "Permission denied — the user or OS refused location access.",
  unavailable: "Unavailable — no location API in this runtime, or no fix could be obtained.",
  timeout: "Timed out — no fix acquired within the time limit.",
};

/** Render the result of a position request into the GPS output node (textContent only). */
function renderGpsResult(out, result) {
  clear(out);
  if (result.status === "ok") {
    const { latitude, longitude, accuracy } = result.coords || {};
    out.append(
      row("Latitude", String(latitude)),
      row("Longitude", String(longitude)),
      row("Accuracy", accuracy == null ? "—" : `±${accuracy} m`),
    );
    return;
  }
  const message = GPS_STATUS_TEXT[result.status] || `Error (${result.status}).`;
  out.append(
    row("Status", result.status),
    el("p", { class: "tm-diag-error", text: result.error ? `${message} (${result.error})` : message }),
  );
}

/** Build the GPS card: a button that requests a single fix and renders the tagged result/error. */
function buildGpsCard() {
  const out = el("div", { class: "tm-diag-out", id: "diag-gps-out" });
  const supported = isGeolocationSupported();
  const btn = el(
    "button",
    {
      class: "tm-btn tm-btn-primary",
      type: "button",
      onClick: async () => {
        btn.disabled = true;
        clear(out).append(el("p", { class: "tm-muted", text: "Requesting location…" }));
        const result = await getCurrentPosition();
        renderGpsResult(out, result);
        btn.disabled = false;
      },
    },
    "Get my location",
  );
  return card(
    "GPS / Location",
    el("p", { class: "tm-muted", text: supported
      ? "Tap to request a single position fix from this device."
      : "No location API in this runtime — this will report “unavailable”." }),
    el("div", { class: "tm-form-actions" }, [btn]),
    out,
  );
}

// ---- Push / FCM section ---------------------------------------------------------------------------

/**
 * The native push permission state, if the plugin exposes it synchronously, else a placeholder. We
 * keep this best-effort and non-throwing: checkPermissions() is async on the real plugin, so the
 * readout below resolves it on entry (see refreshPush). Off device there's no plugin → "not on device".
 */
function buildPushCard() {
  const tokenVal = el("code", { class: "tm-diag-token", id: "diag-fcm-token", text: "…" });
  const copyBtn = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      id: "diag-fcm-copy",
      onClick: () => {
        const token = getCurrentToken();
        if (token) copyToClipboard(token);
      },
    },
    "Copy",
  );
  const permVal = el("span", { class: "tm-diag-val", id: "diag-push-perm", text: "…" });
  return card(
    "Push / FCM",
    row("Permission", permVal),
    el("div", { class: "tm-diag-row" }, [
      el("span", { class: "tm-diag-key", text: "FCM token" }),
      el("span", { class: "tm-diag-token-wrap" }, [tokenVal, copyBtn]),
    ]),
  );
}

/**
 * Refresh the push readouts (token + permission) from the live push client and plugin. Best-effort and
 * non-throwing: off device the token getter returns null and there's no plugin, so we show a clear
 * "not on device" message rather than erroring. Called on each entry so a token registered after the
 * first visit is reflected.
 * @param {object} [win=globalThis]
 */
async function refreshPush(win = globalThis) {
  const tokenEl = $("diag-fcm-token");
  const copyEl = $("diag-fcm-copy");
  const permEl = $("diag-push-perm");
  if (!tokenEl || !permEl) return;

  const token = getCurrentToken();
  if (token) {
    tokenEl.textContent = token;
    if (copyEl) copyEl.disabled = false;
  } else {
    tokenEl.textContent = isNativePlatform(win)
      ? "No token yet — sign in on the device to register for push."
      : "Not on device — push only registers inside the app.";
    if (copyEl) copyEl.disabled = true;
  }

  // Permission state: read it off the injected PushNotifications plugin if present (async), else say so.
  const plugin = win && win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.PushNotifications;
  if (plugin && typeof plugin.checkPermissions === "function") {
    try {
      const perm = await plugin.checkPermissions();
      permEl.textContent = (perm && perm.receive) || "unknown";
    } catch (err) {
      permEl.textContent = `unknown (${String((err && err.message) || err || "")})`;
    }
  } else {
    permEl.textContent = "not on device";
  }
}

// ---- Environment section --------------------------------------------------------------------------

/** Build the environment card: WebView signal, native-platform flag, and which plugins are present. */
function buildEnvCard(win = globalThis) {
  const plugins = detectPlugins(win);
  const pluginRows = PLUGIN_NAMES.map((name) => row(name, boolChip(plugins[name])));
  return card(
    "Environment",
    row("isWebViewEnv()", boolChip(isWebViewEnv(win))),
    row("Capacitor.isNativePlatform()", boolChip(isNativePlatform(win))),
    el("p", { class: "tm-diag-subhead tm-muted", text: "Native plugins injected" }),
    ...pluginRows,
  );
}

// ---- mount ----------------------------------------------------------------------------------------

/** Build the (idempotent) diagnostics content into the view container. */
function build(view) {
  clear(view).append(
    el("div", { class: "tm-diag" }, [
      el("h2", { text: "Diagnostics" }),
      el("p", {
        class: "tm-muted",
        text: "QA tools for testing native capabilities. Safe to open in a browser — native-only checks show “not on device” there.",
      }),
      buildGpsCard(),
      buildPushCard(),
      buildEnvCard(),
    ]),
  );
}

/**
 * Called by the router when the #/diagnostics view becomes active. Builds the content once (idempotent
 * on re-entry) and refreshes the live push readouts each time so a token registered after the first
 * visit shows up.
 */
export function enterDiagnostics() {
  const view = $("diagnostics-view");
  if (!view) return;
  if (!view.dataset.built) {
    build(view);
    view.dataset.built = "true";
  }
  void refreshPush();
}

// Bridge for ad-hoc use / parity with the other view modules.
if (typeof window !== "undefined") {
  window.tmDiagnostics = { enterDiagnostics };
}
