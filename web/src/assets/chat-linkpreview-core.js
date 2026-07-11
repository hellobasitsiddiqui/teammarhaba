// Chat link previews — pure logic core (TM-470).
//
// When a chat message contains a link, the thread renders a preview card (title / description / image)
// built from the OpenGraph metadata the backend fetches SERVER-SIDE (behind an SSRF guard) via
// GET /api/v1/link-preview?url=… — the browser never makes the outbound request. This module is the
// PURE half of that feature, following the codebase's established core/renderer split (chat-core.js,
// events-core.js …): it holds ONLY the framework-free decisions —
//   • which URL in a message body to preview (firstPreviewableUrl), and
//   • how to normalise the endpoint's response into the small view-model the card renders
//     (normalisePreview) —
// with NO DOM / fetch / Firebase, so it is import-safe in a plain Node test (`node --test
// web/tools/*.test.mjs`, the CI web gate). The DOM half (the delimited `=== TM-470 link preview ===`
// hook that mounts the card + calls the endpoint) lives in chat.js; the network call lives in api.js.
//
// Kept deliberately separate from chat-core.js so it stays out of the way of the sibling @mentions work
// that also touches the chat message path — this feature is self-contained in its own core + its own hook.

/**
 * Matches an http(s) URL run in a message body. Intentionally permissive on the path/query (anything
 * that isn't whitespace or an angle/quote delimiter), because trailing punctuation is stripped
 * afterwards — a URL at the end of a sentence ("see https://ex.com.") must not swallow the full stop.
 */
const URL_RUN = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Trailing characters trimmed off a detected URL: sentence punctuation and an UNBALANCED closing
 * bracket. A closing bracket/paren is only stripped when the URL contains no matching opener, so a
 * legitimately-bracketed path (e.g. a Wikipedia "…_(disambiguation)" link) is preserved.
 */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The first previewable URL in a message body, or `null` when there is none. "Previewable" = an
 * absolute http/https URL (the only schemes the backend will fetch — mirrors its allow-list so we never
 * round-trip a URL it will 400). Trailing sentence punctuation and unbalanced closing brackets are
 * trimmed so the URL we send matches what the user meant to link.
 *
 * <p>Only the FIRST link is previewed (one card per message) — the common case is a single shared link,
 * and one card keeps the thread readable.
 *
 * @param {string} text the raw message body.
 * @returns {string|null} the cleaned URL, or null.
 */
export function firstPreviewableUrl(text) {
  const body = String(text ?? "");
  URL_RUN.lastIndex = 0; // reset the shared global-flagged regex before each scan
  const match = URL_RUN.exec(body);
  if (!match) return null;
  return trimUrl(match[0]);
}

/**
 * Every previewable URL in a message body, de-duplicated, in order of appearance. Retained as a pure
 * primitive (the render hook only needs the first), so a future "preview each link" change has a tested
 * building block. Returns an empty array when there are none.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const body = String(text ?? "");
  URL_RUN.lastIndex = 0;
  const seen = new Set();
  let m;
  while ((m = URL_RUN.exec(body)) !== null) {
    const url = trimUrl(m[0]);
    if (url) seen.add(url);
  }
  return [...seen];
}

/** Trim trailing punctuation / unbalanced brackets off a raw URL run; "" collapses to null. */
function trimUrl(raw) {
  let url = String(raw ?? "").replace(TRAILING_PUNCTUATION, "");
  // Strip a trailing ')' or ']' only when its opener isn't present in the URL (else keep the pair).
  while (url.endsWith(")") || url.endsWith("]")) {
    const close = url[url.length - 1];
    const open = close === ")" ? "(" : "[";
    if (url.includes(open)) break;
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url || null;
}

/**
 * Normalise the backend's link-preview response into the card view-model chat.js renders. The endpoint
 * returns { url, title, description, imageUrl } with any field possibly null. This coerces to clean
 * strings, drops a non-http(s) `imageUrl` as defence-in-depth (the server already resolves images to
 * absolute http(s), but the client must never build an `<img src>` from a `data:`/`javascript:` value it
 * was somehow handed), and computes `hasContent` — the card is only worth drawing when there's a title.
 * Falls back to the requested `url` so the view-model always carries the link it belongs to.
 *
 * @param {?Object} raw the endpoint response (or nullish on failure).
 * @param {string} [requestedUrl] the URL the preview was requested for (fallback for `url`).
 * @returns {{url: string, title: string, description: string, imageUrl: (string|null), hasContent: boolean}}
 */
export function normalisePreview(raw, requestedUrl = "") {
  const src = raw && typeof raw === "object" ? raw : {};
  const url = String(src.url ?? requestedUrl ?? "").trim();
  const title = String(src.title ?? "").trim();
  const description = String(src.description ?? "").trim();
  return {
    url,
    title,
    description,
    imageUrl: safeImageUrl(src.imageUrl),
    hasContent: title.length > 0,
  };
}

/** Keep an image URL only if it's an absolute http(s) URL; anything else becomes null (no <img> drawn). */
function safeImageUrl(value) {
  const src = String(value ?? "").trim();
  return /^https?:\/\//i.test(src) ? src : null;
}
