// Chat moderation — pure logic core (TM-449, app-admin-only thread moderation).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). Following the codebase's established core/renderer split (chat-core.js,
// events-core.js, notifications-core.js — see AGENTIC-LESSONS "extract the pure logic to test it"),
// this module holds ONLY the pure decisions a moderator UI needs against the TM-449 admin endpoints,
// with NO DOM / Firebase / Capacitor imports, so it is import-safe in a plain Node test
// (`node --test web/tools/*.test.mjs`, the CI web-build gate).
//
// WHY A CORE AHEAD OF THE DOM: the interactive moderator affordance lives in the thread UI, whose DOM
// shell (chat.js) is being reworked in parallel by TM-445 — so wiring buttons there now would collide.
// This module lands the tested client contract first (the same way chat-core.js shipped `pickReaction`
// / `receiptState` as pure utils for a later reactions ticket), so whichever ticket mounts the control
// reads ONE tested source for the paths, the mute options and the failure handling rather than
// re-deriving them inline. The endpoints are already live + covered by backend integration tests.
//
// Backend contract (see web/src/api-docs/openapi.json, ChatModerationAdminController):
//   • POST /api/v1/admin/conversations/{conversationId}/messages/{messageId}/remove
//       → soft-deletes the message; it drops out of every timeline read. Idempotent.
//   • POST /api/v1/admin/conversations/{conversationId}/members/{userId}/mute   body { state }
//       → sets the member's mute state (READ_ONLY / REMOVED / NONE). Muting never changes their RSVP.
// Both are gated ADMIN-only server-side; this module's canModerate() is only a UI affordance gate, the
// backend stays the real authority.

/** The `/api/v1` prefix every app endpoint carries (mirrors the other web callers). */
const API_PREFIX = "/api/v1";

/**
 * The mute / removal choices a moderator picks from, per the AC's "moderator chooses per case". The
 * order is the natural escalation (mute → remove) with reinstate last. `value` is the exact backend
 * MuteState enum name sent in the request body; `label` + `description` are the UI copy.
 * Frozen so a consumer can render the options straight from one source of truth.
 * @type {ReadonlyArray<{value: "READ_ONLY"|"REMOVED"|"NONE", label: string, description: string}>}
 */
export const MODERATION_MUTE_OPTIONS = Object.freeze([
  Object.freeze({
    value: "READ_ONLY",
    label: "Mute (read-only)",
    description: "Can still read the thread, but can no longer post.",
  }),
  Object.freeze({
    value: "REMOVED",
    label: "Remove from thread",
    description: "Loses access to the thread. Their event RSVP is unchanged — they're still going.",
  }),
  Object.freeze({
    value: "NONE",
    label: "Reinstate",
    description: "Restores full access — can read and post again.",
  }),
]);

/** The set of accepted mute-state values, derived from the options so the two never drift. */
const MUTE_VALUES = Object.freeze(new Set(MODERATION_MUTE_OPTIONS.map((o) => o.value)));

/**
 * Whether to SHOW moderator controls at all, from the caller's resolved role (auth.js resolves the
 * ID-token `role` claim, upper-cased, e.g. "ADMIN" / "USER"). App-admins only — an event host is not an
 * app admin, so their thread role is irrelevant here (matching the backend gate: hasRole('ADMIN')).
 * This is a UI affordance only; the backend independently enforces the same gate.
 * @param {string|{role?: string}} roleOrProfile the resolved role string, or an object carrying `.role`.
 * @returns {boolean}
 */
export function canModerate(roleOrProfile) {
  const role = typeof roleOrProfile === "string" ? roleOrProfile : roleOrProfile?.role;
  return String(role ?? "").toUpperCase() === "ADMIN";
}

/** Encode a path segment so a non-numeric / unexpected id can't break the URL. */
function seg(id) {
  return encodeURIComponent(String(id ?? ""));
}

/**
 * Build the "remove a message" endpoint path for a conversation + message.
 * @param {string|number} conversationId
 * @param {string|number} messageId
 * @returns {string} e.g. "/api/v1/admin/conversations/42/messages/7/remove"
 */
export function removeMessagePath(conversationId, messageId) {
  return `${API_PREFIX}/admin/conversations/${seg(conversationId)}/messages/${seg(messageId)}/remove`;
}

/**
 * Build the "mute a member" endpoint path for a conversation + member.
 * @param {string|number} conversationId
 * @param {string|number} userId
 * @returns {string} e.g. "/api/v1/admin/conversations/42/members/9/mute"
 */
export function muteMemberPath(conversationId, userId) {
  return `${API_PREFIX}/admin/conversations/${seg(conversationId)}/members/${seg(userId)}/mute`;
}

/**
 * Build the JSON body for the mute endpoint, validating the chosen state up-front so a bad value never
 * reaches the network (the backend would 400 it anyway). Throws on an unknown state — a programming
 * error at the call site, not a user error.
 * @param {"READ_ONLY"|"REMOVED"|"NONE"} state
 * @returns {{state: string}}
 */
export function muteRequestBody(state) {
  const value = String(state ?? "");
  if (!MUTE_VALUES.has(value)) {
    throw new Error(`Unknown mute state: ${value}`);
  }
  return { state: value };
}

/**
 * Map a FAILED moderation call ({@link ApiError} with `.status` + backend `.message`) to a UI outcome,
 * so the moderation surface shows one consistent, tested reason rather than re-deriving it per call:
 *   • 401 / 403 → not permitted (the caller isn't an app admin, or their session lapsed) — the control
 *                 shouldn't have shown; surface it and hide the control.
 *   • 404       → the message / member / thread is gone (already removed, or a stale view) → refresh.
 *   • anything else (5xx / network) → transient, safe to retry.
 * The backend's own copy is preferred as the message when present (it's already user-facing).
 * @param {{status?: number, message?: string}} error
 * @returns {{permitted: boolean, transient: boolean, reasonKey: string, message: string}}
 */
export function classifyModerationError(error) {
  const status = Number(error?.status) || 0;
  const raw = String(error?.message ?? "").trim();
  if (status === 401 || status === 403) {
    return {
      permitted: false,
      transient: false,
      reasonKey: "forbidden",
      message: raw || "You do not have permission to moderate this thread.",
    };
  }
  if (status === 404) {
    return {
      permitted: true,
      transient: false,
      reasonKey: "gone",
      message: raw || "That message or member is no longer here. Refresh and try again.",
    };
  }
  return {
    permitted: true,
    transient: true,
    reasonKey: "transient",
    message: "Couldn't complete that action. Please try again.",
  };
}
