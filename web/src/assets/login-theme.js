// Signed-out theme switcher (TM-332). The in-app "Appearance" picker (TM-298) was mounted ONLY on the
// #/profile page, so it was reachable only when signed in — a signed-out user on the login screen (and,
// crucially, inside the Android WebView, where the dev `?theme=` URL override is unreachable) had no way
// to change the theme. This mounts the SAME control (theme-settings.js — same `tm-theme` localStorage
// key, same live `applyTheme`, no reload) into the login card so it's reachable while signed out.
//
// We don't duplicate any theme logic: this is a thin mount of `buildThemeSettings`, with a distinct
// `idSuffix` so its element ids don't collide with the Profile instance (both live in the DOM at once —
// views are hidden, not removed). Both instances read/write the one `tm-theme` key and broadcast changes
// to each other, so they never drift. Boot order is unchanged, so a clean/cleared app still boots in the
// configured default (sketch) — this only adds a way to CHANGE it.
//
// XSS-safe by construction: the whole control is built with the el() kit (textContent only, no innerHTML)
// and only ever writes ALLOWED theme names; we mount it with append. No untrusted string flows in.

import { buildThemeSettings } from "./theme-settings.js";

/** Mount the appearance picker into the login card (once), if the card exists. */
function mount() {
  const card = document.getElementById("auth-signed-out");
  // Idempotent: never double-mount (e.g. if this runs twice). The login instance carries its own id.
  if (!card || document.getElementById("theme-settings-login")) return;
  card.append(buildThemeSettings({ idSuffix: "login" }));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
