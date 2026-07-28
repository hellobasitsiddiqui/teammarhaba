// Admin roster page — the pure, browser-free roster math (TM-1115). The DOM/mount half lives in
// admin-events.js; this module holds the merge + 4-state + chip-filter logic so `node --test` can
// assert it without a browser (the event-form.js ↔ admin-events.js split). Consumed by the roster
// page to turn the TM-1114 roster payload (live `entries` + `pastEntries`) into ONE display list of
// rows the page renders, and to filter that list by the include/exclude chip selection with NO refetch.
//
// Backend contract consumed (TM-1114, GET /api/v1/admin/events/{id}/roster):
//   entries:     [{ userId, displayName, state: "GOING"|"WAITLISTED", overCapacity }]  — LIVE attendance
//   pastEntries: [{ userId, displayName, lastState: "EVICTED"|"CANCELLED", at, byAdmin }] — most-recent
//                exit per user, newest-first, EXCLUDING anyone currently live (server-side supersession).

/** The four roster states a row can display. */
export const ROSTER_STATE_GOING = "GOING";
export const ROSTER_STATE_WAITLISTED = "WAITLISTED";
export const ROSTER_STATE_EVICTED = "EVICTED";
export const ROSTER_STATE_CANCELLED = "CANCELLED";

/**
 * The include/exclude filter chips (TM-1115). Each chip toggles whether rows of one state are shown.
 * GOING is deliberately NOT a chip — a live going attendee is ALWAYS shown (the roster's whole point).
 * Defaults per the locked decision: Waitlist ON, Evicted OFF, Cancelled OFF.
 * `key` is the roster state the chip governs; `label` is the chip copy; `defaultOn` seeds the initial set.
 */
export const ROSTER_FILTER_CHIPS = Object.freeze([
  { key: ROSTER_STATE_WAITLISTED, label: "Waitlist", defaultOn: true },
  { key: ROSTER_STATE_EVICTED, label: "Evicted", defaultOn: false },
  { key: ROSTER_STATE_CANCELLED, label: "Cancelled", defaultOn: false },
]);

/** The initial chip selection Set (Waitlist on, Evicted/Cancelled off). Fresh Set per call — never shared. */
export function defaultChipSelection() {
  return new Set(ROSTER_FILTER_CHIPS.filter((c) => c.defaultOn).map((c) => c.key));
}

/** Badge tone/copy per state — the 4-state badge (TM-1115). Going=ok, Waitlist=info, Evicted/Cancelled=off. */
export function rosterStateBadge(state) {
  switch (String(state || "").toUpperCase()) {
    case ROSTER_STATE_GOING:
      return { label: "Going", tone: "ok" };
    case ROSTER_STATE_WAITLISTED:
      return { label: "Waitlist", tone: "info" };
    case ROSTER_STATE_EVICTED:
      return { label: "Evicted", tone: "off" };
    case ROSTER_STATE_CANCELLED:
      return { label: "Cancelled", tone: "off" };
    default:
      return { label: String(state || "Unknown"), tone: "unknown" };
  }
}

/**
 * Merge the roster payload's LIVE `entries` and `pastEntries` into ONE display list (TM-1115), newest
 * intent first: live rows (GOING then WAITLISTED, in server order) come first, then past rows.
 *
 * Supersession: the backend already drops anyone currently live from `pastEntries` (a rejoin => live
 * row only). We mirror that defensively here — a past entry whose userId also has a LIVE row is dropped,
 * so a re-joined user is never double-listed. Instead, that user's live row carries a `history` affordance
 * = their latest past exit (state + timestamp + byAdmin) so "rejoined after evict" reads as a live Going
 * row WITH a history note (locked depth = latest past-state + timestamp per row; full timeline deferred).
 *
 * Each returned row is `{ userId, displayName, state, overCapacity, history }` where:
 *   - `state` is one of the four ROSTER_STATE_* values,
 *   - `overCapacity` is the live over-cap flag (false for a past row),
 *   - `history` is `{ lastState, at, byAdmin }` for a live row that also has a past exit, else null.
 *
 * @param {{entries?: object[], pastEntries?: object[]}} roster the TM-1114 roster payload.
 * @returns {{userId:*, displayName:*, state:string, overCapacity:boolean, history:?object}[]}
 */
export function mergeRosterRows(roster = {}) {
  const live = Array.isArray(roster.entries) ? roster.entries : [];
  const past = Array.isArray(roster.pastEntries) ? roster.pastEntries : [];

  // Index the latest past exit per userId so a live row can pick up its history affordance, and so a
  // past row for a now-live user can be suppressed (supersession).
  const liveIds = new Set(live.map((e) => keyOf(e.userId)));
  const pastByUser = new Map();
  for (const p of past) {
    const k = keyOf(p.userId);
    // `past` is newest-first, so the FIRST time we see a user is their most-recent exit — keep only that.
    if (!pastByUser.has(k)) pastByUser.set(k, p);
  }

  const rows = [];
  for (const e of live) {
    const hist = pastByUser.get(keyOf(e.userId));
    rows.push({
      userId: e.userId,
      displayName: e.displayName,
      state: String(e.state || "").toUpperCase(),
      overCapacity: !!e.overCapacity,
      // A live row that ALSO has a past exit (rejoined-after-evict / rejoined-after-cancel) surfaces its
      // latest past state + timestamp as a history affordance.
      history: hist ? { lastState: String(hist.lastState || "").toUpperCase(), at: hist.at, byAdmin: !!hist.byAdmin } : null,
    });
  }
  // Push ONE past row per user (the most-recent exit — `pastByUser` already collapsed duplicates),
  // preserving the payload's newest-first order, and skipping anyone currently live (their live row
  // already carries the history). Defensive supersession + collapse — correct on any payload.
  const emittedPast = new Set();
  for (const p of past) {
    const k = keyOf(p.userId);
    if (liveIds.has(k)) continue; // superseded by a live row
    if (emittedPast.has(k)) continue; // already emitted this user's most-recent exit
    emittedPast.add(k);
    const exit = pastByUser.get(k); // the most-recent exit for this user
    rows.push({
      userId: exit.userId,
      displayName: exit.displayName,
      state: String(exit.lastState || "").toUpperCase(),
      overCapacity: false,
      at: exit.at,
      byAdmin: !!exit.byAdmin,
      history: null,
    });
  }
  return rows;
}

/** Stable key for a userId (string vs number safe) used for de-dup / supersession lookups. */
function keyOf(userId) {
  return String(userId);
}

/**
 * Filter merged rows by the include/exclude chip selection (TM-1115) — CLIENT-SIDE, NO REFETCH. GOING is
 * always kept (never chip-gated). A WAITLISTED / EVICTED / CANCELLED row is kept only if its state is in
 * the selected chip Set. An unknown state is always kept (fail-open — never silently hide data).
 *
 * @param {object[]} rows the merged rows from {@link mergeRosterRows}.
 * @param {Set<string>|string[]|null|undefined} selected the enabled chip state keys.
 * @returns {object[]} the visible subset (same order).
 */
export function filterRosterRows(rows = [], selected) {
  const set = selected instanceof Set ? selected : new Set(Array.isArray(selected) ? selected : []);
  const gated = new Set(ROSTER_FILTER_CHIPS.map((c) => c.key)); // WAITLISTED / EVICTED / CANCELLED
  return rows.filter((r) => {
    const state = String(r.state || "").toUpperCase();
    if (state === ROSTER_STATE_GOING) return true; // always shown
    if (!gated.has(state)) return true; // unknown state → fail-open
    return set.has(state);
  });
}
