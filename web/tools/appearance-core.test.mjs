// Paper appearance contract tests (TM-529). Framework-free — Node's built-in test runner, picked up
// by the CI glob `node --test web/tools/*.test.mjs`.
//
// Covers the ticket's test asks against the PURE core (appearance-core.js):
//   • the curated palette is well-formed and its hexes MATCH the --accent-paper-* CSS tokens (no drift),
//   • the new-user DEFAULT (Paper + teal accent + sketchy ON),
//   • that no non-Paper / retired theme name is a selectable accent,
//   • applyAppearance sets [data-sketchy] + re-points --accent/--on-accent, and
//   • the boot-hint round-trip (the localStorage paint hint the server keeps in step).
// The server-side persistence round-trip is covered by the backend MeControllerIntegrationTest.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PAPER_PALETTE,
  ACCENT_IDS,
  DEFAULT_ACCENT_ID,
  DEFAULT_SKETCHY,
  HINT_KEY,
  isValidAccentId,
  accentById,
  accentIdFromHex,
  normalizeAppearance,
  applyAppearance,
  readHint,
  writeHint,
  clearHint,
} from "../src/assets/appearance-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

/** A minimal fake <html> element + document for applyAppearance (no jsdom needed). */
function fakeDoc() {
  const el = {
    attrs: {},
    props: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    style: {
      _p: {},
      setProperty(k, v) {
        this._p[k] = v;
      },
      getPropertyValue(k) {
        return this._p[k] ?? "";
      },
    },
  };
  return { documentElement: el };
}

/** A minimal in-memory Storage. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test("the curated palette has ~6 well-formed, unique swatches", () => {
  assert.ok(PAPER_PALETTE.length >= 5 && PAPER_PALETTE.length <= 7, "palette should be a small curated set");
  const ids = new Set();
  for (const s of PAPER_PALETTE) {
    assert.match(s.id, /^[a-z]+$/, "swatch id is a simple token");
    assert.match(s.hex, /^#[0-9a-fA-F]{6}$/, `${s.id} hex is a #rrggbb`);
    assert.match(s.onAccent, /^#[0-9a-fA-F]{6}$/, `${s.id} onAccent is a #rrggbb`);
    assert.ok(s.label && typeof s.label === "string", `${s.id} has a label`);
    assert.ok(!ids.has(s.id), `${s.id} is unique`);
    ids.add(s.id);
  }
  assert.deepEqual(ACCENT_IDS, PAPER_PALETTE.map((s) => s.id), "ACCENT_IDS mirrors the palette order");
});

test("each palette hex is defined as its --accent-paper-<id> CSS token (JS↔CSS single source)", () => {
  // Guards against the JS palette drifting from the design tokens in styles.css.
  for (const s of PAPER_PALETTE) {
    const decl = `--accent-paper-${s.id}: ${s.hex};`;
    assert.ok(CSS.includes(decl), `styles.css must define \`${decl}\` (matches the JS palette)`);
  }
});

test("the new-user defaults are Paper + teal accent + sketchy ON (TM-529 AC4)", () => {
  assert.equal(DEFAULT_ACCENT_ID, "teal", "default accent swatch is teal (the TM-510 --accent)");
  assert.equal(PAPER_PALETTE[0].id, "teal", "teal is the first/selected swatch");
  assert.equal(PAPER_PALETTE[0].hex, "#0f9d8c", "the default teal is the shipped Paper --accent");
  assert.equal(DEFAULT_SKETCHY, true, "sketchy defaults ON");
  // An empty/unknown state normalizes to exactly those defaults.
  assert.deepEqual(normalizeAppearance(undefined), { accentId: "teal", sketchy: true });
  assert.deepEqual(normalizeAppearance({ accentId: "nope", sketchy: "yes" }), { accentId: "teal", sketchy: true });
});

test("no non-Paper / retired theme name is a selectable accent (TM-529 AC6)", () => {
  for (const bad of ["clean", "doodle", "sketch", "neon", "", null, undefined, "#0f9d8c"]) {
    assert.equal(isValidAccentId(bad), false, `${JSON.stringify(bad)} must not be a valid swatch`);
  }
  for (const id of ACCENT_IDS) assert.equal(isValidAccentId(id), true, `${id} is valid`);
  // accentById always returns a real swatch (falls back to the default), never throws.
  assert.equal(accentById("sketch").id, DEFAULT_ACCENT_ID, "unknown id falls back to the default swatch");
  assert.equal(accentById("indigo").id, "indigo");
});

test("accentIdFromHex reverse-maps a swatch colour (case-insensitive), else null", () => {
  assert.equal(accentIdFromHex("#0f9d8c"), "teal");
  assert.equal(accentIdFromHex("#0F9D8C"), "teal");
  assert.equal(accentIdFromHex("#ffffff"), null);
  assert.equal(accentIdFromHex(42), null);
});

test("applyAppearance sets [data-sketchy] and re-points --accent/--on-accent", () => {
  const doc = fakeDoc();

  // Default (new user): sketchy on + teal.
  const applied = applyAppearance(doc, {});
  assert.deepEqual(applied, { accentId: "teal", sketchy: true });
  assert.equal(doc.documentElement.getAttribute("data-sketchy"), "on");
  assert.equal(doc.documentElement.style.getPropertyValue("--accent"), "#0f9d8c");
  assert.equal(doc.documentElement.style.getPropertyValue("--on-accent"), "#ffffff");

  // Change to a different swatch + clean paper.
  applyAppearance(doc, { accentId: "ink", sketchy: false });
  assert.equal(doc.documentElement.getAttribute("data-sketchy"), "off");
  assert.equal(doc.documentElement.style.getPropertyValue("--accent"), "#2b2b2b");
  assert.equal(doc.documentElement.style.getPropertyValue("--on-accent"), "#fafafa");

  // Tolerates a missing document (returns normalized state, no throw).
  assert.deepEqual(applyAppearance(null, { accentId: "coral", sketchy: false }), { accentId: "coral", sketchy: false });
});

test("the boot hint round-trips and stores the resolved colour (server stays the source of truth)", () => {
  const storage = fakeStorage();

  assert.equal(readHint(storage), null, "no hint yet");

  assert.equal(writeHint(storage, { accentId: "plum", sketchy: false }), true);
  // The stored payload carries the resolved hex/onAccent so the classic boot needs no palette.
  const raw = JSON.parse(storage.getItem(HINT_KEY));
  assert.equal(raw.accentId, "plum");
  assert.equal(raw.sketchy, false);
  assert.equal(raw.hex, "#7c3aed");
  assert.equal(raw.onAccent, "#ffffff");

  assert.deepEqual(readHint(storage), { accentId: "plum", sketchy: false });

  // A bad/garbage hint reads back as null (defaults then win) rather than throwing.
  storage.setItem(HINT_KEY, "{not json");
  assert.equal(readHint(storage), null);

  clearHint(storage);
  assert.equal(storage.getItem(HINT_KEY), null);
});
