// Security settings UI — the "Security" block shown on the #/profile page (mounted by profile.js).
//
// It holds three things:
//
//  1. App-lock toggle (TM-282) — "Require fingerprint to open the app". This sub-block starts HIDDEN
//     and only reveals itself once we've confirmed (async) that we're in the native shell AND the
//     device has usable biometry / a secure lock screen (AC #4 — feature hidden, no crash, when
//     nothing is enrolled). On the web build isNativeShell() is false, so it stays hidden forever.
//     Flipping ON first asks the user to authenticate once (proving the biometric works) before we
//     persist; flipping OFF is immediate. The preference is per-device localStorage.
//
//  2. Your devices (TM-924) — the caller's PUSH-registered devices from GET /api/v1/me/devices, each
//     shown with its platform + last-seen. HONEST COPY is required and load-bearing: this is the
//     push-registered device set, NOT every session, so a signed-in browser that never granted
//     notifications will NOT appear. The copy says so, so the list is never mistaken for a full
//     session registry (a real per-session view is deferred to TM-1077).
//
//  3. Sign out everywhere (TM-924) — a button that (after a styled confirm) revokes ALL of the
//     caller's Firebase refresh tokens server-side, then signs THIS tab out locally. There is no
//     per-session granularity in Firebase, so it's all-or-nothing by design.
//
// UNLIKE the old version (which returned the whole section hidden until native biometry), the section
// itself is ALWAYS visible now — the devices list + sign-out-everywhere are web-and-native features —
// and only the app-lock sub-block is conditionally revealed.
//
// This module now imports api.js (getMyDevices / signOutEverywhere), which pulls in the Firebase CDN
// chain, so it can no longer be imported under `node --test` — its wiring is pinned with source-level
// guard tests (biometric-settings-devices.test.mjs), exactly like home.js / membership-receipts.js.
// The pure device view-model it renders (devices-core.js) is behaviourally unit-tested on its own.

import { confirmDialog, el, relativeTime, toast } from "./ui.js";
import { isNativeShell, isBiometricAvailable, authenticate } from "./biometric.js";
import { isAppLockEnabled, setAppLockEnabled } from "./biometric-policy.js";
import { getMyDevices, signOutEverywhere } from "./api.js";
import { signOut } from "./auth.js";
import { deviceListView } from "./devices-core.js";

function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The app-lock toggle sub-block (TM-282). Returns the wrapper element (starts HIDDEN); it reveals
 * itself asynchronously only on a native device with usable biometry / a secure lock screen. Split out
 * of buildSecuritySettings so the surrounding Security section can host the always-on device controls
 * (TM-924) alongside this conditionally-shown toggle.
 * @returns {HTMLElement}
 */
function buildAppLockBlock() {
  const checkbox = el("input", {
    type: "checkbox",
    id: "biometric-app-lock",
    class: "tm-switch-input",
  });

  const label = el("label", { class: "tm-switch", for: "biometric-app-lock" }, [
    checkbox,
    el("span", { class: "tm-switch-track" }, [el("span", { class: "tm-switch-thumb" })]),
    el("span", { class: "tm-switch-text", text: "Require fingerprint to open the app" }),
  ]);

  const hint = el("p", { class: "tm-muted tm-switch-hint" }, [
    "When on, you'll need your fingerprint or device PIN each time you reopen Circle on this device.",
  ]);

  const block = el("div", { class: "tm-security-applock", id: "security-applock", hidden: true }, [label, hint]);

  // Reflect the persisted preference (defaults OFF).
  checkbox.checked = isAppLockEnabled(safeStorage());

  // Toggle handler: turning ON requires a successful auth first; OFF is immediate.
  checkbox.addEventListener("change", async () => {
    const storage = safeStorage();
    if (checkbox.checked) {
      checkbox.disabled = true;
      const res = await authenticate({
        reason: "Confirm to turn on app-lock",
        title: "Turn on app-lock",
        subtitle: "Verify your fingerprint or PIN",
      });
      checkbox.disabled = false;
      if (!res.ok) {
        // Auth not completed — revert the switch and don't persist.
        checkbox.checked = false;
        if (res.reason !== "dismissed") toast("Couldn't verify — app-lock not enabled.", { type: "error" });
        return;
      }
      if (setAppLockEnabled(storage, true)) {
        toast("App-lock turned on.", { type: "success" });
      } else {
        checkbox.checked = false;
        toast("Couldn't save the setting.", { type: "error" });
      }
    } else {
      setAppLockEnabled(storage, false);
      toast("App-lock turned off.", { type: "info" });
    }
  });

  // Reveal the sub-block only on a native device with usable biometry / secure lock screen.
  if (isNativeShell()) {
    isBiometricAvailable()
      .then((available) => {
        if (available) {
          block.hidden = false;
        }
      })
      .catch(() => {
        /* leave hidden — never break the profile page */
      });
  }

  return block;
}

/**
 * One device row (TM-924): the platform label + a last-seen relative time (with the exact timestamp on
 * hover via the title attr). XSS-safe — el() only (textContent, never innerHTML). The raw push token is
 * never in the payload, so nothing sensitive is rendered.
 * @param {ReturnType<typeof import("./devices-core.js").deviceRowView>} row
 * @returns {HTMLElement}
 */
function deviceRow(row) {
  const seen = relativeTime(row.lastSeen);
  return el("li", { class: "tm-device-row" }, [
    el("span", { class: "tm-device-name", text: row.platformLabel }),
    el("span", { class: "tm-device-seen", title: seen.title || "", text: `Last seen ${seen.text}` }),
  ]);
}

/**
 * The "Your devices" sub-block (TM-924). Fetches GET /me/devices and paints one row per push-registered
 * device (newest-active first, via the tested deviceListView), under HONEST copy that a push-less
 * browser session won't appear. A load failure is caught (never white-screens the profile) and shows a
 * quiet inline message; an empty list shows the empty state. Returns the block immediately and fills it
 * asynchronously.
 * @returns {HTMLElement}
 */
function buildDevicesBlock() {
  const list = el("ul", { class: "tm-device-list", "aria-label": "Your devices" });
  const status = el("p", { class: "tm-muted tm-device-status", text: "Loading your devices…" });

  const block = el("div", { class: "tm-security-devices", id: "security-devices" }, [
    el("h4", { class: "tm-security-subhead", text: "Your devices" }),
    el("p", { class: "tm-muted tm-device-note" }, [
      "Devices where you've turned on notifications. A browser or device without notifications may not appear here, so this isn't every place you're signed in.",
    ]),
    status,
    list,
  ]);

  getMyDevices()
    .then((devices) => {
      const rows = deviceListView(devices);
      if (rows.length === 0) {
        status.textContent = "No devices with notifications turned on yet.";
        return;
      }
      status.hidden = true;
      for (const row of rows) list.append(deviceRow(row));
    })
    .catch(() => {
      status.textContent = "Couldn't load your devices right now.";
    });

  return block;
}

/**
 * The "Sign out everywhere" sub-block (TM-924): a danger button that, after a styled confirmDialog,
 * revokes ALL of the caller's Firebase refresh tokens server-side (every session boots on its next
 * request) and then signs THIS tab out locally so it doesn't linger on a now-dead session. Cancel /
 * Escape / backdrop is a no-op (session intact). A server error is surfaced as a toast and does NOT
 * sign the tab out (the sessions weren't revoked). XSS-safe (el() only).
 * @returns {HTMLElement}
 */
function buildSignOutEverywhereBlock() {
  const button = el(
    "button",
    { class: "tm-btn tm-btn-danger tm-signout-everywhere", id: "security-signout-everywhere", type: "button" },
    "Sign out everywhere",
  );

  button.addEventListener("click", async () => {
    const confirmed = await confirmDialog({
      title: "Sign out everywhere?",
      message: "This signs you out on every device, including this one. You'll need your code to sign back in.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (!confirmed) return;

    button.disabled = true;
    try {
      await signOutEverywhere();
    } catch {
      button.disabled = false;
      toast("Couldn't sign out everywhere. Please try again.", { type: "error" });
      return;
    }
    // Sessions revoked server-side — now clear THIS tab so it doesn't sit on a dead session. signOut()
    // fires the TM-720 onSignedOut reset chain (untouched), which routes to login.
    try {
      await signOut();
    } catch (err) {
      toast(err?.message || "Signed out everywhere, but couldn't clear this tab — please reload.", { type: "error" });
    }
  });

  return el("div", { class: "tm-security-signout", id: "security-signout-block" }, [
    el("h4", { class: "tm-security-subhead", text: "Sign out everywhere" }),
    el("p", { class: "tm-muted", text: "Signs you out on all your devices. Useful if you've lost a device or used a shared one." }),
    button,
  ]);
}

/**
 * Build the Security settings section element (TM-282 / TM-924). Always visible: it hosts the
 * conditionally-revealed app-lock toggle, the "Your devices" list, and "Sign out everywhere". The
 * enclosing profile.js already wraps this in a collapsible "Security" card with its own header, so this
 * returns the section body directly.
 * @returns {HTMLElement}
 */
export function buildSecuritySettings() {
  return el("section", { class: "tm-security-settings", "aria-label": "Security" }, [
    buildAppLockBlock(),
    buildDevicesBlock(),
    buildSignOutEverywhereBlock(),
  ]);
}
