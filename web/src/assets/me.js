// Demo wiring for TM-108 / 2.2.3: prove the authenticated API client end-to-end by calling
// GET /api/v1/me once the auth state is known and rendering the caller's identity.
//
// This is intentionally minimal — a demonstration of api.js + auth.js working together, not
// the product UI. The sign-in/out UI is TM-106 and page-level route guards are TM-109; this
// module only reads identity, so it stays out of their way. It renders the backend-verified
// profile into the optional `#me` element (inside TM-106's signed-in card) — distinct from
// TM-106's `#user-email`, which shows the local Firebase user. Does nothing if `#me` is absent.

import { onAuthChanged } from "./auth.js";
import { getMe } from "./api.js";

function render(text) {
  const el = document.getElementById("me");
  if (el) el.textContent = text;
}

// Re-render whenever auth state changes (sign-in, sign-out, token bootstrap on reload).
onAuthChanged(async (user) => {
  if (!user) {
    render("signed out");
    return;
  }
  render("verifying your profile…");
  try {
    const me = await getMe();
    // Friendly, product-quality identity line for the refreshed Home footer (TM-512) — the
    // backend-verified caller, no dev jargon. #me stays the element me.js owns (and the TM-135 tour /
    // TM-255 help spotlight); the raw role is surfaced elsewhere (the ADMIN link / admin console).
    render(`Signed in as ${me.email || me.displayName || me.uid}`);
  } catch (err) {
    // A 401 will already have redirected to login (api.js); anything else we surface quietly.
    render("Could not load your profile.");
    console.warn("[me] GET /api/v1/me failed:", err?.message ?? err);
  }
});
