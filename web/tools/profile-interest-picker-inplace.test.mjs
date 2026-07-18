// TM-860 regression tests — the profile Interests "+ add" picker must toggle chips IN PLACE, never
// clear + rebuild the modal body.
//
// THE BUG: openInterestPicker()'s old renderPicker() did clear(bodyWrap) and rebuilt every chip on
// each toggle. Wiping the scroll container's content collapses its height mid-frame, and real mobile
// engines (iOS Safari / Android WebView) clamp .tm-modal-body's scrollTop to 0 — so selecting a chip
// near the bottom of the list bounced the user back to the TOP (TM-860 / dup TM-865). Desktop
// Chromium rebuilds synchronously and happens to preserve scrollTop, so the scroll reset itself is
// NOT reproducible in a headless-Chromium harness (proven on TM-865) — which is why these tests
// assert the MECHANISM instead: after a chip toggle the body's child nodes must be the SAME element
// objects (no rebuild, no clear), with the selection state repainted onto them in place. DOM identity
// is the honest desktop-testable proxy for "the scroll position survives on mobile".
//
// FAIL-BEFORE / PASS-AFTER: on main's profile.js the toggle handler calls renderPicker() →
// clear(bodyWrap) + all-new nodes, so the identity assertions here FAIL (and every held node
// reference goes stale). On the TM-860 branch the toggle handler calls refreshPicker(), which only
// mutates class/aria-pressed/disabled/text on the existing nodes — these tests PASS.
//
// HARNESS: profile.js statically imports the app's ES modules (api.js → Firebase CDN chain, …), so it
// can't be `import`ed under `node --test`. Like profile-edit-behaviour.test.mjs we load the REAL
// source, strip the import block, inject the dependencies (real pure interests-core + tiny fakes for
// ui/api/auth) via a global, and append a test seam exporting openInterestPicker + the module state.
// The function bodies under test are the exact shipped source — a behavioural proof, not a copy.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── A minimal fake DOM node: just the surface openInterestPicker/refreshPicker touch. ─────────────
// textContent is an opaque string (mirroring the real sink — never HTML-parsed); classList wraps a
// Set; attributes live in a plain map; children in an array so tests can assert node IDENTITY.
function fakeEl(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    hidden: false,
    disabled: false,
    _attrs: {},
    _classes: new Set(),
    _children: [],
    _listeners: {},
    addEventListener(type, fn) {
      node._listeners[type] = fn;
    },
    setAttribute(k, v) {
      node._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in node._attrs ? node._attrs[k] : null;
    },
    append(...kids) {
      for (const kid of kids) node._children.push(kid);
    },
    classList: {
      add(...cs) {
        for (const c of cs) node._classes.add(c);
      },
      remove(...cs) {
        for (const c of cs) node._classes.delete(c);
      },
      contains(c) {
        return node._classes.has(c);
      },
      toggle(c, force) {
        const on = force === undefined ? !node._classes.has(c) : Boolean(force);
        if (on) node._classes.add(c);
        else node._classes.delete(c);
        return on;
      },
    },
  };
  return node;
}

// A fake `el(tag, props, children)` matching ui.js's contract for the paths under test: `text` via
// textContent, `class` split into the class set, onClick captured as a property the test can fire,
// boolean props (hidden/disabled) assigned, other attrs stored; string children appended as text nodes.
function fakeElBuilder(tag, props = {}, children = []) {
  const node = fakeEl(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "class") node.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === "hidden") node.hidden = Boolean(v);
    else if (k === "disabled") node.disabled = Boolean(v);
    else if (k === "onClick" || k === "onSubmit") node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c != null) node.append(typeof c === "string" ? { nodeType: 3, data: c } : c);
  }
  return node;
}

// ── Instrumented collaborators: what the assertions read. ─────────────────────────────────────────
// Every clear() call is recorded — the fail-before signal is a clear on the picker body after open.
const CLEARED = [];
// Every modal() call is recorded so the test can grab the picker's body node + count dialog closes.
const MODALS = [];

// Real pure interests-core (import-safe, no CDN) — the picker must run the SHIPPED grouping/toggle/
// validation logic, so the tests prove the real chain, not a re-implementation.
const interestsCore = await import(new URL("../src/assets/interests-core.js", import.meta.url));

// Load profile.js: strip the import block, inject deps, append the seam. Same technique (and the same
// import-name list) as profile-edit-behaviour.test.mjs — see the header comment there for the why.
function loadProfileModule() {
  const src = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
  const withoutImports = src.replace(/^import[\s\S]*?;\s*$/gm, "");
  const preamble = "const {\n" +
    "  getMe, updateMe, getMembership, getInterestCatalogue, getInterestConfig, ApiError,\n" +
    "  currentUser, signOut,\n" +
    "  isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES,\n" +
    "  announceAvatarChanged, onAvatarChangedEvent,\n" +
    "  isNativeCameraAvailable, captureAvatarImage,\n" +
    "  clear, el, modal, toast, doodle, renderAccountBadges,\n" +
    "  buildSecuritySettings, buildAppearanceSettings,\n" +
    "  PROFILE_PUBLIC_ROUTE, profileMode, identitySummary, accountContact, profileStrength, publicSummary,\n" +
    "  validateProfileField, NOTIFICATION_PREFS, CITY_OPTIONS, cityChoiceError,\n" +
    "  splitE164, composeE164, defaultCountryFor, phonePartsError, PHONE_PICK_COUNTRY_MESSAGE,\n" +
    "  nextDayInterestsNudge,\n" +
    "  COUNTRIES, flagOf,\n" +
    "  normaliseInterestConfig, savedInterestLabels, interestChipsModel, catalogueGroups, toggleInterest, selectionError,\n" +
    "  profileMembershipRow, profileManageAffordance, membershipEnabled,\n" +
    "} = globalThis.__TM860_DEPS__;\n";
  // Seam (eval copy only): reach openInterestPicker + the module-private state so a test can seed the
  // catalogue/config/profile the picker reads without walking the whole load() path.
  const seam = "\nexport { openInterestPicker };\nexport function __getState(){ return state; }\n";
  const code = preamble + withoutImports + seam;
  assert.doesNotMatch(code, /^import[\s\S]*?from/m, "all top-level imports must be replaced before eval");

  globalThis.__TM860_DEPS__ = {
    // Network + auth fakes: never reached by the picker-toggle paths under test.
    getMe: async () => ({}),
    updateMe: async () => ({}),
    getMembership: async () => ({}),
    getInterestCatalogue: async () => null,
    getInterestConfig: async () => null,
    ApiError: class ApiError extends Error {},
    currentUser: () => null,
    signOut: async () => {},
    isStorageConfigured: () => false,
    uploadAvatar: async () => "",
    validateAvatarFile: () => "",
    MAX_AVATAR_BYTES: 5 * 1024 * 1024,
    announceAvatarChanged: () => {},
    onAvatarChangedEvent: () => () => {},
    isNativeCameraAvailable: () => false,
    captureAvatarImage: async () => null,
    // Instrumented UI kit: clear empties the child array EXACTLY like ui.js's real clear empties a
    // node (so a main-run rebuild genuinely replaces children), and records the call.
    clear: (node) => {
      CLEARED.push(node);
      if (node) node._children = [];
      return node;
    },
    el: fakeElBuilder,
    modal: (title, content) => {
      const call = { title, content, closed: 0 };
      MODALS.push(call);
      return { close: () => call.closed++ };
    },
    toast: () => {},
    doodle: () => fakeElBuilder("span"),
    renderAccountBadges: () => null,
    buildSecuritySettings: () => fakeElBuilder("section"),
    buildAppearanceSettings: () => fakeElBuilder("section"),
    // Real pure profile-core symbols aren't needed by the picker path — inert stands-in are enough
    // (module-level code only touches normaliseInterestConfig, injected REAL below).
    PROFILE_PUBLIC_ROUTE: "#/profile/public",
    profileMode: () => "self",
    identitySummary: () => ({}),
    accountContact: () => ({}),
    profileStrength: () => ({ percent: 0, gaps: [] }),
    publicSummary: () => ({}),
    validateProfileField: () => "",
    NOTIFICATION_PREFS: ["EMAIL", "PUSH", "BOTH"],
    CITY_OPTIONS: ["London"],
    cityChoiceError: () => "",
    splitE164: () => ({ iso2: "GB", national: "" }),
    composeE164: () => "",
    defaultCountryFor: () => "GB",
    phonePartsError: () => "",
    PHONE_PICK_COUNTRY_MESSAGE: "Pick a country",
    nextDayInterestsNudge: () => ({ show: false }),
    COUNTRIES: [],
    flagOf: () => "",
    // The REAL TM-778 interests logic — the exact grouping/toggle/min-max rules the shipped picker runs.
    normaliseInterestConfig: interestsCore.normaliseInterestConfig,
    savedInterestLabels: interestsCore.savedInterestLabels,
    interestChipsModel: interestsCore.interestChipsModel,
    catalogueGroups: interestsCore.catalogueGroups,
    toggleInterest: interestsCore.toggleInterest,
    selectionError: interestsCore.selectionError,
    profileMembershipRow: () => ({}),
    profileManageAffordance: () => ({}),
    membershipEnabled: () => false,
  };
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

const profile = await loadProfileModule();

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────
// Two categories, six chips; "Vinyl & records" (with a TM-805 emoji) plays the "chip near the bottom
// of the list" from the bug report. min 1 / max 3 = the shipped defaults.
const CATALOGUE = [
  { label: "Hiking", category: "Outdoors", active: true },
  { label: "Cycling", category: "Outdoors", active: true },
  { label: "Climbing", category: "Outdoors", active: true },
  { label: "Board games", category: "Indoors", active: true },
  { label: "Baking", category: "Indoors", active: true },
  { label: "Vinyl & records", category: "Indoors", active: true, emoji: "🎵" },
];

/** Depth-first walk of a fake-node tree collecting nodes that carry a class. */
function findByClass(root, className, out = []) {
  for (const kid of root._children || []) {
    if (kid && kid._classes) {
      if (kid._classes.has(className)) out.push(kid);
      findByClass(kid, className, out);
    }
  }
  return out;
}

/** Seed the module state + open the picker; returns handles to everything the assertions touch. */
function openPicker({ saved = ["Hiking"] } = {}) {
  const st = profile.__getState();
  st.interestConfig = { min: 1, max: 3 };
  st.interestCatalogue = CATALOGUE;
  st.profile = { interests: saved };
  const modalsBefore = MODALS.length;
  profile.openInterestPicker();
  assert.equal(MODALS.length, modalsBefore + 1, "opening the picker must mount exactly one modal");
  const body = MODALS[MODALS.length - 1].content;
  const chips = findByClass(body, "tm-pf-picker-opt");
  assert.equal(chips.length, CATALOGUE.length, "one chip per active catalogue row");
  const chipByLabel = new Map();
  for (const [i, chip] of chips.entries()) chipByLabel.set(CATALOGUE[i].label, chip);
  const [count] = findByClass(body, "tm-pf-picker-count");
  const [save] = findByClass(body, "tm-btn-primary");
  assert.ok(count && save, "picker body must contain the count line and Save");
  // The error line is looked up LAZILY (not asserted here): pre-fix (main) it only exists while the
  // selection is invalid, so a hard assertion at open would make every test fail in SETUP instead of
  // on the load-bearing no-rebuild assertions. Only the min-error test needs it, and it asserts the
  // permanent-node structure itself.
  const findError = () => findByClass(body, "tm-field-error")[0];
  return { body, chips, chipByLabel, count, save, findError };
}

test("TM-860: toggling a chip repaints IN PLACE — same DOM nodes, no clear, count updates", () => {
  const { body, chips, chipByLabel, count } = openPicker();
  assert.equal(count.textContent, "1 of 3 selected", "opens with the saved selection counted");

  // Freeze the body's structure: the exact child references (and each chip reference) pre-toggle.
  const childrenBefore = [...body._children];
  const clearsBefore = CLEARED.filter((n) => n === body).length;

  // The bug's gesture: pick a chip near the BOTTOM of the list.
  const vinyl = chipByLabel.get("Vinyl & records");
  vinyl.onClick();

  // No rebuild: the body was never clear()ed after open, and every child is the SAME element object
  // in the same order. This is the desktop-testable proxy for "scrollTop survives on mobile" — a
  // clear/rebuild (main's behaviour) resets the scroll container on real mobile engines (TM-865).
  assert.equal(
    CLEARED.filter((n) => n === body).length,
    clearsBefore,
    "a chip toggle must NOT clear() the picker body",
  );
  assert.equal(body._children.length, childrenBefore.length, "child count unchanged by a toggle");
  for (const [i, kid] of childrenBefore.entries()) {
    assert.equal(body._children[i], kid, `body child #${i} must be the SAME node after the toggle`);
  }

  // The tapped chip's state flipped on the EXISTING node…
  assert.ok(vinyl._classes.has("tm-pf-chip-on"), "tapped chip gains the -on modifier");
  assert.ok(vinyl._classes.has("tm-pf-chip"), "the base chip class is never stripped");
  assert.equal(vinyl.getAttribute("aria-pressed"), "true", "tapped chip is aria-pressed");
  // …its TM-805 emoji glyph is still the original child (nothing was re-rendered)…
  const emoji = findByClass(vinyl, "tm-pf-chip-emoji");
  assert.equal(emoji.length, 1, "the emoji span survives the toggle");
  assert.equal(emoji[0].textContent, "🎵", "with its original glyph");
  // …and the count line updated in place.
  assert.equal(count.textContent, "2 of 3 selected", "count reflects the new selection");

  // Toggle OFF again on the same (still-live) node: state flips back, still no rebuild.
  vinyl.onClick();
  assert.ok(!vinyl._classes.has("tm-pf-chip-on"), "re-tap deselects the same node");
  assert.equal(vinyl.getAttribute("aria-pressed"), "false");
  assert.equal(count.textContent, "1 of 3 selected");
  assert.equal(body._children[0], childrenBefore[0], "still the original nodes after a second toggle");
  void chips;
});

test("TM-860: reaching the max disables the OTHER chips in place; deselecting re-enables them", () => {
  const { chipByLabel, count } = openPicker(); // "Hiking" saved; max 3
  chipByLabel.get("Cycling").onClick();
  chipByLabel.get("Baking").onClick();
  assert.equal(count.textContent, "3 of 3 selected");

  // At the cap: every UNSELECTED chip (the same original nodes) is disabled; selected ones stay
  // enabled so the user can always deselect to make room — catalogueGroups' exact predicate.
  const selected = new Set(["Hiking", "Cycling", "Baking"]);
  for (const [label, chip] of chipByLabel) {
    assert.equal(
      chip.disabled,
      !selected.has(label),
      `${label}: disabled must be ${!selected.has(label)} at the cap`,
    );
    assert.equal(chip.getAttribute("aria-pressed"), selected.has(label) ? "true" : "false");
  }

  // Drop one pick: the at-max dimming lifts from every other chip — again on the SAME nodes.
  chipByLabel.get("Cycling").onClick();
  assert.equal(count.textContent, "2 of 3 selected");
  for (const [label, chip] of chipByLabel) {
    assert.equal(chip.disabled, false, `${label}: re-enabled once below the cap`);
  }
});

test("TM-860: emptying the selection surfaces the min error + disables Save — in place", () => {
  const { chipByLabel, save, findError } = openPicker(); // one saved pick, min 1
  const error = findError();
  assert.ok(
    error,
    "the error line must be a PERMANENT (hidden-when-savable) node — pre-fix it was only created once the selection turned invalid, as part of the full rebuild",
  );
  assert.equal(error.hidden, true, "a savable selection shows no error");
  assert.equal(save.disabled, false, "Save starts enabled");

  chipByLabel.get("Hiking").onClick(); // deselect the only pick → below the min
  assert.equal(error.hidden, false, "the min error becomes visible on the existing node");
  assert.equal(error.textContent, "Choose at least 1 interest.");
  assert.equal(save.disabled, true, "Save disables while the selection violates the min");

  chipByLabel.get("Board games").onClick(); // back to a savable set
  assert.equal(error.hidden, true, "the error hides again");
  assert.equal(error.textContent, "", "and its text is cleared");
  assert.equal(save.disabled, false, "Save re-enables on the same node");
});
