// Unit tests for the pure in-thread chat search core (TM-690, rich-chat v1). Framework-free (Node's
// built-in runner), picked up by the CI glob `node --test web/tools/*.test.mjs`. Covers query
// normalisation, the AND/case-insensitive match rules (excluding system/pending/bodyless rows), the
// order-preserving filter, and the highlight/snippet helpers the results panel renders.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeQuery,
  queryTokens,
  messageMatches,
  searchMessages,
  highlightSegments,
  snippet,
} from "../src/assets/chat-search-core.js";

const msg = (id, body, extra = {}) => ({ id, body, ...extra });

test("normalizeQuery lower-cases, collapses whitespace, trims", () => {
  assert.equal(normalizeQuery("  Willen   LAKE  "), "willen lake");
  assert.equal(normalizeQuery("\tCoffee\n"), "coffee");
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
});

test("queryTokens splits into tokens; blank → []", () => {
  assert.deepEqual(queryTokens("dog walk"), ["dog", "walk"]);
  assert.deepEqual(queryTokens("   "), []);
  assert.deepEqual(queryTokens(undefined), []);
});

test("messageMatches: case-insensitive, ALL tokens (AND)", () => {
  assert.equal(messageMatches(msg(1, "Dog walk at Willen Lake"), queryTokens("dog lake")), true);
  assert.equal(messageMatches(msg(1, "Dog walk at Willen Lake"), queryTokens("dog beach")), false);
  assert.equal(messageMatches(msg(1, "COFFEE & code"), queryTokens("coffee")), true);
});

test("messageMatches excludes system, pending, id-less and bodyless rows", () => {
  const tokens = queryTokens("circle");
  assert.equal(messageMatches(msg(1, "from Circle broadcast", { system: true }), tokens), false);
  assert.equal(messageMatches(msg(null, "Circle pending", { pending: true }), tokens), false);
  assert.equal(messageMatches({ id: null, body: "Circle" }, tokens), false);
  assert.equal(messageMatches(msg(2, ""), queryTokens("anything")), false);
  assert.equal(messageMatches(msg(2, "hi"), []), false, "blank query matches nothing");
});

test("searchMessages returns hits in original order; blank query → []", () => {
  const messages = [
    msg(1, "Bring your dog to Willen Lake"),
    msg(2, "Coffee & code at the Quiet Corner"),
    msg(3, "The dog walk is Saturday"),
    msg(4, "See you there", { system: true }),
    msg(5, "walk starts 10am"),
  ];
  const hits = searchMessages(messages, "walk");
  assert.deepEqual(hits.map((m) => m.id), [3, 5]);
  assert.deepEqual(searchMessages(messages, "  "), []);
  assert.deepEqual(searchMessages(messages, "dog lake").map((m) => m.id), [1]);
});

test("highlightSegments wraps every token hit, preserves original casing", () => {
  const segs = highlightSegments("Dog walk with the dog", queryTokens("dog"));
  assert.deepEqual(segs, [
    { text: "Dog", hit: true },
    { text: " walk with the ", hit: false },
    { text: "dog", hit: true },
  ]);
  // regex-special tokens are escaped, not interpreted
  assert.deepEqual(highlightSegments("a.b", queryTokens(".")), [
    { text: "a", hit: false },
    { text: ".", hit: true },
    { text: "b", hit: false },
  ]);
  assert.deepEqual(highlightSegments("", queryTokens("x")), []);
});

test("snippet trims long bodies around the first hit with ellipses", () => {
  const short = "Dog walk Saturday";
  assert.equal(snippet(short, queryTokens("walk")), short, "short bodies returned whole");
  const long = "x".repeat(120) + " WILLEN lake meetup " + "y".repeat(120);
  const s = snippet(long, queryTokens("willen"), 60);
  assert.ok(s.length <= 62, "excerpt bounded");
  assert.ok(s.toLowerCase().includes("willen"), "excerpt contains the hit");
  assert.ok(s.startsWith("…") && s.endsWith("…"), "ellipses where trimmed");
});
