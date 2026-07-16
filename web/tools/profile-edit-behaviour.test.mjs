// P1 behavioural characterization tests for the Profile edit screen driver, profile.js (TM-738
// coverage audit, profile surface). Framework-free — Node's built-in test runner, picked up by the CI
// glob `node --test web/tools/*.test.mjs`.
//
// WHAT THIS COVERS (all EXISTING behaviour — these must pass GREEN, no source change):
//   • collectPatchOmitsBlankOptionalFields — collectPatch() trims values, coerces age to a number, and
//     OMITS blank optional fields (so an untouched field means "no change" and a blank phone is never
//     sent as "" — the server pattern would reject that, TM-188).
//   • clientValidateFieldMirrorsBackendAgePhone — validateField() mirrors the backend UpdateMeRequest
//     rules (age 13–120 integer; phone the same lenient pattern) so the browser fails fast on exactly
//     what the server would reject, and an empty field is always allowed (never blocks clearing).
//   • identitySummaryDoesNotRenderNameAsHtml — paintHub() paints a backend-supplied name via
//     textContent (never innerHTML), so a name containing markup lands as inert TEXT, not parsed HTML.
//   • saveSurfacesRfc7807FieldErrorsInline — on a 400 ApiError with per-field errors, save() attaches
//     each message to its field (setFieldError) instead of only toasting.
//   • saveShowsRetryToastReEnablesButton — on a non-field save error, save() toasts a retry message and
//     ALWAYS re-enables + restores the Save button (finally), so a transient failure isn't a dead end.
//   • profileLoadRendersRetryableErrorState — a failed GET /me sets a retryable error and renderStatus()
//     paints a Retry control instead of hanging on the loading state.
//
// TM-781 (mandatory phone country picker) adds behavioural coverage for the renderer wiring:
//   • buildField(phone) renders the picker BEFORE the national input, options read
//     "<emoji flag> <Country name> +<dial>", GB/AE pinned first, and the picker always has a selection;
//   • fillForm splits a saved E.164 back into picker + national (longest dial wins), soft-defaults
//     the picker from the city when no phone is saved (without overriding an explicit user pick),
//     and puts a legacy bare number into the explicit confirm-country state;
//   • collectPatch composes E.164 from picker + national on save (blank stays blank — never a
//     dial-code-only value) and save is blocked while the legacy confirm state is unresolved;
//   • (review fixes) an untouched phone survives an unrelated save byte-identical — NANP secondary
//     codes and Italy's kept trunk 0 included — and the confirm-country prompt marks the PICKER
//     (not the national input) aria-invalid.
//
// profile.js STATICALLY imports the app's ES modules (api.js → Firebase CDN chain, ui.js, auth.js, …),
// so it cannot be `import`ed under `node --test`. Like storage-validate-avatar.test.mjs we load the REAL
// source and evaluate it as a data: URL, but here we ALSO inject the module's dependencies (a tiny fake
// `el`/`toast`/`getMe`/`updateMe`/`ApiError`/… kit) via a global and append a small TEST SEAM (a shell
// setter + internal-function exports) to the eval copy ONLY. The function bodies under test are the
// exact shipped source — a behavioural proof, not a re-implementation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// The real ApiError shape (api.js): a 400 carries per-field `fieldErrors` [{field, message}].
class ApiError extends Error {
  constructor(status, message, fieldErrors = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

// --- A minimal fake document: enough of the DOM surface the tested paths touch --------------------
// Crucially textContent is stored as an OPAQUE string (never HTML-parsed) — mirroring the real browser
// sink — so an untrusted, markup-looking name can only ever become inert text through it.
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
    innerHTML: undefined, // present but UNUSED — if the code ever wrote here, tests would notice.
    hidden: false,
    disabled: false,
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
    // Captured listeners so tests can drive user events (e.g. the phone country picker's `change`).
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

/** Install a fake `document` for the duration of a callback, then restore it. */
function withFakeDocument(run) {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: (tag) => wireClassList(fakeEl(tag)),
    createTextNode: (str) => ({ nodeType: 3, data: String(str) }),
    getElementById: () => null,
  };
  try {
    return run();
  } finally {
    globalThis.document = prior;
  }
}

// A fake `el(tag, attrs, children)` matching ui.js's contract closely enough for the tested paths:
// text via textContent (never innerHTML), attrs applied, children appended.
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

// The captured toast calls, so tests can assert what the user was told.
let TOASTS = [];

// Load profile.js: strip its import block, inject the module's dependencies via a destructure from a
// global, and append a small TEST SEAM (shell setter + state getter + internal-function exports). The
// evaluated function bodies are the exact shipped source.
function loadProfileModule(deps) {
  const src = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");

  // Replace the whole top import region (the contiguous run of `import … ;` statements) with a single
  // destructure from the injected deps global. Every symbol the module names is provided there.
  const withoutImports = src.replace(/^import[\s\S]*?;\s*$/gm, "");
  const preamble = "const {\n" +
    "  getMe, updateMe, getMembership, getInterestCatalogue, getInterestConfig, ApiError,\n" +
    "  currentUser, signOut,\n" +
    "  isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES,\n" +
    "  onAvatarChanged, isNativeCameraAvailable, captureAvatarImage,\n" +
    "  clear, el, modal, toast, doodle, renderAccountBadges,\n" +
    "  buildSecuritySettings, buildAppearanceSettings,\n" +
    "  PROFILE_PUBLIC_ROUTE, profileMode, identitySummary, accountContact, profileStrength, publicSummary,\n" +
    "  validateProfileField, NOTIFICATION_PREFS,\n" +
    "  splitE164, composeE164, defaultCountryFor, phonePartsError, PHONE_PICK_COUNTRY_MESSAGE,\n" +
    "  nextDayInterestsNudge,\n" +
    "  COUNTRIES, flagOf,\n" +
    "  normaliseInterestConfig, savedInterestLabels, interestChipsModel, catalogueGroups, toggleInterest, selectionError,\n" +
    "  profileMembershipRow, membershipEnabled, MEMBERSHIP_ROUTE,\n" +
    "} = globalThis.__PROFILE_DEPS__;\n";

  // A test seam appended to the eval copy only: reach the module-private shell/state + internals.
  const seam = "\nexport function __setShell(s){ shell = s; }\n" +
    "export function __getState(){ return state; }\n" +
    "export { validateField, collectPatch, save, load, paintHub, renderStatus, setFieldError, FIELDS, fillForm, buildField };\n";

  const stripped = withoutImports.replace(/gstatic\.com|from ["']\.\//, "");
  assert.doesNotMatch(preamble + stripped, /^import[\s\S]*?from/m, "all top-level imports must be replaced before eval");

  const code = preamble + stripped + seam;
  globalThis.__PROFILE_DEPS__ = deps;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

// Build the injected dependency kit. Uses the REAL pure profile-core models (identitySummary etc.) so
// paintHub paints exactly what ships; the network + UI functions are controllable fakes.
const coreUrl = new URL("../src/assets/profile-core.js", import.meta.url);
const core = await import(coreUrl);
// The country picker data (TM-781) — import-safe pure data, so the REAL list/flags are injected and
// the option-rendering test proves the exact shipped "<flag> <name> +<dial>" strings.
const countriesUrl = new URL("../src/assets/countries.js", import.meta.url);
const countries = await import(countriesUrl);
const membershipTierUrl = new URL("../src/assets/membership-tier.js", import.meta.url);
// The TM-778 Interests-card pure core — import-safe (no CDN), so inject the REAL functions the card maps
// over. The api-side catalogue/config helpers are best-effort fakes (null = unavailable, the non-admin
// degrade path) so paintInterests/loadInterestsMeta run without a network.
const interestsCoreUrl = new URL("../src/assets/interests-core.js", import.meta.url);
const interestsCore = await import(interestsCoreUrl);

let getMeImpl = async () => ({});
let updateMeImpl = async () => ({});
let getMembershipImpl = async () => ({});
let currentUserImpl = () => null;

const deps = {
  getMe: (...a) => getMeImpl(...a),
  updateMe: (...a) => updateMeImpl(...a),
  getMembership: (...a) => getMembershipImpl(...a),
  // Interests-card api helpers (TM-778): best-effort, so returning null (the "catalogue/config not
  // readable" degrade path) is a valid response the card handles — VIEW + REMOVE work off /me alone.
  getInterestCatalogue: async () => null,
  getInterestConfig: async () => null,
  ApiError,
  currentUser: (...a) => currentUserImpl(...a),
  signOut: async () => {},
  isStorageConfigured: () => false,
  uploadAvatar: async () => "",
  validateAvatarFile: () => "",
  MAX_AVATAR_BYTES: 5 * 1024 * 1024,
  onAvatarChanged: () => {},
  isNativeCameraAvailable: () => false,
  captureAvatarImage: async () => null,
  clear: (node) => {
    if (node) node._children = [];
    return node;
  },
  el: fakeElBuilder,
  // A no-op modal that returns the real `{ close }` handle shape (openInterestPicker calls dialog.close()).
  modal: () => ({ close: () => {} }),
  toast: (msg, opts) => {
    TOASTS.push({ msg, opts });
  },
  doodle: () => fakeElBuilder("span"),
  renderAccountBadges: () => null,
  buildSecuritySettings: () => fakeElBuilder("section"),
  buildAppearanceSettings: () => fakeElBuilder("section"),
  PROFILE_PUBLIC_ROUTE: core.PROFILE_PUBLIC_ROUTE,
  profileMode: core.profileMode,
  identitySummary: core.identitySummary,
  accountContact: core.accountContact,
  profileStrength: core.profileStrength,
  publicSummary: core.publicSummary,
  // profile.js's validateField delegates to the pure validateProfileField in profile-core.js (TM-763):
  // inject the REAL one so the eval copy's validation runs instead of throwing ReferenceError under Node 20.
  validateProfileField: core.validateProfileField,
  // fillForm reads NOTIFICATION_PREFS for the select default — inject the real set (it was never
  // needed before TM-781 because no test exercised fillForm through the eval copy).
  NOTIFICATION_PREFS: core.NOTIFICATION_PREFS,
  // The TM-781 phone-picker pure logic + country data — the REAL implementations, so these tests
  // prove the shipped split/compose/default rules through the renderer's own wiring.
  splitE164: core.splitE164,
  composeE164: core.composeE164,
  defaultCountryFor: core.defaultCountryFor,
  phonePartsError: core.phonePartsError,
  // setFieldError compares against this to decide whether the COUNTRY PICKER (not the national
  // input) is the control at fault — the real constant, so the comparison is the shipped one.
  PHONE_PICK_COUNTRY_MESSAGE: core.PHONE_PICK_COUNTRY_MESSAGE,
  // TM-777 (I5): paintHub calls this to decide the next-day interests CTA — the REAL pure decision,
  // so the renderer's hidden/message wiring runs through the shipped logic.
  nextDayInterestsNudge: core.nextDayInterestsNudge,
  COUNTRIES: countries.COUNTRIES,
  flagOf: countries.flagOf,
  // TM-778 interests-core: the REAL pure functions the card maps over, so paintInterests/openInterestPicker
  // run the shipped chip/grouping/toggle logic through the renderer under Node.
  normaliseInterestConfig: interestsCore.normaliseInterestConfig,
  savedInterestLabels: interestsCore.savedInterestLabels,
  interestChipsModel: interestsCore.interestChipsModel,
  catalogueGroups: interestsCore.catalogueGroups,
  toggleInterest: interestsCore.toggleInterest,
  selectionError: interestsCore.selectionError,
  // membership-tier.js is import-safe (no CDN); use the real pure mapping.
  profileMembershipRow: (await import(membershipTierUrl)).profileMembershipRow,
  membershipEnabled: () => false,
  MEMBERSHIP_ROUTE: "#/membership",
};

const profile = await loadProfileModule(deps);

// A field descriptor lookup by key, straight off the module's own FIELDS list — so validateField is
// exercised against the EXACT shipped rules, not a copy.
function field(key) {
  const f = profile.FIELDS.find((x) => x.key === key);
  assert.ok(f, `FIELDS must contain '${key}'`);
  return f;
}

// Build a fake shell whose fields expose { input:{value} } — the surface collectPatch/validateAll read.
// The phone entry also carries the TM-781 `country` picker: a fake <select> whose .value is the
// selected iso2 ("" = the legacy confirm-country placeholder). Defaults to GB — like the real
// picker, it always has a selection; pass `phoneCountry` in `values` to override (or "" to start
// in the confirm state).
function makeShell(values = {}) {
  const fields = new Map();
  for (const f of profile.FIELDS) {
    const input = wireClassList(fakeEl("input"));
    input.value = values[f.key] ?? "";
    const errorNode = wireClassList(fakeEl("p"));
    errorNode.hidden = true;
    const entry = { input, error: errorNode };
    if (f.key === "phone") {
      const country = wireClassList(fakeEl("select"));
      country.value = values.phoneCountry ?? "GB";
      entry.country = country;
    }
    fields.set(f.key, entry);
  }
  const saveBtn = wireClassList(fakeEl("button"));
  saveBtn.textContent = "Save changes";
  const status = wireClassList(fakeEl("div"));
  const root = wireClassList(fakeEl("div"));
  const hub = {
    name: wireClassList(fakeEl("div")),
    meta: wireClassList(fakeEl("div")),
    initial: wireClassList(fakeEl("span")),
    email: wireClassList(fakeEl("div")),
    phone: wireClassList(fakeEl("div")),
    bar: wireClassList(fakeEl("i")),
    barPct: wireClassList(fakeEl("span")),
    barNudge: wireClassList(fakeEl("span")),
    // TM-777 (I5): the next-day interests CTA button paintHub toggles hidden + sets text on.
    barInterestsCta: wireClassList(fakeEl("button")),
  };
  return { fields, save: saveBtn, status, root, hub, badges: null, membership: null, form: wireClassList(fakeEl("form")) };
}

// ---- collectPatchOmitsBlankOptionalFields -----------------------------------------------------

test("collectPatch trims values, coerces age to a number, and includes only filled fields", () => {
  const shell = makeShell({ firstName: "  Ada  ", city: "London", age: " 36 ", phone: "" });
  profile.__setShell(shell);
  const patch = profile.collectPatch();

  assert.equal(patch.firstName, "Ada", "text is trimmed");
  assert.equal(patch.city, "London");
  assert.equal(patch.age, 36, "age is coerced to a number");
  assert.equal(typeof patch.age, "number");
});

test("collectPatch OMITS blank optional fields — a blank phone is never sent as '' (TM-188)", () => {
  const shell = makeShell({ firstName: "Ada", phone: "   ", city: "" });
  profile.__setShell(shell);
  const patch = profile.collectPatch();

  assert.ok(!("phone" in patch), "a blank phone is omitted, not sent as '' (the server pattern rejects '')");
  assert.ok(!("city" in patch), "a blank optional text field is omitted (untouched = no change)");
  assert.deepEqual(Object.keys(patch), ["firstName"], "only the one filled field is in the patch");
});

test("collectPatch omits an empty age rather than sending 0", () => {
  const shell = makeShell({ firstName: "Ada", age: "" });
  profile.__setShell(shell);
  const patch = profile.collectPatch();
  assert.ok(!("age" in patch), "an empty number field means 'no change', not 0");
});

// ---- clientValidateFieldMirrorsBackendAgePhone ------------------------------------------------

test("validateField: age mirrors the backend 13–120 integer range", () => {
  const age = field("age");
  assert.equal(profile.validateField(age, "36"), "", "an in-range whole number is accepted");
  assert.equal(profile.validateField(age, "13"), "", "the lower bound (13) is inclusive");
  assert.equal(profile.validateField(age, "120"), "", "the upper bound (120) is inclusive");
  assert.match(profile.validateField(age, "12"), /13 or more/, "below 13 is rejected (matches @Min(13))");
  assert.match(profile.validateField(age, "121"), /120 or less/, "above 120 is rejected (matches @Max(120))");
  assert.match(profile.validateField(age, "36.5"), /whole number/, "a non-integer age is rejected");
});

// TM-781 contract change: the phone input now holds the NATIONAL number and validateField reads the
// country picker beside it — the old whole-value "lenient pattern" test is superseded by this pair.
test("validateField: phone validates the (picker, national) pair (TM-781)", () => {
  const phone = field("phone");
  profile.__setShell(makeShell({ phoneCountry: "GB" }));
  assert.equal(profile.validateField(phone, "7700 900123"), "", "national number + picked country is accepted");
  assert.equal(profile.validateField(phone, "(020) 7946-0958"), "", "separators are still allowed");
  assert.match(profile.validateField(phone, "not-a-phone!"), /invalid/i, "letters/'!' fail the pattern");
  assert.match(profile.validateField(phone, "12"), /7 to 15/, "too few digits fails the TM-752 guard");
  assert.match(
    profile.validateField(phone, "+44 7700 900123"),
    /country|national/i,
    "a pasted +dial number is redirected to the picker (never double-composed)",
  );
  // The legacy confirm-country state ('' selection) blocks any non-blank number until confirmed.
  profile.__setShell(makeShell({ phoneCountry: "" }));
  assert.match(profile.validateField(phone, "7700900123"), /country/i);
});

test("validateField: first name / last name / city reject purely numeric input (TM-771)", () => {
  // Ghalia's repro: "676767" in any of the three name-like fields saved with "Profile saved.".
  // The rule lives in profile-core's validateProfileField; this pins the delegate wiring end-to-end.
  assert.match(profile.validateField(field("firstName"), "676767"), /letter/i);
  assert.match(profile.validateField(field("lastName"), "676767"), /letter/i);
  assert.match(profile.validateField(field("city"), "676767"), /letter/i);
  assert.equal(profile.validateField(field("firstName"), "Jean-Luc"), "", "hyphenated names are accepted");
  assert.equal(profile.validateField(field("city"), "St. Albans"), "", "period + space in a city is accepted");
});

test("validateField: an empty value is always allowed (clearing a field is never blocked)", () => {
  profile.__setShell(makeShell()); // picker present (GB) — a blank national must still be allowed
  assert.equal(profile.validateField(field("age"), ""), "");
  assert.equal(profile.validateField(field("phone"), "   "), "");
  assert.equal(profile.validateField(field("firstName"), ""), "");
});

// ---- identitySummaryDoesNotRenderNameAsHtml ---------------------------------------------------

test("paintHub paints a backend name as inert TEXT (textContent), never parsed HTML", () => {
  withFakeDocument(() => {
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => ({ photoURL: null });

    const evilName = "<img src=x onerror=alert(1)>";
    // A /me payload whose firstName carries markup — through identitySummary → paintHub.
    profile.paintHub({ firstName: evilName, lastName: "Zero", city: "London", age: 30 });

    // The name node received the value via textContent — stored verbatim as text, NEVER through an
    // HTML sink. So the markup is inert: it is present as literal characters, not a parsed <img> node.
    assert.equal(shell.hub.name._textContent, "<img src=x onerror=alert(1)> Z.");
    assert.equal(shell.hub.name.innerHTML, undefined, "paintHub must not write innerHTML");
    // The children list stays empty (no parsed element was inserted) — textContent doesn't append nodes.
    assert.equal(shell.hub.name._children.length, 0);
  });
});

// ---- nextDayInterestsCtaRenderWiring (TM-777 / I5) --------------------------------------------
// paintHub is the ONLY place the pure nextDayInterestsNudge decision reaches the DOM: it toggles the
// CTA button's `hidden` and paints its message, then stamps "shown today" in localStorage so the
// same-day suppression fires next paint. These pin that render/persist path (previously the harness
// only wired the fake node so the pre-existing XSS test kept passing — no assertion on the CTA itself).

/** Install a fake `localStorage` (Map-backed) for a callback, capturing writes; restore after. */
function withFakeLocalStorage(run) {
  const prior = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    return run(store);
  } finally {
    globalThis.localStorage = prior;
  }
}

test("paintHub reveals the interests CTA + paints its message when the user has exactly 1 interest", () => {
  withFakeDocument(() => {
    withFakeLocalStorage((store) => {
      const shell = makeShell();
      profile.__setShell(shell);
      currentUserImpl = () => ({ uid: "u1", photoURL: null });

      // A REAL /me shape (interests array, NO interestsMax) with exactly one pick, never prompted
      // (empty localStorage) → the nudge is due.
      profile.paintHub({ firstName: "Ada", interests: [{ label: "hiking", category: "outdoors" }] });

      assert.equal(shell.hub.barInterestsCta.hidden, false, "the CTA is revealed when the nudge is due");
      // The message names the honest max (3): 1 picked → "add 2 more" — NOT sourced from a phantom config field.
      assert.match(shell.hub.barInterestsCta.textContent, /add 2 more/i);
      assert.match(shell.hub.barInterestsCta.textContent, /so people find you/i);
      // The "shown today" stamp was written per-uid so the same-day suppression fires next paint.
      const stamped = store.get("tm.i5.interestsNudge.v1.u1");
      assert.ok(stamped, "paintHub stamps the last-shown timestamp in localStorage");
      assert.ok(!Number.isNaN(Date.parse(stamped)), "the stamp is a parseable ISO timestamp");
    });
  });
});

test("paintHub keeps the interests CTA hidden + writes no stamp when the nudge is NOT due", () => {
  withFakeDocument(() => {
    withFakeLocalStorage((store) => {
      const shell = makeShell();
      profile.__setShell(shell);
      currentUserImpl = () => ({ uid: "u1", photoURL: null });

      // 2 picks (already engaged) → silent: the CTA stays hidden and nothing is persisted.
      profile.paintHub({
        firstName: "Ada",
        interests: [
          { label: "hiking", category: "outdoors" },
          { label: "chess", category: "games" },
        ],
      });

      assert.equal(shell.hub.barInterestsCta.hidden, true, "the CTA stays hidden when not due");
      assert.equal(store.size, 0, "no last-shown stamp is written when the nudge is suppressed");
    });
  });
});

// ---- saveSurfacesRfc7807FieldErrorsInline -----------------------------------------------------

test("save attaches a 400 ApiError's per-field messages to their fields (not just a toast)", async () => {
  await withFakeDocumentAsync(async () => {
    TOASTS = [];
    const shell = makeShell({ firstName: "Ada", age: "200" }); // age is invalid client-side? 200>120
    // Give a value that PASSES client validation so we reach the server error path deterministically.
    shell.fields.get("age").input.value = "36";
    profile.__setShell(shell);

    updateMeImpl = async () => {
      throw new ApiError(400, "Validation failed", [{ field: "firstName", message: "First name is too long." }]);
    };

    await profile.save({ preventDefault() {} });

    // The per-field message is attached to the firstName field's error node...
    assert.equal(shell.fields.get("firstName").error.textContent, "First name is too long.");
    assert.equal(shell.fields.get("firstName").error.hidden, false, "the field error is shown");
    assert.equal(
      shell.fields.get("firstName").input.getAttribute("aria-invalid"),
      "true",
      "the invalid field is marked aria-invalid for a11y",
    );
    // ...and the Save button is re-enabled + its label restored (finally block).
    assert.equal(shell.save.disabled, false);
    assert.equal(shell.save.textContent, "Save changes");
  });
});

// ---- saveShowsRetryToastReEnablesButton -------------------------------------------------------

test("save toasts a retry message and re-enables the Save button on a non-field error", async () => {
  await withFakeDocumentAsync(async () => {
    TOASTS = [];
    const shell = makeShell({ firstName: "Ada" });
    profile.__setShell(shell);

    updateMeImpl = async () => {
      throw new Error("network down");
    };

    await profile.save({ preventDefault() {} });

    // A non-ApiError falls to the generic "Couldn't save your profile." toast...
    assert.ok(
      TOASTS.some((t) => /couldn't save/i.test(t.msg) && t.opts?.type === "error"),
      "an error toast is shown so the user knows to retry",
    );
    // ...and the button is ALWAYS restored so the form isn't left dead/disabled.
    assert.equal(shell.save.disabled, false, "the Save button is re-enabled in the finally block");
    assert.equal(shell.save.textContent, "Save changes", "the Save label is restored");
  });
});

// ---- profileLoadRendersRetryableErrorState ----------------------------------------------------

test("load surfaces a retryable error state (with a Retry control) when GET /me fails", async () => {
  await withFakeDocumentAsync(async () => {
    const shell = makeShell();
    profile.__setShell(shell);
    getMeImpl = async () => {
      throw new Error("boom");
    };
    getMembershipImpl = async () => ({}); // isolated, must not break the page

    await profile.load();

    const state = profile.__getState();
    assert.equal(state.error, "Could not load your profile.", "a retryable load error is recorded");
    assert.equal(state.loading, false, "loading is cleared in the finally block (no hang)");
    // renderStatus painted the error card into the status region; the form is hidden behind it.
    assert.equal(shell.form.hidden, true, "the form is hidden while the error state shows");
    // The loading-skeleton class is cleared so the hub skeleton never shimmers forever on a failure.
    assert.equal(shell.root.classList.contains("tm-pf-loading"), false);
  });
});

// ---- TM-781: phone country picker renderer wiring ---------------------------------------------

test("buildField(phone): the picker sits BEFORE the input and options read '<flag> <name> +<dial>'", () => {
  profile.__setShell(makeShell()); // the listeners' setFieldError path needs a shell to write to
  const built = profile.buildField(field("phone"));

  assert.ok(built.country, "the phone field exposes its country picker");
  // Option 0 is the (disabled, hidden) legacy confirm-country placeholder — selectable only
  // programmatically, so a user can never move the picker back to "no country".
  const opts = built.country._children;
  assert.equal(opts[0].getAttribute("value"), "");
  assert.equal(opts[0]._textContent, "Confirm country…");
  assert.equal(opts[0].disabled, true);
  // Options 1+2 are the pinned pair, in the exact "<emoji flag> <Country name> +<dial>" format.
  assert.equal(opts[1].getAttribute("value"), "GB");
  assert.equal(opts[1]._textContent, "🇬🇧 United Kingdom +44");
  assert.equal(opts[2].getAttribute("value"), "AE");
  assert.equal(opts[2]._textContent, "🇦🇪 United Arab Emirates +971");
  assert.equal(opts.length, countries.COUNTRIES.length + 1, "every country is offered (plus the placeholder)");

  // The picker renders BEFORE the national input inside the field row (the product rule).
  const row = built.wrapper._children[1]; // [label, control-row, hint, error]
  assert.equal(row._children[0], built.country);
  assert.equal(row._children[1], built.input);

  // The picker always has a selection (GB pre-load; fillForm applies the real value), and is labelled.
  assert.equal(built.country.value, "GB");
  assert.equal(built.country.getAttribute("aria-label"), "Phone country");

  // A user change marks the pick as explicit — fillForm's soft default must never override it.
  built.country._listeners.change();
  assert.equal(built.country.getAttribute("data-user-picked"), "true");
});

test("fillForm splits a saved E.164 back into picker + national — longest dial wins (TM-781)", () => {
  const shell = makeShell();
  profile.__setShell(shell);
  currentUserImpl = () => null;
  profile.fillForm({ phone: "+12425550123", city: "Nassau", notificationPref: "EMAIL" });

  assert.equal(shell.fields.get("phone").country.value, "BS", "+1242 (Bahamas) wins over +1 (US)");
  // The national part keeps its NANP area code — Bahamas composes on the shared "+1", so a later
  // save reproduces the stored value exactly (the review's split/compose symmetry fix).
  assert.equal(shell.fields.get("phone").input.value, "2425550123", "the input holds only the national part");
});

// TM-781 review (HIGH + MEDIUM): collectPatch re-composes and re-sends the phone on EVERY save, so
// split→compose asymmetry corrupted stored numbers the user never touched — a +1829… Dominican
// number re-composed onto +1809… (a different subscriber), and Italy's kept trunk 0 was stripped.
// Prove through the shipped fill→collect wiring that an untouched phone survives byte-identical.
test("an unrelated save never rewrites a stored phone — NANP secondary codes and Italy included", () => {
  const stored = ["+18295551234", "+18495551234", "+19395551234", "+16585551234", "+390612345678", "+447700900123"];
  for (const phone of stored) {
    const shell = makeShell({ firstName: "Ada" });
    profile.__setShell(shell);
    currentUserImpl = () => null;
    profile.fillForm({ phone, city: "London" }); // the user then edits e.g. their city and saves
    const patch = profile.collectPatch();
    assert.equal(patch.phone, phone, `${phone} must survive an untouched fill → save round-trip`);
  }
});

test("fillForm soft-defaults the picker from the city — but an explicit user pick survives (TM-781)", () => {
  const shell = makeShell();
  profile.__setShell(shell);
  currentUserImpl = () => null;

  profile.fillForm({ city: "Dubai" });
  assert.equal(shell.fields.get("phone").country.value, "AE", "city hint applies when no phone is saved");

  profile.fillForm({ city: "Springfield" });
  assert.equal(shell.fields.get("phone").country.value, "GB", "unknown city falls back to GB");

  // The user explicitly picks SA; a later refill (e.g. their city now says London) must NOT flip it —
  // the city is only ever a SOFT default.
  const country = shell.fields.get("phone").country;
  country.value = "SA";
  country.setAttribute("data-user-picked", "true");
  profile.fillForm({ city: "London" });
  assert.equal(country.value, "SA", "an explicit selection survives a refill");
});

test("fillForm puts a legacy bare number into the confirm-country state and save is blocked (TM-781)", async () => {
  await withFakeDocumentAsync(async () => {
    TOASTS = [];
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => null;
    profile.fillForm({ phone: "07700 900123" }); // stored pre-TM-781: no +dial → country unknown

    const entry = shell.fields.get("phone");
    assert.equal(entry.country.value, "", "the picker shows the explicit confirm-country placeholder");
    assert.equal(entry.input.value, "07700 900123", "the legacy digits are preserved for the user");
    assert.equal(entry.error.hidden, false, "the confirm-country prompt is painted immediately");
    assert.match(entry.error.textContent, /country/i);

    // Saving without confirming a country is blocked client-side — PATCH /me is never sent.
    let patched = false;
    updateMeImpl = async () => { patched = true; return {}; };
    await profile.save({ preventDefault() {} });
    assert.equal(patched, false, "no PATCH while the country is unconfirmed");
    assert.ok(TOASTS.some((t) => t.opts?.type === "error"), "the user is told to fix the highlighted field");

    // Confirming a country unblocks the save: the same digits now compose to E.164.
    entry.country.value = "GB";
    let sent = null;
    updateMeImpl = async (patch) => { sent = patch; return { phone: patch.phone }; };
    await profile.save({ preventDefault() {} });
    assert.equal(sent?.phone, "+447700900123", "confirmed country + legacy digits compose to E.164");
  });
});

// TM-781 review: the confirm-country prompt is a defect of the PICKER (its value is the ""
// placeholder), so aria-invalid + the red ring must land on the select — a screen-reader user
// tabbing through must not hear the perfectly fine national input announced as invalid.
test("the confirm-country prompt marks the PICKER invalid, not the national input", () => {
  const shell = makeShell();
  profile.__setShell(shell);
  currentUserImpl = () => null;
  profile.fillForm({ phone: "07700 900123" }); // legacy bare number → the confirm-country state

  const entry = shell.fields.get("phone");
  assert.equal(entry.country.getAttribute("aria-invalid"), "true", "the select is the control at fault");
  assert.ok(entry.country.classList.contains("tm-field-invalid"), "the red ring is on the select");
  assert.equal(entry.input.getAttribute("aria-invalid"), null, "the (fine) national input is not blamed");
  assert.equal(entry.input.classList.contains("tm-field-invalid"), false);

  // Confirming a country clears the picker's invalid state (the live re-validation path).
  entry.country.value = "GB";
  profile.setFieldError("phone", profile.validateField(field("phone"), entry.input.value));
  assert.equal(entry.country.getAttribute("aria-invalid"), null);
  assert.equal(entry.country.classList.contains("tm-field-invalid"), false);
  assert.equal(entry.error.hidden, true, "the prompt is gone once a country is picked");

  // A digit-guard error still faults the INPUT, exactly as before the picker existed.
  profile.setFieldError("phone", "Enter a valid phone number (7 to 15 digits).");
  assert.equal(entry.input.getAttribute("aria-invalid"), "true");
  assert.equal(entry.country.getAttribute("aria-invalid"), null);
});

test("collectPatch composes the E.164 phone from picker + national — blank stays blank (TM-781)", () => {
  let shell = makeShell({ firstName: "Ada", phone: " 07700 900123 ", phoneCountry: "GB" });
  profile.__setShell(shell);
  let patch = profile.collectPatch();
  assert.equal(patch.phone, "+447700900123", "composed on save: +dial + national (trunk 0 stripped)");

  shell = makeShell({ firstName: "Ada", phone: "   ", phoneCountry: "AE" });
  profile.__setShell(shell);
  patch = profile.collectPatch();
  assert.ok(!("phone" in patch), "a blank national number is omitted — never a dial-code-only '+971'");
});

// An async variant of withFakeDocument.
async function withFakeDocumentAsync(run) {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: (tag) => wireClassList(fakeEl(tag)),
    createTextNode: (str) => ({ nodeType: 3, data: String(str) }),
    getElementById: () => null,
  };
  try {
    return await run();
  } finally {
    globalThis.document = prior;
  }
}
