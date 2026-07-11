// Tests for the pure link-preview core (TM-470): URL detection + response normalisation. Framework-free
// (Node's built-in test runner), picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstPreviewableUrl,
  extractUrls,
  normalisePreview,
} from "../src/assets/chat-linkpreview-core.js";

test("firstPreviewableUrl finds an http(s) URL in a message", () => {
  assert.equal(firstPreviewableUrl("check out https://example.com/post now"), "https://example.com/post");
  assert.equal(firstPreviewableUrl("http://foo.test/x"), "http://foo.test/x");
});

test("firstPreviewableUrl returns null when there is no link", () => {
  assert.equal(firstPreviewableUrl("just some plain text"), null);
  assert.equal(firstPreviewableUrl(""), null);
  assert.equal(firstPreviewableUrl(null), null);
  // Non-http(s) schemes are not previewable (mirrors the backend allow-list).
  assert.equal(firstPreviewableUrl("ftp://foo.test/x"), null);
  assert.equal(firstPreviewableUrl("mailto:a@b.com"), null);
});

test("firstPreviewableUrl strips trailing sentence punctuation", () => {
  assert.equal(firstPreviewableUrl("see https://example.com."), "https://example.com");
  assert.equal(firstPreviewableUrl("(https://example.com/a)"), "https://example.com/a");
  assert.equal(firstPreviewableUrl("here: https://example.com/a, thanks"), "https://example.com/a");
});

test("firstPreviewableUrl keeps a balanced bracket pair in the path", () => {
  assert.equal(
    firstPreviewableUrl("https://en.wikipedia.org/wiki/Foo_(bar)"),
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
});

test("firstPreviewableUrl picks the FIRST link only", () => {
  assert.equal(
    firstPreviewableUrl("https://one.test and https://two.test"),
    "https://one.test",
  );
});

test("extractUrls returns all links, de-duplicated, in order", () => {
  assert.deepEqual(
    extractUrls("https://a.test then https://b.test then https://a.test again"),
    ["https://a.test", "https://b.test"],
  );
  assert.deepEqual(extractUrls("no links here"), []);
});

test("normalisePreview cleans the endpoint response and flags content", () => {
  const preview = normalisePreview({
    url: "https://example.com/post",
    title: "  A Title  ",
    description: "  A description ",
    imageUrl: "https://cdn.example.com/i.png",
  });
  assert.equal(preview.url, "https://example.com/post");
  assert.equal(preview.title, "A Title");
  assert.equal(preview.description, "A description");
  assert.equal(preview.imageUrl, "https://cdn.example.com/i.png");
  assert.equal(preview.hasContent, true);
});

test("normalisePreview treats a title-less response as no content", () => {
  const preview = normalisePreview({ url: "https://example.com/plain", title: null, description: null, imageUrl: null });
  assert.equal(preview.hasContent, false);
  assert.equal(preview.title, "");
  assert.equal(preview.imageUrl, null);
});

test("normalisePreview drops a non-http image url (defence in depth)", () => {
  const preview = normalisePreview({
    url: "https://example.com",
    title: "T",
    imageUrl: "javascript:alert(1)",
  });
  assert.equal(preview.imageUrl, null);
});

test("normalisePreview falls back to the requested url and tolerates junk", () => {
  const preview = normalisePreview(null, "https://requested.test/x");
  assert.equal(preview.url, "https://requested.test/x");
  assert.equal(preview.hasContent, false);
});
