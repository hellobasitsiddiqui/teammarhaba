// Regression guard for the admin stats-bar loading gate (TM-756). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (flash-of-zero, TM-663 bug class): every admin console's load*() sets state.loading = true
// and calls render() BEFORE its page walk resolves; render() calls renderStats() unconditionally, and
// renderStats() computed concrete counts straight from the still-empty state — so on a populated
// system the stats bar flashed "Total 0 / … 0" as if that were real data, then jumped to the real
// numbers. The TABLE sibling was already gated ("Loading users…/events…/venues…/interests…"); the
// stats path was not. THE FIX: mirror that gate — each renderStats routes its [label, value] cards
// through the pure statsCards() mask (admin-stats-core.js), which replaces every value with the "—"
// placeholder while state.loading is set, so no false zero ever paints and the grid keeps its exact
// shape (the product tour targets ".tm-stats" — tour-highlights.js).
//
// The four DOM halves can't be imported under `node --test` (api.js → Firebase CDN chain), so — per
// the admin-loadusers-reentry.test.mjs precedent — this pins the fix with a behavioural proof of the
// pure mask plus a source assertion per console that renderStats really routes through it with
// state.loading. All of these FAIL on the unfixed tree (no core module, unguarded renderStats).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Behavioural: the pure mask hides every value while loading, passes through when settled ──────────

test("statsCards leaves cards untouched when not loading and masks every value with an em-dash while loading", async () => {
  // Dynamic import so, on an unfixed tree (module absent), THIS test fails without taking the
  // per-console source assertions below down with it — each finding reports independently.
  const { statsCards } = await import("../src/assets/admin-stats-core.js");

  const cards = [
    ["Total", 42],
    ["Admins", 3],
    ["Enabled", 40],
    ["Disabled", 2],
  ];

  // Settled state: the cards pass through UNTOUCHED — the loaded-numbers path must stay byte-identical.
  assert.equal(statsCards(cards, false), cards, "not loading → the exact same array passes through");

  // Loading: every label kept, every value replaced by the "—" placeholder — a concrete 0 (or any
  // stale number) must never survive the mask.
  assert.deepEqual(statsCards(cards, true), [
    ["Total", "—"],
    ["Admins", "—"],
    ["Enabled", "—"],
    ["Disabled", "—"],
  ]);

  // The mask is non-destructive: the caller's array still holds the real values for the next render.
  assert.deepEqual(cards[0], ["Total", 42], "masking must not mutate the input cards");

  // Shape-preserving on any card count (the consoles have 3- and 4-card bars).
  assert.deepEqual(statsCards([["Total", 0]], true), [["Total", "—"]]);
  assert.deepEqual(statsCards([], true), []);
});

// ── Source guards: each console's renderStats routes its cards through the loading-aware mask ────────

const CONSOLES = [
  ["admin.js", "users"],
  ["admin-events.js", "events"],
  ["admin-venues.js", "venues"],
  ["admin-interests.js", "interests"],
];

for (const [file, name] of CONSOLES) {
  test(`${name} console (${file}): renderStats gates the stats bar on state.loading via statsCards`, () => {
    const source = readFileSync(join(HERE, "../src/assets", file), "utf8");

    // The module must import the mask from the core (the seam this suite proves behaviourally above).
    assert.match(
      source,
      /import\s*\{[^}]*\bstatsCards\b[^}]*\}\s*from\s*"\.\/admin-stats-core\.js"/,
      `${file} must import statsCards from admin-stats-core.js`,
    );

    // Locate renderStats() — inner lines are indented, so the first column-0 "}" closes the function
    // (same extraction trick as admin-loadusers-reentry.test.mjs).
    const fn = source.match(/function renderStats\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fn, `could not locate renderStats() in ${file}`);

    // The cards must flow through statsCards(…, state.loading) — the guard that replaces the old
    // unconditional concrete-count paint.
    assert.match(
      fn[1],
      /statsCards\(\s*\[[\s\S]*?\]\s*,\s*state\.loading\s*\)/,
      `${file} renderStats must route its cards through statsCards(cards, state.loading)`,
    );
  });
}
