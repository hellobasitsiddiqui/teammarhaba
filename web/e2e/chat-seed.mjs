// First-party chat-seed helper for the chat foundation e2e / evidence (TM-587).
//
// The chat foundation screens (the conversation list TM-438, an open thread TM-448, the unread
// Chat-tab badge TM-439) need SEEDED conversations + messages to render anything — but until posting
// (TM-447) + the admin-broadcast bridge (TM-588) + the event-chat lifecycle (TM-446) landed there was
// no way to populate them for a test user, so the TM-564 evidence had to render against route mocks.
//
// This wraps the profile-gated, non-prod-only seed endpoint (POST /api/v1/test/chat/seed) added by
// TM-587: called with a signed-in account's token it populates THAT account's chat with a couple of
// event group threads + an admin "from TeamMarhaba" channel, each with messages + unread state. So the
// spec (and the capture harness's live mode) can drive the REAL chat.js against a LIVE backend — every
// pixel is production, and so is the data. Idempotent: the endpoint no-ops an already-seeded account,
// so this is safe to call on every run / CI retry.
//
// Style mirrors events-api.mjs: mint an emulator ID token for the account, then call the real
// first-party API with it — identity is the Bearer token, never a request body.

import { AUTH_EMULATOR_HOST, API_BASE_URL } from "./fixtures.mjs";

/** Mint an emulator ID token for an account and return its authed request headers (JSON). */
export async function authHeadersFor({ email, password }) {
  const url =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(`emulator sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const { idToken } = await res.json();
  return {
    Authorization: `Bearer ${idToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Seed the given account's chat via POST /api/v1/test/chat/seed (TM-587). `account` is one of the
 * fixtures (e.g. CHAT_SEED); a fresh emulator token is minted for it so the backend seeds THAT
 * account's own chat. Returns the endpoint's summary
 * ({@code { alreadySeeded, eventThreads, adminThreads, unreadTotal }}).
 *
 * Throws if the endpoint is missing (404) — that means the backend isn't running with
 * app.test-seed.enabled=true (the dev/test profiles set it; prod never does), which is a setup bug the
 * caller should see loudly rather than silently rendering an empty list.
 */
export async function seedChat(account) {
  const headers = await authHeadersFor(account);
  const res = await fetch(`${API_BASE_URL}/api/v1/test/chat/seed`, { method: "POST", headers });
  if (!res.ok) {
    throw new Error(
      `chat seed failed for ${account.email}: ${res.status} ${await res.text()} ` +
        `(is the backend up with app.test-seed.enabled=true?)`,
    );
  }
  return res.json();
}
