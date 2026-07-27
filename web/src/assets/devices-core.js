// Pure "Your devices" view-model (TM-924) — the framework-free decision layer behind the profile
// Security section's device list. Kept in its own -core module (no DOM, no api.js, no Firebase CDN)
// so it can be imported and behaviourally unit-tested under `node --test` (the DOM shell in
// biometric-settings.js is api-coupled and so is only source-guard-tested — same split as
// home-core/home.js and membership-receipts).
//
// This intentionally models what the backend GET /api/v1/me/devices actually returns: the caller's
// PUSH-registered devices ({ id, platform, lastSeen, created }). It is NOT a session registry — a
// browser that never granted notifications has no row — and the copy in the UI says so. The raw push
// token is never sent to the client (it's a sender-usable credential), so there's nothing secret here.

/**
 * Human-readable label for a device platform token (TM-924). The backend stores the DevicePlatform
 * enum by name (ANDROID | IOS | WEB); we map each to friendly copy. An unknown/absent value degrades
 * to a safe generic ("Device") rather than leaking a raw enum token (a papercut we avoid up front).
 *
 * @param {string} platform the raw platform token from the payload
 * @returns {string} the label to show
 */
export function platformLabel(platform) {
  switch (String(platform || "").toUpperCase()) {
    case "ANDROID":
      return "Android device";
    case "IOS":
      return "iPhone or iPad";
    case "WEB":
      return "Web browser";
    default:
      return "Device";
  }
}

/**
 * Normalize one raw device payload row into a stable view-model (TM-924). Tolerant of a partial/odd
 * row: a missing platform still yields the generic label, and the timestamps are passed through as
 * given (the DOM shell renders them via ui.js relativeTime, which itself no-ops on an invalid date).
 *
 * @param {{id?: (number|string), platform?: string, lastSeen?: string, created?: string}} device
 * @returns {{id: (number|string|null), platform: string, platformLabel: string, lastSeen: (string|null), created: (string|null)}}
 */
export function deviceRowView(device) {
  const row = device || {};
  return {
    id: row.id ?? null,
    platform: String(row.platform || "").toUpperCase(),
    platformLabel: platformLabel(row.platform),
    lastSeen: row.lastSeen ?? null,
    created: row.created ?? null,
  };
}

/**
 * Build the ordered list of device row view-models to render (TM-924). Newest-active first —
 * ordered by lastSeen descending — so the device the user is most likely on sits at the top. Tolerant
 * of a non-array payload (null / undefined / a bad body) → an empty list, so the shell paints its
 * honest empty state rather than throwing. A row with no/invalid lastSeen sorts to the end (treated as
 * oldest) instead of poisoning the comparison.
 *
 * @param {Array<object>} devices the raw payload array from GET /me/devices
 * @returns {Array<ReturnType<typeof deviceRowView>>} ordered, normalized rows (possibly empty)
 */
export function deviceListView(devices) {
  if (!Array.isArray(devices)) return [];
  return devices
    .map(deviceRowView)
    .sort((a, b) => lastSeenMillis(b.lastSeen) - lastSeenMillis(a.lastSeen));
}

/** Milliseconds for sort; an absent/invalid stamp is treated as the epoch (sorts last). */
function lastSeenMillis(value) {
  if (value == null) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}
