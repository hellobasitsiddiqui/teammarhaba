// Unit tests (TM-444) for the pure admin sent-history core — the shape/format/paging helpers for the
// #/admin/messages list, asserted without a browser (the broadcast.js / admin-messages-core.js split).
// Runs on the PR gate via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PAGE_SIZE,
  audienceTypeLabel,
  formatRecipientCount,
  audienceSummary,
  audienceRefDetail,
  statusBadge,
  messageBodyState,
  normalisePageResponse,
  hasPrevPage,
  hasNextPage,
  clampPage,
  pageIndicator,
  rangeIndicator,
  isEmptyHistory,
} from "../src/assets/admin-sent-history-core.js";
import { recallControlModel, RECALL_LABEL, RECALLED_LABEL } from "../src/assets/admin-message-recall-core.js";

// A representative history row (USER target) each test tweaks — mirrors AdminSentHistoryResponse.
const row = (over = {}) => ({
  id: 42,
  sentAt: "2026-07-01T10:00:00Z",
  sentByUid: "admin-uid",
  title: "Venue changed",
  deepLink: "#/events/7",
  audienceType: "USER",
  audienceRef: "3, 7, 9",
  recipientCount: 3,
  status: "SENT",
  ...over,
});

test("DEFAULT_PAGE_SIZE is a sane small page", () => {
  assert.ok(DEFAULT_PAGE_SIZE > 0 && DEFAULT_PAGE_SIZE <= 50);
});

// The recall control is mounted per sent-history row (TM-734). These assert the exact row shape the
// list read projects drives the shared recall-core correctly — a live row offers recall, a RECALLED
// row shows the terminal state — which is what admin-sent-history.js's rowDetail now renders.
test("a live sent-history row (status SENT) offers recall from its detail (TM-734)", () => {
  const model = recallControlModel(row({ status: "SENT" }));
  assert.equal(model.canRecall, true);
  assert.equal(model.label, RECALL_LABEL);
});

test("a recalled sent-history row (status RECALLED) shows the terminal state, no re-recall (TM-734)", () => {
  const model = recallControlModel(row({ status: "RECALLED" }));
  assert.equal(model.recalled, true);
  assert.equal(model.canRecall, false);
  assert.equal(model.label, RECALLED_LABEL);
});

test("audienceTypeLabel maps the three dimensions and falls back for the unknown", () => {
  assert.equal(audienceTypeLabel("USER"), "People");
  assert.equal(audienceTypeLabel("CITY"), "City");
  assert.equal(audienceTypeLabel("EVENT"), "Event attendees");
  // Case-insensitive on the wire value.
  assert.equal(audienceTypeLabel("city"), "City");
  // Unknown / absent → neutral label, never blank.
  assert.equal(audienceTypeLabel("BROADCAST"), "Audience");
  assert.equal(audienceTypeLabel(undefined), "Audience");
  assert.equal(audienceTypeLabel(null), "Audience");
});

test("formatRecipientCount pluralises and floors bad counts to 0", () => {
  assert.equal(formatRecipientCount(1), "1 recipient");
  assert.equal(formatRecipientCount(42), "42 recipients");
  assert.equal(formatRecipientCount(0), "0 recipients");
  assert.equal(formatRecipientCount(-5), "0 recipients");
  assert.equal(formatRecipientCount("nope"), "0 recipients");
  assert.equal(formatRecipientCount(undefined), "0 recipients");
});

test("audienceSummary shows the city for a CITY send and counts for USER/EVENT", () => {
  assert.equal(audienceSummary(row({ audienceType: "CITY", audienceRef: "London" })), "City · London");
  assert.equal(audienceSummary(row({ audienceType: "USER", recipientCount: 12 })), "People · 12 recipients");
  assert.equal(
    audienceSummary(row({ audienceType: "EVENT", audienceRef: "12, 15", recipientCount: 40 })),
    "Event attendees · 40 recipients",
  );
});

test("audienceSummary tolerates a blank city ref and an unknown type", () => {
  assert.equal(audienceSummary(row({ audienceType: "CITY", audienceRef: "  " })), "City");
  assert.equal(audienceSummary(row({ audienceType: "WAT", recipientCount: 1 })), "Audience · 1 recipient");
});

test("audienceRefDetail labels the ref per dimension and blanks to a dash", () => {
  assert.deepEqual(audienceRefDetail(row({ audienceType: "USER", audienceRef: "3, 7, 9" })), {
    label: "Recipient IDs",
    value: "3, 7, 9",
  });
  assert.deepEqual(audienceRefDetail(row({ audienceType: "CITY", audienceRef: "London" })), {
    label: "City",
    value: "London",
  });
  assert.deepEqual(audienceRefDetail(row({ audienceType: "EVENT", audienceRef: "12, 15" })), {
    label: "Event IDs",
    value: "12, 15",
  });
  assert.deepEqual(audienceRefDetail(row({ audienceType: "USER", audienceRef: "" })), {
    label: "Recipient IDs",
    value: "—",
  });
});

test("statusBadge maps SENT/EMPTY/RECALLED tones and keeps an unknown status visible", () => {
  assert.deepEqual(statusBadge("SENT"), { label: "Sent", tone: "ok" });
  assert.deepEqual(statusBadge("EMPTY"), { label: "No recipients", tone: "off" });
  // RECALLED (TM-473/TM-560) is first-classed: friendly "Recalled" copy + muted tone, not the raw token.
  assert.deepEqual(statusBadge("RECALLED"), { label: "Recalled", tone: "off" });
  assert.deepEqual(statusBadge("recalled"), { label: "Recalled", tone: "off" }); // case-insensitive
  assert.deepEqual(statusBadge("QUEUED"), { label: "QUEUED", tone: "info" });
  assert.deepEqual(statusBadge(""), { label: "—", tone: "info" });
  assert.deepEqual(statusBadge(null), { label: "—", tone: "info" });
});

test("messageBodyState shows the fetched body once the by-id detail loads", () => {
  // The point of TM-562: the expanded row shows the ACTUAL body the detail endpoint returned.
  assert.deepEqual(messageBodyState({ loading: false, error: null, detail: { body: "See you at 7pm." } }), {
    mode: "body",
    text: "See you at 7pm.",
  });
  // Body is returned verbatim (whitespace preserved), not trimmed, so the DOM can render it faithfully.
  assert.deepEqual(messageBodyState({ detail: { body: "  line one\n\n  line two  " } }), {
    mode: "body",
    text: "  line one\n\n  line two  ",
  });
});

test("messageBodyState reports loading before/while the fetch is in flight", () => {
  assert.deepEqual(messageBodyState(undefined), { mode: "loading", text: "Loading message…" });
  assert.deepEqual(messageBodyState({ loading: true, error: null, detail: null }), {
    mode: "loading",
    text: "Loading message…",
  });
});

test("messageBodyState surfaces a fetch error, with a fallback", () => {
  assert.deepEqual(messageBodyState({ loading: false, error: "Could not load the message (404).", detail: null }), {
    mode: "error",
    text: "Could not load the message (404).",
  });
  // Blank/absent error string → a sensible default, never an empty panel.
  assert.deepEqual(messageBodyState({ loading: false, error: "   ", detail: null }), {
    mode: "error",
    text: "Could not load the message body.",
  });
});

test("messageBodyState handles a loaded-but-blank body defensively", () => {
  assert.deepEqual(messageBodyState({ loading: false, error: null, detail: { body: "   " } }), {
    mode: "empty",
    text: "(no message body)",
  });
  assert.deepEqual(messageBodyState({ loading: false, error: null, detail: {} }), {
    mode: "empty",
    text: "(no message body)",
  });
});

test("normalisePageResponse fills a clean envelope", () => {
  const norm = normalisePageResponse({
    items: [row(), row({ id: 43 })],
    page: 1,
    size: 20,
    totalElements: 40,
    totalPages: 2,
  });
  assert.equal(norm.items.length, 2);
  assert.equal(norm.page, 1);
  assert.equal(norm.size, 20);
  assert.equal(norm.totalElements, 40);
  assert.equal(norm.totalPages, 2);
});

test("normalisePageResponse defends against a degraded envelope", () => {
  // Missing everything → safe empty shape.
  const empty = normalisePageResponse(undefined);
  assert.deepEqual(empty, { items: [], page: 0, size: DEFAULT_PAGE_SIZE, totalElements: 0, totalPages: 0 });

  // Items present but the server omitted totalPages → derive it, never 0 while holding rows.
  const derived = normalisePageResponse({ items: [row()], totalElements: 5, size: 20 });
  assert.equal(derived.totalPages, 1);

  // Non-numeric fields fall back sensibly; size can never be 0.
  const junk = normalisePageResponse({ items: [row()], page: "x", size: 0, totalElements: "y" });
  assert.equal(junk.page, 0);
  assert.equal(junk.size, DEFAULT_PAGE_SIZE);
  assert.equal(junk.totalElements, 1); // falls back to items.length
});

test("hasPrevPage / hasNextPage compute the pager edges", () => {
  assert.equal(hasPrevPage(0), false);
  assert.equal(hasPrevPage(1), true);
  assert.equal(hasPrevPage("x"), false);

  assert.equal(hasNextPage(0, 3), true);
  assert.equal(hasNextPage(2, 3), false); // last page (0,1,2)
  assert.equal(hasNextPage(0, 1), false); // single page
  assert.equal(hasNextPage(0, 0), false); // no pages
});

test("clampPage keeps a requested page in range", () => {
  assert.equal(clampPage(5, 3), 2); // overshoot → last page index
  assert.equal(clampPage(-1, 3), 0); // guard floors to 0
  assert.equal(clampPage(1, 3), 1); // in range → unchanged
  assert.equal(clampPage(2, 0), 0); // no pages → 0
});

test("pageIndicator is one-based and never 'of 0'", () => {
  assert.equal(pageIndicator(0, 3), "Page 1 of 3");
  assert.equal(pageIndicator(2, 3), "Page 3 of 3");
  assert.equal(pageIndicator(0, 0), "Page 1 of 1");
  assert.equal(pageIndicator(9, 3), "Page 3 of 3"); // clamped
});

test("rangeIndicator reflects the current-page window", () => {
  assert.equal(rangeIndicator(0, 20, 97, 20), "1–20 of 97");
  assert.equal(rangeIndicator(4, 20, 97, 17), "81–97 of 97"); // short last page
  assert.equal(rangeIndicator(0, 20, 0, 0), "0 of 0"); // empty
  assert.equal(rangeIndicator(1, 20, 25, 5), "21–25 of 25");
});

test("isEmptyHistory only flags a genuinely-empty first page", () => {
  assert.equal(isEmptyHistory([], 0), true); // nothing ever sent
  assert.equal(isEmptyHistory([], 2), false); // paged past the end — not "empty history"
  assert.equal(isEmptyHistory([row()], 0), false);
});
