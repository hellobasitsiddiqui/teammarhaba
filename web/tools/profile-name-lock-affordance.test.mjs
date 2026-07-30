// TM-968 unit coverage for the locked-name AFFORDANCES on the Profile edit screen (profile.js
// applyNameLock). Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// WHAT THIS PROVES (the TM-968 UX follow-up on the TM-907 read-only name lock):
//   • a LOCKED, non-empty name field gains the padlock affordance (the `.tm-input-locked` class, which
//     the CSS paints the padlock background onto) + a WHY tooltip (the input's native `title`), and its
//     allowed-characters char-hint is HIDDEN (an edit rule is noise on a field you can't edit);
//   • an UNLOCKED field (account not locked) shows NO padlock class, NO tooltip, and KEEPS its hint;
//   • the CARVE-OUT — a locked-but-EMPTY name field — is NOT treated as locked: no padlock, no tooltip,
//     and it KEEPS its hint (it's still settable once, so it must stay a normal editable field);
//   • un-locking (admin correction / repaint with nameLocked=false) REVERSES all three: the class,
//     the title, and the hint-hiding are cleared, so the field repaints as a normal editable field.
//
// This is the SAME eval harness the sibling profile tests use (profile-edit-behaviour.test.mjs): the
// real profile.js is loaded as a data: URL with its imports replaced by an injected deps kit and a
// small TEST SEAM appended — so the applyNameLock body under test is the EXACT shipped source, and the
// proof is behavioural (not a re-implementation). The seam additionally exports applyNameLock.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// The real ApiError shape (api.js) — profile.js references it; a bare stand-in is enough here.
class ApiError extends Error {
  constructor(status, message, fieldErrors = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

// --- A minimal fake element: enough of the DOM surface applyNameLock (and module load) touches -----
function fakeEl(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    _textContent: "",
    get textContent() {
      return this._textContent;
    },
    set textContent(v) {
      this._textContent = String(v);
    },
    innerHTML: undefined,
    hidden: false,
    disabled: false,
    readOnly: false,
    value: "",
    style: {},
    _attrs: {},
    _classes: new Set(),
    classList: {
      _s: null,
      add(c) {
        this._s.add(c);
      },
      remove(c) {
        this._s.delete(c);
      },
      contains(c) {
        return this._s.has(c);
      },
      toggle(c, force) {
        const on = force === undefined ? !this._s.has(c) : force;
        if (on) this._s.add(c);
        else this._s.delete(c);
        return on;
      },
    },
    _children: [],
    _listeners: {},
    addEventListener(type, fn) {
      this._listeners[type] = fn;
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    hasAttribute(k) {
      return k in this._attrs;
    },
    removeAttribute(k) {
      delete this._attrs[k];
    },
    append(...nodes) {
      for (const n of nodes) this._children.push(n);
    },
  };
}
function wireClassList(node) {
  node.classList._s = node._classes;
  return node;
}

// A fake `el(tag, attrs, children)` matching ui.js closely enough for the module-load paths.
function fakeElBuilder(tag, attrs = {}, children = []) {
  const node = wireClassList(fakeEl(tag));
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node._classes.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === "hidden") node.hidden = Boolean(v);
    else if (k === "disabled") node.disabled = Boolean(v);
    else if (k === "onClick" || k === "onSubmit") node[k] = v;
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) if (c != null) node.append(typeof c === "string" ? { nodeType: 3, data: c } : c);
  return node;
}

// Load profile.js: strip the import block, inject deps via a global destructure, and append a TEST
// SEAM that reaches the module-private shell + exports applyNameLock (the EXACT shipped body).
function loadProfileModule(deps) {
  const src = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
  const withoutImports = src.replace(/^import[\s\S]*?;\s*$/gm, "");

  // Every symbol profile.js names, provided from the injected deps global. Kept byte-aligned with the
  // sibling harness's destructure so a new profile.js import is caught the same way (see the blackboard
  // note on the FIXED __PROFILE_DEPS__ destructure).
  const preamble = "const {\n" +
    "  getMe, updateMe, getMembership, getInterestCatalogue, getInterestConfig, ApiError,\n" +
    "  currentUser, signOut,\n" +
    "  startPhoneVerify, confirmPhoneLink, attachOtpInput, attachResendCooldown,\n" +
    "  isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES,\n" +
    "  onAvatarChanged, announceAvatarChanged, onAvatarChangedEvent,\n" +
    "  isNativeCameraAvailable, captureAvatarImage,\n" +
    "  clear, confirmDialog, el, modal, toast, doodle, renderAccountBadges,\n" +
    "  buildSecuritySettings, buildAppearanceSettings,\n" +
    "  PROFILE_PUBLIC_ROUTE, profileMode, identitySummary, accountContact, profileStrength, strengthRingGeometry, publicSummary,\n" +
    "  validateProfileField, NOTIFICATION_PREFS, CITY_OPTIONS, cityChoiceError,\n" +
    // TM-1165: the catalogue-driven city dropdown resolver profile.js now imports (city-catalogue.js).
    "  offeredCityNames, loadCityCatalogue,\n" +
    "  GENDER_OPTIONS, GENDER_VALUES,\n" +
    "  profileSectionsStateKey, resolveSectionState, toggleSectionState,\n" +
    "  splitE164, composeE164, canonicalE164, defaultCountryFor, phonePartsError, PHONE_PICK_COUNTRY_MESSAGE,\n" +
    "  phoneEditNeedsVerify,\n" +
    "  phoneCurrentNeedsVerify, PHONE_VERIFY_REQUEST_EVENT,\n" +
    "  isPhoneCollision, PHONE_RECOVERY_MAILTO, PHONE_RECOVERY_PROMPT, PHONE_RECOVERY_LINK_TEXT, PHONE_RECOVERY_SUFFIX,\n" +
    "  verifiedPhoneRequired,\n" +
    "  nextDayInterestsNudge,\n" +
    "  COUNTRIES, flagOf,\n" +
    "  normaliseInterestConfig, savedInterestLabels, interestChipsModel, catalogueGroups, toggleInterest, selectionError,\n" +
    "  profileMembershipRow, profileManageAffordance, membershipEnabled, MEMBERSHIP_ROUTE,\n" +
    "} = globalThis.__PROFILE_DEPS__;\n";

  const seam = "\nexport function __setShell(s){ shell = s; }\n" +
    "export { applyNameLock, buildField, FIELDS };\n";

  const stripped = withoutImports.replace(/gstatic\.com|from ["']\.\//, "");
  assert.doesNotMatch(preamble + stripped, /^import[\s\S]*?from/m, "all top-level imports must be replaced before eval");

  const code = preamble + stripped + seam;
  globalThis.__PROFILE_DEPS__ = deps;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

// The pure profile-core models profile.js delegates to (import-safe — no CDN).
const core = await import(new URL("../src/assets/profile-core.js", import.meta.url));
const reverifyCore = await import(new URL("../src/assets/phone-reverify-core.js", import.meta.url));
const countries = await import(new URL("../src/assets/countries.js", import.meta.url));
const interestsCore = await import(new URL("../src/assets/interests-core.js", import.meta.url));
const avatarEvents = await import(new URL("../src/assets/avatar-events.js", import.meta.url));
const membershipTier = await import(new URL("../src/assets/membership-tier.js", import.meta.url));

// The injected dependency kit — REAL pure cores where import-safe, controllable fakes for the rest.
// applyNameLock touches none of the network/UI fakes; they exist only so the module loads.
const deps = {
  getMe: async () => ({}),
  updateMe: async () => ({}),
  getMembership: async () => ({}),
  getInterestCatalogue: async () => null,
  getInterestConfig: async () => null,
  ApiError,
  currentUser: () => null,
  signOut: async () => {},
  startPhoneVerify: async () => "fake-verification-id",
  confirmPhoneLink: async () => ({}),
  attachOtpInput: () => ({ boxes: [], value: () => "", setValue: () => {}, clear: () => {}, focus: () => {} }),
  attachResendCooldown: () => ({ start: () => {}, reset: () => {}, isActive: () => false, syncDisabled: () => {} }),
  isStorageConfigured: () => false,
  uploadAvatar: async () => "",
  validateAvatarFile: () => "",
  MAX_AVATAR_BYTES: 5 * 1024 * 1024,
  onAvatarChanged: () => {},
  announceAvatarChanged: avatarEvents.announceAvatarChanged,
  onAvatarChangedEvent: avatarEvents.onAvatarChangedEvent,
  isNativeCameraAvailable: () => false,
  captureAvatarImage: async () => null,
  clear: (node) => {
    if (node) node._children = [];
    return node;
  },
  confirmDialog: async () => true,
  el: fakeElBuilder,
  modal: () => ({ close: () => {} }),
  toast: () => {},
  doodle: () => fakeElBuilder("span"),
  renderAccountBadges: () => null,
  buildSecuritySettings: () => fakeElBuilder("section"),
  buildAppearanceSettings: () => fakeElBuilder("section"),
  PROFILE_PUBLIC_ROUTE: core.PROFILE_PUBLIC_ROUTE,
  profileMode: core.profileMode,
  identitySummary: core.identitySummary,
  accountContact: core.accountContact,
  profileStrength: core.profileStrength,
  strengthRingGeometry: core.strengthRingGeometry,
  publicSummary: core.publicSummary,
  validateProfileField: core.validateProfileField,
  NOTIFICATION_PREFS: core.NOTIFICATION_PREFS,
  CITY_OPTIONS: core.CITY_OPTIONS,
  cityChoiceError: core.cityChoiceError,
  // TM-1165: catalogue-driven city dropdown — fallback names + resolved-promise no-op under Node.
  offeredCityNames: () => [...core.CITY_OPTIONS],
  loadCityCatalogue: () => Promise.resolve([...core.CITY_OPTIONS]),
  // TM-955 gender buckets + TM-879 collapsible-sections model — REAL pure cores (import-safe), so the
  // module loads with the exact shipped data the (untested-here) gender field + section render use.
  GENDER_OPTIONS: core.GENDER_OPTIONS,
  GENDER_VALUES: core.GENDER_VALUES,
  profileSectionsStateKey: core.profileSectionsStateKey,
  resolveSectionState: core.resolveSectionState,
  toggleSectionState: core.toggleSectionState,
  splitE164: core.splitE164,
  composeE164: core.composeE164,
  canonicalE164: core.canonicalE164,
  phoneEditNeedsVerify: core.phoneEditNeedsVerify,
  phoneCurrentNeedsVerify: core.phoneCurrentNeedsVerify,
  PHONE_VERIFY_REQUEST_EVENT: reverifyCore.PHONE_VERIFY_REQUEST_EVENT,
  isPhoneCollision: reverifyCore.isPhoneCollision,
  PHONE_RECOVERY_MAILTO: reverifyCore.PHONE_RECOVERY_MAILTO,
  PHONE_RECOVERY_PROMPT: reverifyCore.PHONE_RECOVERY_PROMPT,
  PHONE_RECOVERY_LINK_TEXT: reverifyCore.PHONE_RECOVERY_LINK_TEXT,
  PHONE_RECOVERY_SUFFIX: reverifyCore.PHONE_RECOVERY_SUFFIX,
  verifiedPhoneRequired: () => true,
  defaultCountryFor: core.defaultCountryFor,
  phonePartsError: core.phonePartsError,
  PHONE_PICK_COUNTRY_MESSAGE: core.PHONE_PICK_COUNTRY_MESSAGE,
  nextDayInterestsNudge: core.nextDayInterestsNudge,
  COUNTRIES: countries.COUNTRIES,
  flagOf: countries.flagOf,
  normaliseInterestConfig: interestsCore.normaliseInterestConfig,
  savedInterestLabels: interestsCore.savedInterestLabels,
  interestChipsModel: interestsCore.interestChipsModel,
  catalogueGroups: interestsCore.catalogueGroups,
  toggleInterest: interestsCore.toggleInterest,
  selectionError: interestsCore.selectionError,
  profileMembershipRow: membershipTier.profileMembershipRow,
  profileManageAffordance: membershipTier.profileManageAffordance,
  membershipEnabled: () => false,
  MEMBERSHIP_ROUTE: "#/membership",
};

// A minimal fake window so the module's top-level wiring (the TM-1005 handoff listener) registers.
globalThis.window = {
  addEventListener: () => {},
  location: { hash: "" },
};

const profile = await loadProfileModule(deps);

// The allowed-characters hint copy carried by the name fields (profile.js NAME_HINT) — asserted so the
// carve-out/unlock tests prove the REAL hint text survives, not just "a hint node exists".
const NAME_HINT = "Letters, spaces, hyphens and apostrophes only.";

// Build a shell whose name entries expose { input, hint } — the surface applyNameLock reads/toggles.
// Each name field gets a hint <p> that starts VISIBLE (hidden=false), mirroring the shipped buildField
// (which renders the char-hint un-hidden). Pass values to preset the input text (empty = the carve-out).
function makeShell(values = {}) {
  const fields = new Map();
  for (const f of profile.FIELDS) {
    const input = wireClassList(fakeEl("input"));
    input.value = values[f.key] ?? "";
    const entry = { input, error: wireClassList(fakeEl("p")) };
    if (f.hint) {
      const hint = wireClassList(fakeEl("p"));
      hint.textContent = f.hint;
      hint.hidden = false;
      entry.hint = hint;
    }
    fields.set(f.key, entry);
  }
  const nameLockNote = wireClassList(fakeEl("p"));
  nameLockNote.hidden = true;
  return { fields, nameLockNote };
}

function nameEntry(shell, key) {
  return shell.fields.get(key);
}

// ── LOCKED, non-empty name field: padlock class + tooltip + NO char-hint ──────────────────────────
test("a locked non-empty name field gets the padlock class + a WHY tooltip, and its char-hint is hidden", () => {
  const shell = makeShell({ firstName: "Ada", lastName: "Lovelace" });
  profile.__setShell(shell);
  profile.applyNameLock({ nameLocked: true });

  for (const key of ["firstName", "lastName"]) {
    const entry = nameEntry(shell, key);
    assert.equal(entry.input.readOnly, true, `${key} is frozen (readOnly)`);
    assert.ok(entry.input.classList.contains("tm-input-locked"),
      `${key} carries .tm-input-locked (the CSS padlock adornment hangs off this class)`);
    const title = entry.input.getAttribute("title");
    assert.ok(title && /lock/i.test(title),
      `${key} exposes a WHY tooltip via the native title attribute (got: ${JSON.stringify(title)})`);
    assert.equal(entry.hint.hidden, true, `${key}'s allowed-characters hint is HIDDEN on a field you can't edit`);
  }
});

// ── UNLOCKED account: no padlock, no tooltip, hint kept ───────────────────────────────────────────
test("an unlocked name field shows no padlock, no tooltip, and keeps its normal char-hint", () => {
  const shell = makeShell({ firstName: "Ada", lastName: "Lovelace" });
  profile.__setShell(shell);
  profile.applyNameLock({ nameLocked: false });

  for (const key of ["firstName", "lastName"]) {
    const entry = nameEntry(shell, key);
    assert.equal(entry.input.readOnly, false, `${key} stays editable when the account isn't locked`);
    assert.equal(entry.input.classList.contains("tm-input-locked"), false, `${key} shows NO padlock`);
    assert.equal(entry.input.getAttribute("title"), null, `${key} shows NO tooltip`);
    assert.equal(entry.hint.hidden, false, `${key} KEEPS its char-hint`);
    assert.equal(entry.hint.textContent, NAME_HINT, `${key}'s hint text is unchanged`);
  }
});

// ── CARVE-OUT: locked account BUT an EMPTY name field is NOT treated as locked ─────────────────────
test("the locked-but-EMPTY carve-out field gets NO padlock/tooltip and KEEPS its hint (still settable once)", () => {
  // Account locked, but lastName is EMPTY — the carve-out keeps it editable so a display-name-only
  // attendee can still SET it once. firstName is set, so it IS frozen (the affordances there prove the
  // two are handled independently in the same pass).
  const shell = makeShell({ firstName: "Ada", lastName: "" });
  profile.__setShell(shell);
  profile.applyNameLock({ nameLocked: true });

  const empty = nameEntry(shell, "lastName");
  assert.equal(empty.input.readOnly, false, "the empty name stays editable (carve-out)");
  assert.equal(empty.input.classList.contains("tm-input-locked"), false, "no padlock on the carve-out field");
  assert.equal(empty.input.getAttribute("title"), null, "no tooltip on the carve-out field");
  assert.equal(empty.hint.hidden, false, "the carve-out field KEEPS its char-hint");
  assert.equal(empty.hint.textContent, NAME_HINT, "carve-out hint text is the real NAME_HINT");

  // Sanity: the sibling non-empty field IS frozen with the full affordance set in the same call.
  const frozen = nameEntry(shell, "firstName");
  assert.equal(frozen.input.readOnly, true, "the set name IS frozen");
  assert.ok(frozen.input.classList.contains("tm-input-locked"), "the set name gets the padlock");
  assert.equal(frozen.hint.hidden, true, "the set name's hint is hidden");
});

// ── REVERSIBILITY: a repaint that unlocks (admin correction) clears all three affordances ──────────
test("unlocking on repaint reverses the padlock, tooltip AND hint-hiding (admin correction is honoured)", () => {
  const shell = makeShell({ firstName: "Ada", lastName: "Lovelace" });
  profile.__setShell(shell);

  // First: locked → affordances applied.
  profile.applyNameLock({ nameLocked: true });
  assert.ok(nameEntry(shell, "firstName").input.classList.contains("tm-input-locked"), "precondition: locked");
  assert.equal(nameEntry(shell, "firstName").hint.hidden, true, "precondition: hint hidden");

  // Then: same fields, account now UNlocked (idempotent, reversible repaint).
  profile.applyNameLock({ nameLocked: false });
  for (const key of ["firstName", "lastName"]) {
    const entry = nameEntry(shell, key);
    assert.equal(entry.input.readOnly, false, `${key} unfrozen after unlock`);
    assert.equal(entry.input.classList.contains("tm-input-locked"), false, `${key} padlock cleared`);
    assert.equal(entry.input.getAttribute("title"), null, `${key} tooltip cleared`);
    assert.equal(entry.hint.hidden, false, `${key} char-hint restored`);
  }
});
