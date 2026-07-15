// App-wide Paper appearance sync (TM-529). The boot script (appearance.js) paints a fast first guess
// from the localStorage hint; this module reconciles it with the SERVER — the source of truth — on
// every page, so the user's chosen accent + wavy/sketchy toggle apply everywhere (Home, Events, Chat,
// Profile…), not just on the settings screen, and follow them across devices (not just localStorage).
//
// On sign-in it reads GET /api/v1/me (the same call profile.js/me.js make) and applies themeAccent +
// themeSketchy, then refreshes the boot hint so the NEXT cold start paints the right look with no
// flash. On sign-out it resets to the Paper defaults and clears the hint, so a shared device never
// leaks the previous user's accent. Best-effort: a failed /me leaves the boot look in place — the
// appearance is cosmetic and must never break the app.
//
// The profile settings control (appearance-settings.js) drives live CHANGES + persistence; this
// module owns the load-time APPLY. Both go through appearance-core so there is one contract.

import { onAuthChanged, currentUser } from "./auth.js";
import { getMe } from "./api.js";
import {
  applyAppearance,
  writeHint,
  clearHint,
  DEFAULT_ACCENT_ID,
  DEFAULT_SKETCHY,
} from "./appearance-core.js";
import { sessionKey, isResponseCurrent } from "./session-guard-core.js";

function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

onAuthChanged(async (user) => {
  if (!user) {
    // Signed out → Paper defaults (sketchy on + default accent), and drop the hint so the next user
    // on this device starts clean rather than inheriting this account's accent.
    applyAppearance(document, { accentId: DEFAULT_ACCENT_ID, sketchy: DEFAULT_SKETCHY });
    const storage = safeStorage();
    if (storage) clearHint(storage);
    return;
  }
  // TM-720: capture who this sync is FOR. A /me that resolves AFTER the user has signed out (or
  // switched) must be dropped — otherwise it repaints the previous user's accent and rewrites the
  // boot hint the sign-out branch above just cleared, leaking their look onto the shared device.
  const startedFor = sessionKey(user);
  try {
    const me = await getMe();
    if (!isResponseCurrent(startedFor, sessionKey(currentUser()))) return;
    const applied = applyAppearance(document, {
      accentId: me.themeAccent,
      sketchy: me.themeSketchy,
    });
    const storage = safeStorage();
    if (storage) writeHint(storage, applied);
  } catch (err) {
    // A 401 will already have redirected (api.js); anything else we swallow — the boot-hint look
    // stays applied. Appearance is cosmetic; never surface an error or blank the page over it.
    console.warn("[appearance] could not sync appearance from /api/v1/me:", err?.message ?? err);
  }
});
