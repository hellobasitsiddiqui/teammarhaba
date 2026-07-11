// Event-chat @mentions — pure logic core (TM-469, epic Event Chat wave-4).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView), and — following the codebase's core/renderer split (chat-core.js,
// events-core.js, notifications-core.js) — this module holds ONLY the pure, DOM-free logic the
// @mention feature needs. It has NO DOM / Firebase / Capacitor imports, so it is import-safe in a plain
// Node test (`node --test web/tools/*.test.mjs`, the CI web gate). The DOM half (the composer
// autocomplete dropdown + the in-message highlight) lives in chat.js and imports this.
//
// It does two jobs, both from the message TEXT (there is no stored mention table — the backend
// re-parses the committed body to notify, and the client re-parses it to highlight, so both agree):
//
//   1. PARSE — turn a posted body + the thread roster into "who was mentioned" ({@link parseMentions})
//      and into render segments ({@link mentionSegments}) so the thread view can highlight the chips.
//      This mirrors the backend `MentionResolver` byte-for-byte (same keywords, same longest-name /
//      word-boundary / '@'-token-start rules) so the highlight can never disagree with the notify.
//   2. COMPOSE — detect the active `@token` under the caret ({@link detectMentionQuery}), rank the
//      autocomplete candidates ({@link mentionCandidates}: @everyone / @here + matching members), and
//      splice a chosen candidate back into the draft ({@link applyMention}).
//
// The two reserved keywords match the backend's MentionResolver.EVERYONE / HERE.
export const MENTION_EVERYONE = "everyone";
export const MENTION_HERE = "here";

// A "name/word" character for boundary detection: any Unicode letter or digit — the JS twin of the
// backend's Character.isLetterOrDigit. Whitespace and punctuation are boundaries, so a mention can be
// followed by ,/!/)/space/end without swallowing them, and a member name is never matched inside a
// longer word (so "@Alicia" never resolves member "Alice").
const NAME_CHAR = /[\p{L}\p{N}]/u;
function isNameChar(ch) {
  return ch != null && NAME_CHAR.test(ch);
}

// Normalise a roster into the entries the parser matches against — { userId, displayName } with a
// non-blank name, sorted LONGEST NAME FIRST so "Ali Hassan" wins over "Ali" when both could start at
// the same '@'. A blank/absent name can't be typed as a token, so it's dropped (it would match a bare
// "@"). Accepts the API's ConversationMemberResponse shape directly.
function mentionableRoster(roster) {
  return (roster || [])
    .filter((m) => m && m.userId != null && typeof m.displayName === "string" && m.displayName.trim() !== "")
    .map((m) => ({ userId: m.userId, displayName: m.displayName }))
    .sort((a, b) => b.displayName.length - a.displayName.length);
}

// Whether `body` at `start` equals `token` (case-insensitive) AND ends on a word boundary — the shared
// core of keyword and member matching (the backend's regionMatchesBoundary). An empty token never
// matches.
function matchesAt(body, start, token) {
  const len = token.length;
  if (len === 0 || start + len > body.length) return false;
  if (body.slice(start, start + len).toLowerCase() !== token.toLowerCase()) return false;
  const end = start + len;
  return end === body.length || !isNameChar(body[end]);
}

// An '@' at `index` only begins a mention token when it is at the start of the body or follows a
// non-word character (whitespace/punctuation). This is what stops an email address (alice@example.com)
// or a mid-word '@' from parsing as a mention. Mirrors the backend's startsToken.
function startsToken(body, index) {
  return index === 0 || !isNameChar(body[index - 1]);
}

/**
 * The low-level scan: walk `body` left-to-right and return each mention as a span
 * `{ start, end, kind, userId? }`, where `kind` is "everyone" | "here" | "user" and `[start, end)` is
 * the slice of the body the mention occupies (INCLUDING the leading '@'). Reserved keywords are checked
 * before member names, so `@everyone` always wins over a member literally named "everyone". This is the
 * single source both {@link parseMentions} and {@link mentionSegments} build on, so "who to notify" and
 * "what to highlight" can't drift.
 * @param {string} body the message text.
 * @param {{userId:number|string, displayName:string}[]} roster the thread's mentionable members.
 * @returns {{start:number,end:number,kind:string,userId?:(number|string)}[]} matches in body order.
 */
export function scanMentions(body, roster) {
  if (typeof body !== "string" || body === "") return [];
  const members = mentionableRoster(roster);
  const spans = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body[i] !== "@" || !startsToken(body, i)) {
      i++;
      continue;
    }
    const after = i + 1; // first char past the '@'
    if (matchesAt(body, after, MENTION_EVERYONE)) {
      spans.push({ start: i, end: after + MENTION_EVERYONE.length, kind: "everyone" });
      i = after + MENTION_EVERYONE.length;
      continue;
    }
    if (matchesAt(body, after, MENTION_HERE)) {
      spans.push({ start: i, end: after + MENTION_HERE.length, kind: "here" });
      i = after + MENTION_HERE.length;
      continue;
    }
    // Longest name first (roster is pre-sorted), so the two-word member wins where a shorter name would
    // also match the opening letters.
    const hit = members.find((m) => matchesAt(body, after, m.displayName));
    if (hit) {
      spans.push({ start: i, end: after + hit.displayName.length, kind: "user", userId: hit.userId });
      i = after + hit.displayName.length;
      continue;
    }
    i++; // a bare '@' or an unknown name — leave it as plain text
  }
  return spans;
}

/**
 * Parse `body` against the thread `roster`, returning which keywords fired and the individually-
 * mentioned member ids — the client mirror of the backend's notify resolution (an individual resolves
 * ONLY to a roster member; a non-member name is ignored). Ids are de-duplicated (a name typed twice
 * counts once) in first-seen order.
 * @returns {{everyone:boolean, here:boolean, userIds:(number|string)[]}}
 */
export function parseMentions(body, roster) {
  const spans = scanMentions(body, roster);
  let everyone = false;
  let here = false;
  const userIds = [];
  for (const span of spans) {
    if (span.kind === "everyone") everyone = true;
    else if (span.kind === "here") here = true;
    else if (span.kind === "user" && !userIds.includes(span.userId)) userIds.push(span.userId);
  }
  return { everyone, here, userIds };
}

/**
 * Split `body` into an ordered list of render segments so the thread view can highlight mention chips
 * without a wholesale renderer rewrite: a run of plain `{ type: "text", text }` interleaved with
 * `{ type: "mention", kind, label, userId? }`, where `label` is the exact matched slice (e.g.
 * "@everyone", "@Alice") — so the DOM layer just builds a text node or a highlighted span per segment
 * (all via textContent, so it stays XSS-safe). Concatenating every segment's text/label reproduces the
 * original body exactly.
 * @returns {({type:"text",text:string}|{type:"mention",kind:string,label:string,userId?:(number|string)})[]}
 */
export function mentionSegments(body, roster) {
  if (typeof body !== "string" || body === "") return [];
  const spans = scanMentions(body, roster);
  if (spans.length === 0) return [{ type: "text", text: body }];
  const segments = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ type: "text", text: body.slice(cursor, span.start) });
    const seg = { type: "mention", kind: span.kind, label: body.slice(span.start, span.end) };
    if (span.kind === "user") seg.userId = span.userId;
    segments.push(seg);
    cursor = span.end;
  }
  if (cursor < body.length) segments.push({ type: "text", text: body.slice(cursor) });
  return segments;
}

/**
 * Detect the active @mention token the caret sits in, for driving the composer autocomplete: from the
 * caret walk back over non-whitespace until an '@' that begins a token, and return
 * `{ query, start, end }` where `query` is the text between that '@' and the caret and `[start, end)`
 * spans the "@query" to replace on selection. Returns `null` when the caret isn't inside a live mention
 * token (no '@', or the token was broken by whitespace, or the '@' is mid-word like an email). A bare
 * "@" (empty query) is a valid trigger — the dropdown then offers everything.
 * @param {string} text the current draft.
 * @param {number} [caret] the caret index (defaults to end of text).
 * @returns {{query:string,start:number,end:number}|null}
 */
export function detectMentionQuery(text, caret) {
  if (typeof text !== "string") return null;
  const at = caret == null ? text.length : Math.max(0, Math.min(caret, text.length));
  let i = at - 1;
  // Walk back over the token run; a space breaks it (multi-word names are chosen from the list, not
  // typed through — the query itself is a single run of non-space chars).
  while (i >= 0 && !/\s/.test(text[i]) && text[i] !== "@") i--;
  if (i < 0 || text[i] !== "@") return null;
  if (!startsToken(text, i)) return null; // mid-word '@' (e.g. an email) is not a mention trigger
  return { query: text.slice(i + 1, at), start: i, end: at };
}

/**
 * Rank the autocomplete candidates for a mention `query` (the run after '@'): the reserved
 * `@everyone` / `@here` group targets first (when the query is a prefix of the keyword), then the
 * roster members whose display name matches the query — a case-insensitive PREFIX match ranks above a
 * looser substring match, then alphabetical — capped at `limit`. Each candidate is
 * `{ kind, name, userId? }`, where `kind` is "everyone" | "here" | "user" and `name` is the token text
 * inserted after '@' ({@link applyMention} builds the final "@name "). An empty query offers the group
 * targets + the whole roster.
 * @param {{userId:number|string, displayName:string}[]} roster the thread's mentionable members.
 * @param {string} query the text typed after '@'.
 * @param {{online?:boolean, limit?:number}} [opts] `online` gates whether @here is offered; `limit` caps results.
 * @returns {{kind:string, name:string, userId?:(number|string)}[]}
 */
export function mentionCandidates(roster, query, { online = true, limit = 8 } = {}) {
  const q = (query || "").toLowerCase();
  const out = [];

  // Group targets first — offered when the typed query is a prefix of the keyword.
  if (MENTION_EVERYONE.startsWith(q)) out.push({ kind: "everyone", name: MENTION_EVERYONE });
  if (online && MENTION_HERE.startsWith(q)) out.push({ kind: "here", name: MENTION_HERE });

  // Members: prefix matches before substring matches, each alpha within its band.
  const members = mentionableRoster(roster).map((m) => ({ kind: "user", name: m.displayName, userId: m.userId }));
  const prefix = [];
  const substring = [];
  for (const m of members) {
    const name = m.name.toLowerCase();
    if (q === "" || name.startsWith(q)) prefix.push(m);
    else if (name.includes(q)) substring.push(m);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  prefix.sort(byName);
  substring.sort(byName);

  return out.concat(prefix, substring).slice(0, limit);
}

/**
 * Splice a chosen `candidate` into `text`, replacing the detected `range` ("@query") with the full
 * "@name " token (a trailing space so the user keeps typing after the chip). Returns the new draft and
 * the caret position just after the inserted token.
 * @param {string} text the current draft.
 * @param {{start:number,end:number}} range the token span from {@link detectMentionQuery}.
 * @param {{name:string}} candidate the chosen candidate from {@link mentionCandidates}.
 * @returns {{text:string, caret:number}}
 */
export function applyMention(text, range, candidate) {
  const insert = "@" + candidate.name + " ";
  const next = text.slice(0, range.start) + insert + text.slice(range.end);
  return { text: next, caret: range.start + insert.length };
}
