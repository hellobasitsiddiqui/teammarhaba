// Nav avatar (TM-166). Reflects the signed-in user's Firebase `photoURL` as a small round image in
// the account nav, next to the sign-out control. `photoURL` is the single source of truth (set by the
// avatar upload in storage.js / profile.js and surfaced on GET /me by TM-164) — we read it straight
// off the Firebase `User`, persist nothing, and fall back to an initial glyph when there's no photo.
//
// Kept as its own tiny module (no router/profile import) so both the auth-state bootstrap and the
// profile page can repaint it without an import cycle. XSS-safe: only ever sets `img.src` /
// `textContent` — never innerHTML.

import { onAuthChanged, currentUser } from "./auth.js";

const ID = "nav-avatar";

/** Repaint the nav avatar from the current Firebase user's photoURL. No-op if the element is absent. */
export function paintNavAvatar() {
  if (typeof document === "undefined") return;
  const host = document.getElementById(ID);
  if (!host) return;

  const user = currentUser();
  const url = user?.photoURL || "";
  host.hidden = !user; // only show it when signed in.
  if (!user) return;

  let img = host.querySelector("img");
  if (url) {
    if (!img) {
      img = document.createElement("img");
      img.className = "tm-nav-avatar-img";
      img.alt = "Your avatar";
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(img);
    }
    img.src = url; // assigning .src is XSS-safe (no markup parse).
  } else {
    // No photo yet: show a neutral initial glyph rather than a broken image.
    while (host.firstChild) host.removeChild(host.firstChild);
    const span = document.createElement("span");
    span.className = "tm-nav-avatar-initial";
    span.setAttribute("aria-hidden", "true");
    span.textContent = "🙂";
    host.appendChild(span);
  }
}

// Repaint whenever auth state changes (sign-in/out, reload restore, and after an avatar upload which
// updates the in-memory Firebase user's photoURL — onAuthChanged also fires on profile updates).
onAuthChanged(() => paintNavAvatar());

if (typeof window !== "undefined") {
  window.tmNavAvatar = { paintNavAvatar };
}
