// Biometric settings UI (TM-282) — the app-lock toggle shown on the #/profile page.
//
// Renders a "Security" section with a single switch: "Require fingerprint to open the app". The
// section starts HIDDEN and only reveals itself once we've confirmed (async) that we're in the native
// shell AND the device has usable biometry or a secure lock screen (AC #4 — feature hidden/disabled,
// no crash, when nothing is enrolled). On the web build `isNativeShell()` is false, so it stays hidden
// forever and the page is unchanged.
//
// Flipping the toggle ON first asks the user to authenticate once (so they prove the biometric works
// before we start gating on it); only on success do we persist the preference. Flipping OFF is
// immediate. The preference is per-device localStorage (see biometric-policy.js APP_LOCK_KEY).

import { el, toast } from "./ui.js";
import { isNativeShell, isBiometricAvailable, authenticate } from "./biometric.js";
import { isAppLockEnabled, setAppLockEnabled } from "./biometric-policy.js";

function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the security settings section element. Returns the section node immediately (hidden); it
 * reveals itself asynchronously once biometric availability is confirmed.
 * @returns {HTMLElement}
 */
export function buildSecuritySettings() {
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

  const section = el(
    "section",
    { class: "tm-security-settings", id: "security-settings", "aria-label": "Security", hidden: true },
    [
      el("h3", { text: "Security" }),
      label,
      hint,
    ],
  );

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

  // Reveal the section only on a native device with usable biometry / secure lock screen.
  if (isNativeShell()) {
    isBiometricAvailable()
      .then((available) => {
        if (available) {
          section.hidden = false;
        }
      })
      .catch(() => {
        /* leave hidden — never break the profile page */
      });
  }

  return section;
}
