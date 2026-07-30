// Unit tests for the top-bar headline resolver (TM-1175). Pure module → fast `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { headlineFor, TOPBAR_HEADLINES } from "../src/assets/topbar-headline-core.js";

test("each non-admin tab maps to its Basit-approved headline", () => {
  assert.equal(headlineFor({ tab: "home" }), "Complete the circle");
  assert.equal(headlineFor({ tab: "chat" }), "Your event chats");
  assert.equal(headlineFor({ tab: "profile" }), "About you");
  assert.equal(headlineFor({ tab: "help" }), "Help & tips");
});

test("the admin 5th tab reads 'Admin console'", () => {
  assert.equal(headlineFor({ tab: "admin" }), "Admin console");
});

test("Events appends the user's city when set", () => {
  assert.equal(headlineFor({ tab: "events", cityLabel: "London" }), "Events · London");
  assert.equal(headlineFor({ tab: "events", cityLabel: "Milton Keynes" }), "Events · Milton Keynes");
});

test("Events falls back to plain 'Events' with no / blank / whitespace city", () => {
  assert.equal(headlineFor({ tab: "events" }), "Events");
  assert.equal(headlineFor({ tab: "events", cityLabel: "" }), "Events");
  assert.equal(headlineFor({ tab: "events", cityLabel: "   " }), "Events");
  assert.equal(headlineFor({ tab: "events", cityLabel: null }), "Events");
});

test("city is trimmed", () => {
  assert.equal(headlineFor({ tab: "events", cityLabel: "  Sharjah  " }), "Events · Sharjah");
});

test("city is IGNORED for non-events tabs (no accidental templating)", () => {
  assert.equal(headlineFor({ tab: "home", cityLabel: "London" }), "Complete the circle");
  assert.equal(headlineFor({ tab: "profile", cityLabel: "London" }), "About you");
});

test("unknown / missing / signed-out tab → empty string (no headline)", () => {
  assert.equal(headlineFor({ tab: "login" }), "");
  assert.equal(headlineFor({ tab: undefined }), "");
  assert.equal(headlineFor({}), "");
  assert.equal(headlineFor(), "");
});

test("the headline map covers exactly the six tab ids", () => {
  assert.deepEqual(
    Object.keys(TOPBAR_HEADLINES).sort(),
    ["admin", "chat", "events", "help", "home", "profile"],
  );
});
