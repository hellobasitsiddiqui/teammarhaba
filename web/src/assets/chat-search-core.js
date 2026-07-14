// Event-chat search — pure logic core (TM-690, rich-chat wave).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). Following the codebase's core/renderer split (chat-core.js,
// chat-mentions-core.js, chat-linkpreview-core.js), this module holds ONLY the pure, DOM-free logic the
// in-thread search feature needs. It has NO DOM / Firebase / Capacitor imports, so it is import-safe in
// a plain Node test (`node --test web/tools/*.test.mjs`, the CI web gate). The DOM half (the header
// search affordance + results panel) lives in chat.js and imports this.
//
// v1 is WITHIN-THREAD, CLIENT-SIDE: it searches the message array the open thread already holds
// (chat.js `thread.messages`), so it needs no backend, storage, permission or schema change. Because
// that array is exactly what the server returned (soft-deleted / blocked / non-member messages never
// reach it — see ConversationMessageResponse), the results inherit those filters for free.
// Global / full-history / cross-thread search needs a backend index and is a separate ticket.

/** Normalise a raw query: lower-cased, whitespace-collapsed, trimmed. Blank → "". */
export function normalizeQuery(query) {
  return (typeof query === "string" ? query : "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The query split into match tokens (AND semantics). Blank query → []. */
export function queryTokens(query) {
  const n = normalizeQuery(query);
  return n ? n.split(" ") : [];
}

/**
 * Is this thread message a search hit for the given tokens?
 * Only real, jumpable conversation content matches: system notices (no `data-msg-id` anchor),
 * pending optimistic echoes (no server id yet) and empty/bodyless rows are never results. Match is
 * case-insensitive substring, ALL tokens required (AND).
 * @param {{id?:*, body?:string, system?:boolean, pending?:boolean}} message
 * @param {string[]} tokens
 */
export function messageMatches(message, tokens) {
  if (!message || message.system || message.pending || message.id == null) return false;
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  const body = typeof message.body === "string" ? message.body : "";
  if (!body) return false;
  const lc = body.toLowerCase();
  return tokens.every((t) => lc.includes(t));
}

/**
 * Filter a thread's messages to the search hits, preserving their order.
 * @param {Array} messages the thread's message array (chat.js `thread.messages`).
 * @param {string} query the raw search string.
 * @returns {Array} matching messages (empty for a blank query).
 */
export function searchMessages(messages, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  return (Array.isArray(messages) ? messages : []).filter((m) => messageMatches(m, tokens));
}

// Escape a token for safe use inside a RegExp (a query can contain ., *, (, ? …).
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` into alternating {text, hit} segments so a renderer can wrap the hits (e.g. in <mark>)
 * without ever interpreting the body as markup — every segment is emitted as a plain text node by the
 * caller. Case-insensitive; original casing preserved.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {{text:string, hit:boolean}[]}
 */
export function highlightSegments(text, tokens) {
  const src = typeof text === "string" ? text : "";
  const toks = (Array.isArray(tokens) ? tokens : []).filter(Boolean);
  if (!src || !toks.length) return src ? [{ text: src, hit: false }] : [];
  const re = new RegExp("(" + toks.map(escapeRegExp).join("|") + ")", "gi");
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++; // guard against any zero-length match
  }
  if (last < src.length) out.push({ text: src.slice(last), hit: false });
  return out;
}

/**
 * A short one-line excerpt of `body` centred on the first token hit, with … where trimmed. Keeps result
 * rows compact for long messages while showing the match in context. Returns the whole body (trimmed to
 * `max`) when there's no hit.
 * @param {string} body
 * @param {string[]} tokens
 * @param {number} [max=90] target excerpt length.
 */
export function snippet(body, tokens, max = 90) {
  const src = (typeof body === "string" ? body : "").replace(/\s+/g, " ").trim();
  if (src.length <= max) return src;
  const toks = (Array.isArray(tokens) ? tokens : []).filter(Boolean);
  const lc = src.toLowerCase();
  let hit = -1;
  for (const t of toks) {
    const i = lc.indexOf(t);
    if (i !== -1 && (hit === -1 || i < hit)) hit = i;
  }
  if (hit === -1) return src.slice(0, max - 1).trimEnd() + "…";
  const pad = Math.floor((max - (toks[0] ? toks[0].length : 0)) / 2);
  let start = Math.max(0, hit - pad);
  let end = Math.min(src.length, start + max);
  start = Math.max(0, end - max);
  return (start > 0 ? "…" : "") + src.slice(start, end).trim() + (end < src.length ? "…" : "");
}
