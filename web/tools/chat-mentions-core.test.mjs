// Unit tests for the pure @mention core (TM-469) — the client twin of the backend's
// MentionResolverTest. Framework-free (Node's built-in runner), picked up by the CI glob
// `node --test web/tools/*.test.mjs`. Covers the AC's parse rules (individual resolve, @everyone/@here,
// non-member ignored) PLUS the compose-side autocomplete helpers (detect / rank / apply).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MENTION_EVERYONE,
  MENTION_HERE,
  parseMentions,
  mentionSegments,
  detectMentionQuery,
  mentionCandidates,
  applyMention,
} from "../src/assets/chat-mentions-core.js";

const ROSTER = [
  { userId: 1, displayName: "Alice" },
  { userId: 2, displayName: "Bob" },
  { userId: 3, displayName: "Ali Hassan" },
];

// ── parseMentions ────────────────────────────────────────────────────────────────────────────────

test("parseMentions resolves an individual to their member id", () => {
  const r = parseMentions("hey @Alice can you make it?", ROSTER);
  assert.deepEqual(r, { everyone: false, here: false, userIds: [1] });
});

test("parseMentions is case-insensitive", () => {
  assert.deepEqual(parseMentions("@alice hi", ROSTER).userIds, [1]);
  assert.deepEqual(parseMentions("@BOB hi", ROSTER).userIds, [2]);
});

test("parseMentions fires @everyone and @here keywords", () => {
  assert.equal(parseMentions("listen @everyone!", ROSTER).everyone, true);
  assert.equal(parseMentions("who's around @here?", ROSTER).here, true);
});

test("parseMentions ignores a non-member name", () => {
  const r = parseMentions("hi @Dave and @Zoe", ROSTER);
  assert.deepEqual(r, { everyone: false, here: false, userIds: [] });
});

test("parseMentions matches the longest name when two share a prefix", () => {
  assert.deepEqual(parseMentions("thanks @Ali Hassan", ROSTER).userIds, [3]);
});

test("parseMentions only matches a name at a word boundary", () => {
  // "@Alicia" must NOT resolve member "Alice" — the next char 'i' is a letter.
  assert.deepEqual(parseMentions("@Alicia is new", ROSTER).userIds, []);
});

test("parseMentions resolves a name followed by punctuation", () => {
  assert.deepEqual(parseMentions("cc @Alice, @Bob!", ROSTER).userIds, [1, 2]);
});

test("parseMentions does not treat a mid-word @ (email) as a mention", () => {
  assert.deepEqual(parseMentions("mail me at alice@example.com", ROSTER).userIds, []);
});

test("parseMentions de-duplicates a name typed twice", () => {
  assert.deepEqual(parseMentions("@Alice @Alice you there", ROSTER).userIds, [1]);
});

test("parseMentions combines a keyword and an individual", () => {
  const r = parseMentions("@everyone especially @Bob", ROSTER);
  assert.equal(r.everyone, true);
  assert.deepEqual(r.userIds, [2]);
});

test("parseMentions on empty / mention-free text resolves to nothing", () => {
  assert.deepEqual(parseMentions("", ROSTER).userIds, []);
  assert.deepEqual(parseMentions("no mentions here", ROSTER), { everyone: false, here: false, userIds: [] });
});

// ── mentionSegments (render highlight) ───────────────────────────────────────────────────────────

test("mentionSegments splits text and mention runs, reproducing the body", () => {
  const body = "hi @Alice and @everyone!";
  const segs = mentionSegments(body, ROSTER);
  assert.deepEqual(segs, [
    { type: "text", text: "hi " },
    { type: "mention", kind: "user", label: "@Alice", userId: 1 },
    { type: "text", text: " and " },
    { type: "mention", kind: "everyone", label: "@everyone" },
    { type: "text", text: "!" },
  ]);
  // Concatenating every segment reproduces the original body exactly (lossless).
  const rebuilt = segs.map((s) => s.text ?? s.label).join("");
  assert.equal(rebuilt, body);
});

test("mentionSegments returns a single text segment when there are no mentions", () => {
  assert.deepEqual(mentionSegments("plain text", ROSTER), [{ type: "text", text: "plain text" }]);
});

// ── detectMentionQuery (composer trigger) ────────────────────────────────────────────────────────

test("detectMentionQuery finds the active token under the caret", () => {
  const text = "hey @Ali";
  assert.deepEqual(detectMentionQuery(text, text.length), { query: "Ali", start: 4, end: 8 });
});

test("detectMentionQuery treats a bare @ as an empty-query trigger", () => {
  assert.deepEqual(detectMentionQuery("hey @", 5), { query: "", start: 4, end: 5 });
});

test("detectMentionQuery returns null when the token is broken by a space", () => {
  assert.equal(detectMentionQuery("hey @Ali went", 13), null);
});

test("detectMentionQuery returns null for a mid-word @ (email)", () => {
  const text = "alice@example";
  assert.equal(detectMentionQuery(text, text.length), null);
});

// ── mentionCandidates (autocomplete ranking) ─────────────────────────────────────────────────────

test("mentionCandidates offers group targets first, then prefix-matching members", () => {
  const c = mentionCandidates(ROSTER, "");
  assert.equal(c[0].kind, "everyone");
  assert.equal(c[1].kind, "here");
  // All three members follow (empty query = whole roster), alphabetical.
  assert.deepEqual(
    c.filter((x) => x.kind === "user").map((x) => x.name),
    ["Ali Hassan", "Alice", "Bob"],
  );
});

test("mentionCandidates narrows to a member query", () => {
  const c = mentionCandidates(ROSTER, "bo");
  assert.deepEqual(c.map((x) => x.name), ["Bob"]); // no keyword prefix matches "bo"; only Bob
});

test("mentionCandidates still offers @everyone while the query is its prefix", () => {
  const c = mentionCandidates(ROSTER, "ever");
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "everyone");
  assert.equal(c[0].name, MENTION_EVERYONE);
});

test("mentionCandidates omits @here when online presence is unavailable", () => {
  const c = mentionCandidates(ROSTER, "", { online: false });
  assert.ok(!c.some((x) => x.kind === "here"));
  assert.equal(c[0].kind, "everyone");
});

test("mentionCandidates respects the result limit", () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ userId: i + 10, displayName: `User${String(i).padStart(2, "0")}` }));
  assert.equal(mentionCandidates(big, "user", { limit: 5 }).length, 5);
});

// ── applyMention (splice back into draft) ────────────────────────────────────────────────────────

test("applyMention replaces the token with the full @name and a trailing space", () => {
  const text = "hey @Ali";
  const range = detectMentionQuery(text, text.length);
  const result = applyMention(text, range, { kind: "user", name: "Ali Hassan", userId: 3 });
  assert.equal(result.text, "hey @Ali Hassan ");
  assert.equal(result.caret, result.text.length);
  // Round-trip: the spliced draft now parses to that member.
  assert.deepEqual(parseMentions(result.text, ROSTER).userIds, [3]);
});

test("applyMention inserts a group keyword", () => {
  const text = "@e";
  const range = detectMentionQuery(text, text.length);
  const result = applyMention(text, range, { kind: "everyone", name: MENTION_EVERYONE });
  assert.equal(result.text, "@everyone ");
  assert.equal(parseMentions(result.text, ROSTER).everyone, true);
});
