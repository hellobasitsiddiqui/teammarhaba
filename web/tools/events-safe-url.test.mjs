// External-URL scheme guard for admin-supplied event links (TM-722, TM-655 LOW web-security).
// Framework-free — Node's built-in test runner (`node --test web/tools/*.test.mjs`).
//
// Admin-supplied `onlineUrl` / curated venue `mapUrl` are rendered as a raw anchor `href`. Without a
// scheme check a `javascript:`/`data:` value would execute / navigate on click (stored-XSS / open-nav
// via the admin console). safeExternalUrl accepts ONLY absolute http(s) URLs; everything else → null,
// and locationView/directionsUrl neutralise the bad value so the caller renders no dangerous link.

import assert from "node:assert/strict";
import { test } from "node:test";
import { safeExternalUrl, locationView, directionsUrl } from "../src/assets/events-core.js";

test("http(s) absolute URLs pass through unchanged (trimmed)", () => {
  assert.equal(safeExternalUrl("https://maps.example/x"), "https://maps.example/x");
  assert.equal(safeExternalUrl("http://meet.example/room"), "http://meet.example/room");
  assert.equal(safeExternalUrl("  https://ex.com/a  "), "https://ex.com/a");
});

test("SECURITY: dangerous / non-http schemes are neutralised to null", () => {
  for (const u of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeExternalUrl(u), null, `must reject ${JSON.stringify(u)}`);
  }
});

test("relative / scheme-relative / empty / non-string values are null (not rendered as external links)", () => {
  for (const u of ["/relative/path", "//evil.example/x", "", "   ", null, undefined, 42, {}]) {
    assert.equal(safeExternalUrl(u), null, `must reject ${JSON.stringify(u)}`);
  }
});

test("locationView neutralises a javascript: onlineUrl/mapUrl at the single source (revealed)", () => {
  const view = locationView({
    locationRevealed: true,
    locationText: "The Hall, 1 High St",
    onlineUrl: "javascript:alert(document.cookie)",
    mapUrl: "javascript:alert(1)",
  });
  assert.equal(view.onlineUrl, null);
  assert.equal(view.mapUrl, null);
});

test("locationView keeps a legitimate https onlineUrl/mapUrl", () => {
  const view = locationView({
    locationRevealed: true,
    locationText: "The Hall",
    onlineUrl: "https://meet.example/abc",
    mapUrl: "https://maps.example/place/1",
  });
  assert.equal(view.onlineUrl, "https://meet.example/abc");
  assert.equal(view.mapUrl, "https://maps.example/place/1");
});

test("directionsUrl refuses a dangerous curated mapUrl and falls back to a safe query link", () => {
  // A javascript: mapUrl must NOT be returned verbatim; with a query present it builds the safe web link.
  const href = directionsUrl({ mapUrl: "javascript:alert(1)", query: "1 High St" }, "WEB");
  assert.ok(href.startsWith("https://www.google.com/maps/search/"), `got ${href}`);
  // A legitimate curated link still wins.
  assert.equal(
    directionsUrl({ mapUrl: "https://maps.example/x", query: "ignored" }, "WEB"),
    "https://maps.example/x",
  );
});
