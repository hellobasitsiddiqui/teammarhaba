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
    // TM-913: the strength ring builds SVG-namespaced nodes (createElementNS). The tested paths don't
    // inspect the ring's internals, so a plain fake element is enough for it to mount without throwing.
    createElementNS: (_ns, tag) => wireClassList(fakeEl(tag)),
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
    // TM-982: the phone verify-and-link deps (auth OTP link, six-box widget, resend cooldown) — the
    // auth.js/otp-input.js/resend-cooldown.js modules can't be imported under Node (auth.js pulls the
    // Firebase CDN chain; the widgets touch the DOM), so import-safe FAKES are injected instead.
    "  startPhoneVerify, confirmPhoneLink, attachOtpInput, attachResendCooldown,\n" +
    "  isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES,\n" +
    // `onAvatarChanged` is the pre-TM-846 direct nav repaint; `announceAvatarChanged`/`onAvatarChangedEvent`
    // are the TM-846 broadcast pair. Both stay in the destructure so this harness loads the source from
    // either side of that change (the fail-before proof evals main's copy) — unused names are harmless.
    "  onAvatarChanged, announceAvatarChanged, onAvatarChangedEvent,\n" +
    "  isNativeCameraAvailable, captureAvatarImage,\n" +
    "  clear, el, modal, toast, doodle, renderAccountBadges,\n" +
    "  buildSecuritySettings, buildAppearanceSettings,\n" +
    "  PROFILE_PUBLIC_ROUTE, profileMode, identitySummary, accountContact, profileStrength, strengthRingGeometry, publicSummary,\n" +
    "  validateProfileField, NOTIFICATION_PREFS, CITY_OPTIONS, cityChoiceError,\n" +
    "  splitE164, composeE164, canonicalE164, defaultCountryFor, phonePartsError, PHONE_PICK_COUNTRY_MESSAGE,\n" +
    "  phoneEditNeedsVerify,\n" +
    // TM-1005: the pure "offer to verify the CURRENT, unchanged stored number" rule + the banner-CTA
    // handoff event name (from phone-reverify-core.js) — both referenced by the shipped source.
    "  phoneCurrentNeedsVerify, PHONE_VERIFY_REQUEST_EVENT,\n" +
    // TM-1009: the deploy-time verified-phone flag reader (verified-phone-flag.js). Injected as a
    // mutable fake defaulting to ON so every pre-flag test keeps its original TM-982 semantics
    // (flag ON = exactly the old behaviour); a test can flip it OFF via setVerifiedPhoneRequired.
    "  verifiedPhoneRequired,\n" +
    "  nextDayInterestsNudge,\n" +
    "  COUNTRIES, flagOf,\n" +
    "  normaliseInterestConfig, savedInterestLabels, interestChipsModel, catalogueGroups, toggleInterest, selectionError,\n" +
    "  profileMembershipRow, membershipEnabled, MEMBERSHIP_ROUTE,\n" +
    "} = globalThis.__PROFILE_DEPS__;\n";

  // A test seam appended to the eval copy only: reach the module-private shell/state + internals.
  const seam = "\nexport function __setShell(s){ shell = s; }\n" +
    "export function __getState(){ return state; }\n" +
    // TM-1005: the phone verify controller (sendBtn/otpWrap/statusEl handles) so the affordance tests
    // can assert visibility + label without re-walking the built wrapper tree.
    "export function __phoneVerify(){ return phoneVerify; }\n" +
    "export { validateField, collectPatch, save, load, paintHub, renderStatus, setFieldError, FIELDS, fillForm, buildField, buildAvatar };\n";

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
// TM-1005: the pure banner-CTA contract (the handoff event name) — import-safe, injected REAL so the
// profile's listener registers under the exact shipped event name.
const reverifyCoreUrl = new URL("../src/assets/phone-reverify-core.js", import.meta.url);
const reverifyCore = await import(reverifyCoreUrl);
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
// The TM-846 avatar-changed broadcast — dependency-free by design, so the REAL pub/sub is injected
// and the upload-success test proves the shipped announce → subscribers → repaint chain end-to-end.
const avatarEventsUrl = new URL("../src/assets/avatar-events.js", import.meta.url);
const avatarEvents = await import(avatarEventsUrl);

let getMeImpl = async () => ({});
let updateMeImpl = async () => ({});
let getMembershipImpl = async () => ({});
// Interests-card api helpers (TM-778): best-effort, so returning null (the "catalogue/config not
// readable" degrade path) is a valid default the card + loadInterestsMeta handle — VIEW + REMOVE work
// off /me alone. TM-777 (I5) reuses the SAME config fetch: a test can override getInterestConfigImpl to
// return `{ maxSelections }` and prove the config-driven max reaches the next-day CTA copy.
let getInterestCatalogueImpl = async () => null;
let getInterestConfigImpl = async () => null;
let currentUserImpl = () => null;
// TM-982 phone verify seams: the OTP-link call (resolve = verified; throw {code} = mapped error) and the
// verify-start (resolves a fake verificationId). OTP_ONCOMPLETE captures the widget's auto-submit sink so
// a test can simulate "six digits entered" by invoking it with a code.
let startPhoneVerifyImpl = async () => "fake-verification-id";
let confirmPhoneLinkImpl = async () => ({});
// TM-1009: the verified-phone requirement flag — ON by default (see the deps kit note below).
let verifiedPhoneRequiredImpl = () => true;
let OTP_ONCOMPLETE = null;
// Avatar-control seams (TM-846): mutable so the upload-success test can enable the control and make
// the fake upload "land" a photoURL (the default stays the disabled/no-op state every other test had).
let isStorageConfiguredImpl = () => false;
let uploadAvatarImpl = async () => "";

const deps = {
  getMe: (...a) => getMeImpl(...a),
  updateMe: (...a) => updateMeImpl(...a),
  getMembership: (...a) => getMembershipImpl(...a),
  getInterestCatalogue: (...a) => getInterestCatalogueImpl(...a),
  getInterestConfig: (...a) => getInterestConfigImpl(...a),
  ApiError,
  currentUser: (...a) => currentUserImpl(...a),
  signOut: async () => {},
  // TM-982 phone verify-and-link fakes (auth link + widgets). Import-safe stand-ins for the real
  // modules (which can't load under Node): startPhoneVerify resolves a fake verificationId,
  // confirmPhoneLink is driven per-test via a mutable impl, and the widget/cooldown attach helpers
  // return minimal controllers with the exact method surface profile.js null-chains against.
  startPhoneVerify: (...a) => startPhoneVerifyImpl(...a),
  confirmPhoneLink: (...a) => confirmPhoneLinkImpl(...a),
  attachOtpInput: ({ onComplete } = {}) => {
    OTP_ONCOMPLETE = onComplete; // captured so a test can drive the auto-submit (six digits entered)
    return { boxes: [], value: () => "", setValue: () => {}, clear: () => {}, focus: () => {} };
  },
  attachResendCooldown: () => ({ start: () => {}, reset: () => {}, isActive: () => false, syncDisabled: () => {} }),
  isStorageConfigured: (...a) => isStorageConfiguredImpl(...a),
  uploadAvatar: (...a) => uploadAvatarImpl(...a),
  validateAvatarFile: () => "",
  MAX_AVATAR_BYTES: 5 * 1024 * 1024,
  onAvatarChanged: () => {},
  // The REAL TM-846 broadcast pair — so announce → subscriber → repaint is the shipped chain.
  announceAvatarChanged: avatarEvents.announceAvatarChanged,
  onAvatarChangedEvent: avatarEvents.onAvatarChangedEvent,
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
  strengthRingGeometry: core.strengthRingGeometry,
  publicSummary: core.publicSummary,
  // profile.js's validateField delegates to the pure validateProfileField in profile-core.js (TM-763):
  // inject the REAL one so the eval copy's validation runs instead of throwing ReferenceError under Node 20.
  validateProfileField: core.validateProfileField,
  // fillForm reads NOTIFICATION_PREFS for the select default — inject the real set (it was never
  // needed before TM-781 because no test exercised fillForm through the eval copy).
  NOTIFICATION_PREFS: core.NOTIFICATION_PREFS,
  // TM-877: the city dropdown's allowed list + validator — the REAL pure implementations, so the
  // select options / off-list preservation tests prove the shipped rules.
  CITY_OPTIONS: core.CITY_OPTIONS,
  cityChoiceError: core.cityChoiceError,
  // The TM-781 phone-picker pure logic + country data — the REAL implementations, so these tests
  // prove the shipped split/compose/default rules through the renderer's own wiring.
  splitE164: core.splitE164,
  composeE164: core.composeE164,
  // TM-982: the shared canonicalisation + the pure "changed phone needs verify" gate — the REAL pure
  // implementations, so the renderer's save-block + Send-code affordance run the shipped rules.
  canonicalE164: core.canonicalE164,
  phoneEditNeedsVerify: core.phoneEditNeedsVerify,
  // TM-1005: the REAL pure "verify the current, unchanged number" rule + the real banner-CTA event
  // name, so the affordance visibility/label wiring runs the shipped contract under Node.
  phoneCurrentNeedsVerify: core.phoneCurrentNeedsVerify,
  PHONE_VERIFY_REQUEST_EVENT: reverifyCore.PHONE_VERIFY_REQUEST_EVENT,
  // TM-1009: the verified-phone requirement flag. Defaults ON here so the TM-982 save-block /
  // Send-code tests below exercise exactly the pre-flag behaviour (the flag-OFF short-circuit has
  // its own coverage in verified-phone-flag.test.mjs). Mutable per-test via the impl seam.
  verifiedPhoneRequired: (...a) => verifiedPhoneRequiredImpl(...a),
  defaultCountryFor: core.defaultCountryFor,
  phonePartsError: core.phonePartsError,
  // setFieldError compares against this to decide whether the COUNTRY PICKER (not the national
  // input) is the control at fault — the real constant, so the comparison is the shipped one.
  PHONE_PICK_COUNTRY_MESSAGE: core.PHONE_PICK_COUNTRY_MESSAGE,
  // TM-777 (I5): paintHub calls this to decide the next-day interests CTA — the REAL pure decision,
  // so the renderer's hidden/message wiring runs through the shipped logic. The max it targets is
  // injected by paintHub from state.interestConfig.max (TM-778's shared config), not a separate fetch.
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

// TM-1005: a minimal fake `window`, installed BEFORE the module evals so its top-level wiring runs —
// the banner-CTA handoff listener (window.addEventListener(PHONE_VERIFY_REQUEST_EVENT, …)) registers
// into WINDOW_LISTENERS, where the handoff test can fire it. Everything else the module touches on
// window is optional-chained (tmPhoneReverifyNotice) or a plain property write (tmProfile).
const WINDOW_LISTENERS = {};
globalThis.window = {
  addEventListener: (type, fn) => {
    (WINDOW_LISTENERS[type] ||= []).push(fn);
  },
  location: { hash: "" },
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
    // `initial` is the pre-TM-846 single identity glyph node; kept alongside the TM-846 glyph/photo
    // pair so this harness drives BOTH sides of that change (the fail-before proof evals main's
    // paintHub, which still writes hub.initial) — the extra node is inert for whichever side ignores it.
    initial: wireClassList(fakeEl("span")),
    glyph: wireClassList(fakeEl("span")),
    photo: wireClassList(fakeEl("img")),
    email: wireClassList(fakeEl("div")),
    phone: wireClassList(fakeEl("div")),
    // `bar` is the pre-TM-913 horizontal-bar fill node (paintHub set hub.bar.style.width); kept so this
    // harness evals main's paintHub too. TM-913 swaps it for the progress RING: `ring` is the
    // role=progressbar container (paintHub sets aria-valuenow/valuetext on it) and `ringArc` the fill
    // <circle> whose style.strokeDashoffset paintHub drives. All three stay so either side mounts.
    bar: wireClassList(fakeEl("i")),
    ring: wireClassList(fakeEl("div")),
    ringArc: wireClassList(fakeEl("circle")),
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

test("validateField: age mirrors the backend 18–99 integer range (TM-884)", () => {
  const age = field("age");
  assert.equal(profile.validateField(age, "36"), "", "an in-range whole number is accepted");
  assert.equal(profile.validateField(age, "18"), "", "the lower bound (18) is inclusive");
  assert.equal(profile.validateField(age, "99"), "", "the upper bound (99) is inclusive");
  assert.match(profile.validateField(age, "17"), /18 or more/, "below 18 is rejected (matches @Min(18))");
  assert.match(profile.validateField(age, "100"), /99 or less/, "above 99 is rejected (matches @Max(99))");
  assert.match(profile.validateField(age, "36.5"), /whole number/, "a non-integer age is rejected");
});

test("age grandfathering (TM-884): an existing under-18 account can still save its other fields", async () => {
  await withFakeDocumentAsync(async () => {
    // A 13–120-era account (age 15) loads its profile — the saved age pre-fills the (now 18-min)
    // field. The UNCHANGED value must neither fail validation nor be re-sent in the PATCH, so the
    // account can still edit e.g. its name; only an actual age EDIT is banded to 18–99.
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => null;
    getMeImpl = async () => ({ firstName: "Young", age: 15 });
    getMembershipImpl = async () => ({});
    await profile.load();

    const age = field("age");
    assert.equal(shell.fields.get("age").input.value, "15", "the saved age pre-fills the field");
    assert.equal(profile.validateField(age, "15"), "", "the UNCHANGED saved age passes validation");
    assert.match(profile.validateField(age, "16"), /18 or more/, "an actual under-18 EDIT is still rejected");

    shell.fields.get("firstName").input.value = "Younger";
    const patch = profile.collectPatch();
    assert.equal(patch.firstName, "Younger");
    assert.ok(!("age" in patch), "the unchanged age is omitted — never re-attested against the new band");
  });
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

test("validateField: first and last name reject purely numeric input (TM-771)", () => {
  // Ghalia's repro: "676767" in a name-like field saved with "Profile saved.". The rule lives in
  // profile-core's validateProfileField; this pins the delegate wiring end-to-end. (City left this
  // trio in TM-877 — it's a dropdown now, covered by the allowed-list tests below.)
  assert.match(profile.validateField(field("firstName"), "676767"), /letter/i);
  assert.match(profile.validateField(field("lastName"), "676767"), /letter/i);
  assert.equal(profile.validateField(field("firstName"), "Jean-Luc"), "", "hyphenated names are accepted");
});

// ---- TM-877: city dropdown ---------------------------------------------------------------------

test("the city field is a SELECT of the four allowed cities behind a blank placeholder (TM-877)", () => {
  const city = field("city");
  assert.equal(city.type, "select", "city is a dropdown, not free text");
  assert.deepEqual(
    city.options.map(([value]) => value),
    ["", "London", "Milton Keynes", "Sharjah", "Karachi"],
    "a no-choice placeholder plus exactly the interim allowed list (admin-managed list is TM-878)",
  );
});

test("validateField: city accepts the allowed list (and blank), rejects an off-list pick (TM-877)", () => {
  const city = field("city");
  for (const allowed of ["London", "Milton Keynes", "Sharjah", "Karachi"]) {
    assert.equal(profile.validateField(city, allowed), "", `${allowed} is on the allowed list`);
  }
  assert.equal(profile.validateField(city, ""), "", "blank stays allowed (no change)");
  assert.match(profile.validateField(city, "Bristol"), /list/i, "an off-list city is rejected");
});

test("an existing OFF-LIST city is preserved: kept selectable, valid, and round-tripped (TM-877)", async () => {
  await withFakeDocumentAsync(async () => {
    // A profile saved before the dropdown existed carries city "Dubai" — off the allowed list. It
    // must be injected as a selectable option, pass validation, and survive an unrelated save
    // byte-identical (never silently overwritten by the new list).
    const shell = makeShell({ firstName: "Ada" });
    profile.__setShell(shell);
    currentUserImpl = () => null;
    getMeImpl = async () => ({ firstName: "Ada", city: "Dubai" });
    getMembershipImpl = async () => ({});
    await profile.load();

    const citySelect = shell.fields.get("city").input;
    assert.equal(citySelect.value, "Dubai", "the saved off-list city is selected");
    assert.equal(
      citySelect._children.some((o) => o.getAttribute && o.getAttribute("value") === "Dubai"),
      true,
      "an option for the off-list value was injected so it stays selectable",
    );
    assert.equal(profile.validateField(field("city"), "Dubai"), "", "the saved off-list value stays valid");

    // The user edits an unrelated field and saves: the city round-trips unchanged.
    shell.fields.get("firstName").input.value = "Ada B";
    const patch = profile.collectPatch();
    assert.equal(patch.city, "Dubai", "the off-list city survives an unrelated save");

    // A refill with the same value must not stack duplicate injected options.
    profile.fillForm({ firstName: "Ada", city: "Dubai" });
    const dubaiOptions = citySelect._children.filter(
      (o) => o.getAttribute && o.getAttribute("value") === "Dubai",
    );
    assert.equal(dubaiOptions.length, 1, "re-fills reuse the injected option (no duplicates)");
  });
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

/** Build a fake `localStorage` (Map-backed); returns the install/restore/store handle. */
function makeFakeLocalStorage() {
  const store = new Map();
  return {
    store,
    impl: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
}

/** Install a fake `localStorage` (Map-backed) for a SYNC callback, capturing writes; restore after. */
function withFakeLocalStorage(run) {
  const prior = globalThis.localStorage;
  const { store, impl } = makeFakeLocalStorage();
  globalThis.localStorage = impl;
  try {
    return run(store);
  } finally {
    globalThis.localStorage = prior;
  }
}

/** Async twin of withFakeLocalStorage — awaits `run` so the restore doesn't fire mid-promise. */
async function withFakeLocalStorageAsync(run) {
  const prior = globalThis.localStorage;
  const { store, impl } = makeFakeLocalStorage();
  globalThis.localStorage = impl;
  try {
    return await run(store);
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

test("load fetches the public interests config and the CTA copy names the REAL max (5 → 'add 4 more')", async () => {
  await withFakeDocumentAsync(async () => {
    await withFakeLocalStorageAsync(async () => {
      const shell = makeShell();
      profile.__setShell(shell);
      currentUserImpl = () => ({ uid: "u1", photoURL: null });
      // A 1-pick /me + a config that raised the max to 5 (an admin change). load() fetches /me and the
      // interests config (via loadInterestsMeta) in parallel BEFORE the first paint, so paintHub injects
      // the real max (state.interestConfig.max) into the nudge — the SAME config the TM-778 card uses.
      getMeImpl = async () => ({ firstName: "Ada", interests: [{ label: "hiking", category: "outdoors" }] });
      getMembershipImpl = async () => ({});
      getInterestCatalogueImpl = async () => [{ label: "hiking", category: "outdoors" }];
      getInterestConfigImpl = async () => ({ minSelections: 1, maxSelections: 5 });

      await profile.load();

      assert.equal(profile.__getState().interestConfig.max, 5, "the config max is stashed in state");
      assert.equal(shell.hub.barInterestsCta.hidden, false, "the CTA is revealed (1 pick, never prompted)");
      // The copy names the config-driven remaining count (5 − 1 = 4), NOT the fallback (3 → 2).
      assert.match(shell.hub.barInterestsCta.textContent, /add 4 more/i);
    });
  });
});

test("load with a failing interests config falls back to the seeded max (CTA reads 'add 2 more')", async () => {
  await withFakeDocumentAsync(async () => {
    await withFakeLocalStorageAsync(async () => {
      const shell = makeShell();
      profile.__setShell(shell);
      currentUserImpl = () => ({ uid: "u1", photoURL: null });
      getMeImpl = async () => ({ firstName: "Ada", interests: [{ label: "hiking", category: "outdoors" }] });
      getMembershipImpl = async () => ({});
      // The config fetch rejects (offline / non-2xx) — loadInterestsMeta swallows it and state.interestConfig
      // keeps the normaliseInterestConfig(null) default (max 3), so the nudge copy degrades sensibly.
      getInterestConfigImpl = async () => {
        throw new Error("config unreachable");
      };

      await profile.load();

      assert.equal(profile.__getState().interestConfig.max, 3, "state keeps the seeded fallback when the fetch fails");
      assert.equal(shell.hub.barInterestsCta.hidden, false, "the CTA still shows — a failed config never breaks it");
      assert.match(shell.hub.barInterestsCta.textContent, /add 2 more/i);
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

    // Confirming a country composes a real E.164 — but that is a CHANGE from the legacy (unparseable)
    // stored value, so TM-982 now requires the resolved number to be VERIFIED before the save. Picking
    // a country alone no longer sends the PATCH: the phone is a verified identity.
    entry.country.value = "GB";
    let sent = null;
    updateMeImpl = async (patch) => { sent = patch; return { phone: patch.phone }; };
    await profile.save({ preventDefault() {} });
    assert.equal(sent, null, "TM-982: a legacy number resolved to a new E.164 is unverified → save blocked");
    assert.match(entry.error.textContent, /verify/i, "the verify-your-new-number prompt is painted");
  });
});

// TM-1009: the flag-OFF companion of the blocked-save case above — with the verified-phone
// requirement switched OFF (config.flags.requireVerifiedPhone false, the shipped default), the
// TM-982 save gate is a no-op: the SAME changed-and-unverified number goes straight through to
// PATCH /me, with no verify prompt. This exercises the shipped save() through the real source
// (fail-before proof: red until profile.js's phoneNeedsVerify consults the flag).
test("flag OFF (TM-1009): a CHANGED, unverified phone saves without an OTP — the TM-982 gate is off", async () => {
  await withFakeDocumentAsync(async () => {
    TOASTS = [];
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => null;
    verifiedPhoneRequiredImpl = () => false; // the shipped default: phone collected, not forced-verified
    try {
      profile.fillForm({ firstName: "Ada", phone: "+447700900123", city: "London" });
      const entry = shell.fields.get("phone");
      // The user CHANGES their number and saves without ever tapping Send code / entering an OTP.
      entry.input.value = "7700 900999";
      let sent = null;
      updateMeImpl = async (patch) => { sent = patch; return { phone: patch.phone }; };
      await profile.save({ preventDefault() {} });
      assert.ok(sent, "the PATCH is sent — no verify block with the flag OFF");
      assert.equal(sent.phone, "+447700900999", "the changed number is composed + saved as-is");
      assert.doesNotMatch(entry.error.textContent ?? "", /verify/i, "no verify prompt is painted");
    } finally {
      verifiedPhoneRequiredImpl = () => true; // restore the flag-ON default for the other tests
    }
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

// ---- TM-881: the strength "Add …" gap prompts are real jump-to-field controls ------------------
// paintHub used to render the nudge as inert <span> text ("Add a phone + a photo →" that did nothing
// on click/tap); it must now render each named gap as a keyboard-reachable <button> wired to
// focusOnPage(<the gap's field id>). These tests drive the shipped paintHub + click handlers.

/** The BUTTON children of a fake node (the gap prompts among the nudge's text pieces). */
function nudgeButtons(node) {
  return node._children.filter((c) => c && c.tagName === "BUTTON");
}

/** A fake node's visible label — textContent, or its appended text-node children joined. */
function nodeLabel(node) {
  return node._textContent || node._children.filter((c) => c && c.nodeType === 3).map((c) => c.data).join("");
}

test("paintHub renders each named strength gap as a focusable button that jumps to its field (TM-881)", () => {
  withFakeDocument(() => {
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => ({ uid: "u1", photoURL: null });

    // Name + city present; age, phone, photo missing → the nudge names the first two gaps (age, phone).
    profile.paintHub({ firstName: "Ada", lastName: "L", city: "London" });

    const buttons = nudgeButtons(shell.hub.barNudge);
    assert.equal(buttons.length, 2, "each NAMED gap is a real button (the nudge caps at two)");
    assert.deepEqual(buttons.map(nodeLabel), ["your age", "a phone"], "labels keep the shipped copy");
    for (const b of buttons) {
      // type=button so activating one can never submit the surrounding form; the aria-label restores
      // the "Add" verb a screen reader would miss from the bare "a phone" fragment.
      assert.equal(b.getAttribute("type"), "button");
    }
    assert.equal(buttons[0].getAttribute("aria-label"), "Add your age");
    assert.equal(buttons[1].getAttribute("aria-label"), "Add a phone");

    // Activating a prompt scrolls to AND focuses the matching profile-<field> control (focusOnPage).
    const focused = [];
    globalThis.document.getElementById = (id) => ({
      scrollIntoView: () => {},
      focus: () => focused.push(id),
    });
    buttons[1].onClick();
    assert.deepEqual(focused, ["profile-phone"], "'a phone' focuses the phone field");
    buttons[0].onClick();
    assert.deepEqual(focused, ["profile-phone", "profile-age"], "'your age' focuses the age field");
  });
});

test("the photo gap targets the avatar control — file input on web, camera button when native (TM-881)", () => {
  withFakeDocument(() => {
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => ({ uid: "u1", photoURL: null });

    // Everything but the photo present → exactly one gap, "a photo".
    profile.paintHub({ firstName: "Ada", lastName: "L", city: "London", age: 30, phone: "+447700900123" });
    const buttons = nudgeButtons(shell.hub.barNudge);
    assert.equal(buttons.length, 1);
    assert.equal(nodeLabel(buttons[0]), "a photo");

    // Web: no #profile-avatar-camera in the DOM → the prompt focuses the file input.
    const focused = [];
    globalThis.document.getElementById = (id) =>
      id === "profile-avatar-camera" ? null : { scrollIntoView: () => {}, focus: () => focused.push(id) };
    buttons[0].onClick();
    assert.deepEqual(focused, ["profile-avatar-file"]);

    // Native shell (TM-281): the camera button exists (the file input is hidden there) → it wins.
    const focusedNative = [];
    globalThis.document.getElementById = (id) => ({ scrollIntoView: () => {}, focus: () => focusedNative.push(id) });
    buttons[0].onClick();
    assert.deepEqual(focusedNative, ["profile-avatar-camera"]);
  });
});

test("at 100% the nudge is reassurance text only — no controls, no arrow (TM-881)", () => {
  withFakeDocument(() => {
    const shell = makeShell();
    profile.__setShell(shell);
    currentUserImpl = () => ({ uid: "u1", photoURL: "https://cdn.test/avatar.png" });

    profile.paintHub({ firstName: "Ada", lastName: "L", city: "London", age: 30, phone: "+447700900123" });

    assert.equal(nudgeButtons(shell.hub.barNudge).length, 0, "nothing left to add → nothing to click");
    assert.equal(shell.hub.barNudge._textContent, "Your profile is all set");
  });
});

// ---- TM-846: avatar upload repaints EVERY avatar surface (identity header + strength included) ---

test("paintHub shows the identity PHOTO when the user has a photoURL, the glyph when not (TM-846)", () => {
  withFakeDocument(() => {
    const shell = makeShell();
    profile.__setShell(shell);

    currentUserImpl = () => ({ uid: "u1", photoURL: "https://cdn.test/avatar.png" });
    profile.paintHub({ firstName: "Ada", lastName: "Lovelace" });
    assert.equal(shell.hub.photo.src, "https://cdn.test/avatar.png", "the photo face carries the photoURL");
    assert.equal(shell.hub.photo.hidden, false);
    assert.equal(shell.hub.glyph.hidden, true, "exactly one face shows — the glyph hides behind the photo");

    // Photo gone (e.g. a different account) → back to the initial glyph.
    currentUserImpl = () => ({ uid: "u1", photoURL: null });
    profile.paintHub({ firstName: "Ada", lastName: "Lovelace" });
    assert.equal(shell.hub.photo.hidden, true);
    assert.equal(shell.hub.glyph.hidden, false);
    assert.equal(shell.hub.glyph._textContent, "A", "the glyph is the identity initial");
  });
});

test("avatar-events: announce fires every subscriber; unsubscribe + a throwing subscriber are isolated", () => {
  const calls = [];
  const offA = avatarEvents.onAvatarChangedEvent(() => calls.push("a"));
  const offBoom = avatarEvents.onAvatarChangedEvent(() => {
    throw new Error("boom");
  });
  const offB = avatarEvents.onAvatarChangedEvent(() => calls.push("b"));
  avatarEvents.announceAvatarChanged();
  assert.deepEqual(calls, ["a", "b"], "all subscribers fire; the thrower doesn't stop the later one");
  offA();
  offBoom();
  avatarEvents.announceAvatarChanged();
  assert.deepEqual(calls, ["a", "b", "b"], "an unsubscribed listener stays silent");
  offB();
});

/** Depth-first search of a fake-node tree for the node carrying the given id attribute. */
function findById(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.getAttribute && node.getAttribute("id") === id) return node;
  for (const child of node._children || []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

test("avatar upload success repaints the identity header + strength via the broadcast — no reload (TM-846)", async () => {
  await withFakeDocumentAsync(async () => {
    TOASTS = [];
    const shell = makeShell();
    // A profile complete except the photo → 80%. The upload landing must lift it to 100% and swap
    // the identity glyph for the new photo IMMEDIATELY (the bug: both stayed stale until reload).
    const me = { firstName: "Ada", lastName: "L", city: "London", age: 30, phone: "+447700900123" };
    let photo = null; // the Firebase user's photoURL — null until the fake upload "lands" it
    currentUserImpl = () => ({ uid: "u1", photoURL: photo });
    isStorageConfiguredImpl = () => true;
    uploadAvatarImpl = async () => {
      photo = "https://cdn.test/new-avatar.png";
    };

    // The REAL avatar control (shipped buildAvatar), mounted into the shell like buildShell does.
    const avatar = profile.buildAvatar();
    shell.avatar = avatar;
    profile.__setShell(shell);
    profile.__getState().profile = me;

    profile.paintHub(me);
    // TM-913: the strength percent is now the RING's centre label — the bare percent ("80%"), the word
    // "complete" moved to the nudge line. The broadcast-repaint behaviour under test is unchanged.
    assert.equal(shell.hub.barPct._textContent, "80%", "photo-less baseline (ring centre = bare percent)");
    assert.equal(shell.hub.photo.hidden, true);

    // Drive a picked file through the shipped change handler (validate → upload → announce).
    const fileInput = findById(avatar.wrapper, "profile-avatar-file");
    assert.ok(fileInput, "the avatar control renders its file input");
    fileInput.files = [{ name: "a.png", type: "image/png", size: 1000 }];
    await fileInput._listeners.change();

    // Every avatar surface on the page is fresh, with NO reload and NO extra paintHub call here:
    assert.equal(shell.hub.photo.src, "https://cdn.test/new-avatar.png", "identity header photo updated");
    assert.equal(shell.hub.photo.hidden, false);
    assert.equal(shell.hub.glyph.hidden, true);
    assert.equal(shell.hub.barPct._textContent, "100%", "the hasPhoto strength % updated (ring centre = bare percent)");
    // The upload control's own preview repainted too (no regression from the broadcast refactor).
    const preview = avatar.wrapper._children[0]._children.find((c) => c && c.tagName === "IMG");
    assert.equal(preview.src, "https://cdn.test/new-avatar.png");
    assert.equal(preview.hidden, false);
    assert.ok(TOASTS.some((t) => /avatar updated/i.test(t.msg)), "the success toast still shows");
  });
});

// An async variant of withFakeDocument.
async function withFakeDocumentAsync(run) {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: (tag) => wireClassList(fakeEl(tag)),
    // TM-913: the strength ring builds SVG-namespaced nodes (createElementNS). The tested paths don't
    // inspect the ring's internals, so a plain fake element is enough for it to mount without throwing.
    createElementNS: (_ns, tag) => wireClassList(fakeEl(tag)),
    createTextNode: (str) => ({ nodeType: 3, data: String(str) }),
    getElementById: () => null,
  };
  try {
    return await run();
  } finally {
    globalThis.document = prior;
  }
}

// ═══ TM-1005 — a way to verify the CURRENT, UNCHANGED stored phone ═════════════════════════════════
//
// The dead-end these pin shut: an account whose stored phone was never Firebase-verified (email-code /
// admin accounts + pre-TM-930 legacy) was nagged to "verify your number", but the TM-982 affordance
// only revealed on a phone CHANGE and the grace banner's CTA bounced off #/onboarding. The fix: the
// same verify button now also reveals — labelled "Verify this number" — when the form holds the
// UNCHANGED stored number and currentUser().phoneNumber isn't it, runs the SAME startPhoneVerify →
// confirmPhoneLink flow, and the banner CTA hands off to it via PHONE_VERIFY_REQUEST_EVENT.
//
// FAIL-BEFORE / PASS-AFTER: evaluated against pre-TM-1005 profile.js these go red — the affordance
// stays hidden for an unchanged number (refreshPhoneVerifyAffordance only consulted the changed-number
// rule) and no PHONE_VERIFY_REQUEST_EVENT listener registers. Against the fixed source they pass.

/** Build a REAL phone field (buildField → verify controls wired) inside a fresh shell, then fill the
 *  form with a stored phone — the exact prefill path the page runs. Returns the phoneVerify handles. */
function currentVerifyRig({ storedPhone = "+447700900123", accountPhone = null } = {}) {
  TOASTS = [];
  currentUserImpl = () => ({ uid: "u-1005", phoneNumber: accountPhone });
  const shell = makeShell();
  profile.__setShell(shell);
  const built = profile.buildField(field("phone"));
  // Swap the real built controls in as the shell's phone entry (makeShell's plain fakes don't carry
  // the verify wiring); fillForm/composedPhoneE164 read this entry.
  shell.fields.set("phone", { input: built.input, error: built.error, country: built.country });
  profile.fillForm({ phone: storedPhone, city: "London", notificationPref: "EMAIL" });
  return { shell, entry: shell.fields.get("phone"), pv: profile.__phoneVerify() };
}

test("TM-1005: 'Verify this number' renders for an UNCHANGED stored phone with no verified number", () => {
  withFakeDocument(() => {
    const { pv } = currentVerifyRig({ accountPhone: null });
    assert.equal(pv.sendBtn.hidden, false, "the verify affordance must be visible — this was the dead-end");
    assert.equal(pv.sendBtn.textContent, "Verify this number", "unchanged-number wording (not 'Send code')");
  });
});

test("TM-1005: the affordance also renders when the account-verified number is a DIFFERENT number", () => {
  withFakeDocument(() => {
    const { pv } = currentVerifyRig({ accountPhone: "+447700900999" });
    assert.equal(pv.sendBtn.hidden, false, "stored ≠ linked ⇒ the stored number still needs verifying");
    assert.equal(pv.sendBtn.textContent, "Verify this number");
  });
});

test("TM-1005: the affordance is ABSENT when the stored phone IS the account's verified number", () => {
  withFakeDocument(() => {
    const { pv } = currentVerifyRig({ accountPhone: "+447700900123" });
    assert.equal(pv.sendBtn.hidden, true, "a verified account must not sprout a stray verify affordance");
  });
});

test("TM-1005: editing to a DIFFERENT number yields the button to the TM-982 'Send code' path (and back)", () => {
  withFakeDocument(() => {
    const { entry, pv } = currentVerifyRig({ accountPhone: null });
    // The user edits the national number → the changed-number rule owns the button + wording.
    entry.input.value = "7700 900999";
    entry.input._listeners.input();
    assert.equal(pv.sendBtn.hidden, false);
    assert.equal(pv.sendBtn.textContent, "Send code", "a CHANGED number keeps the TM-982 wording");
    // Editing BACK to the stored number re-offers the current-number verify (not a dead-end again).
    entry.input.value = "7700 900123";
    entry.input._listeners.input();
    assert.equal(pv.sendBtn.hidden, false);
    assert.equal(pv.sendBtn.textContent, "Verify this number");
  });
});

test("TM-1005: the affordance runs the SAME OTP verify-and-link, without re-typing the number", async () => {
  await withFakeDocumentAsync(async () => {
    const { pv } = currentVerifyRig({ accountPhone: null });
    const sends = [];
    startPhoneVerifyImpl = async (e164) => {
      sends.push(e164);
      return "vid-1005";
    };
    let linked = null;
    confirmPhoneLinkImpl = async (vid, code) => {
      linked = { vid, code };
      return {};
    };
    let bannerRefreshes = 0;
    globalThis.window.tmPhoneReverifyNotice = { refresh: () => bannerRefreshes++ };
    try {
      // Tap "Verify this number" — the button's own click listener, i.e. the shipped sendPhoneCode.
      await pv.sendBtn._listeners.click();
      assert.deepEqual(sends, ["+447700900123"], "startPhoneVerify fires for the STORED number as-is");
      assert.equal(pv.otpWrap.hidden, false, "the six-box OTP reveals");
      // Six digits land → the widget auto-submits → confirmPhoneLink links the credential.
      await OTP_ONCOMPLETE("123456");
      assert.deepEqual(linked, { vid: "vid-1005", code: "123456" });
      assert.equal(pv.statusEl.textContent, "Verified ✓");
      assert.equal(pv.sendBtn.hidden, true, "verified ⇒ the affordance hides");
      // Current-number wording: nothing to save (collectPatch omits an unchanged phone) — the user
      // must NOT be told to save; and the grace banner is asked to re-check itself immediately.
      assert.ok(TOASTS.some((t) => t.msg === "Number verified ✓"), "the no-save-needed success toast");
      assert.ok(!TOASTS.some((t) => /save to update/i.test(t.msg)), "no misleading 'save to update' copy");
      assert.equal(bannerRefreshes, 1, "the grace banner re-checks (clears) without waiting for an auth change");
    } finally {
      delete globalThis.window.tmPhoneReverifyNotice;
      startPhoneVerifyImpl = async () => "fake-verification-id";
      confirmPhoneLinkImpl = async () => ({});
    }
  });
});

test("TM-1005: the banner CTA's handoff event reveals + FOCUSES the affordance once painted", () => {
  const priorDoc = globalThis.document;
  try {
    globalThis.document = {
      createElement: (tag) => wireClassList(fakeEl(tag)),
      createElementNS: (_ns, tag) => wireClassList(fakeEl(tag)),
      createTextNode: (str) => ({ nodeType: 3, data: String(str) }),
      getElementById: () => null,
    };
    const { pv } = currentVerifyRig({ accountPhone: null });
    assert.equal(pv.sendBtn.hidden, false, "precondition: the affordance is painted");
    // The profile must LISTEN on the shared contract event (phone-reverify-core's name, not a copy).
    const listeners = WINDOW_LISTENERS[reverifyCore.PHONE_VERIFY_REQUEST_EVENT] || [];
    assert.ok(listeners.length > 0, "profile.js registers the PHONE_VERIFY_REQUEST_EVENT listener");
    // Now the view is visible (the CTA hash-nav landed) and ids resolve — fire the handoff.
    let scrolled = 0;
    let focused = 0;
    pv.sendBtn.scrollIntoView = () => scrolled++;
    pv.sendBtn.focus = () => focused++;
    const view = wireClassList(fakeEl("div"));
    view.hidden = false;
    globalThis.document.getElementById = (id) =>
      id === "profile-view" ? view : id === pv.sendBtn.getAttribute("id") ? pv.sendBtn : null;
    for (const fn of listeners) fn();
    assert.ok(scrolled > 0, "the affordance scrolls into view");
    assert.ok(focused > 0, "the affordance receives focus — the CTA finally LANDS somewhere");
  } finally {
    globalThis.document = priorDoc;
  }
});
