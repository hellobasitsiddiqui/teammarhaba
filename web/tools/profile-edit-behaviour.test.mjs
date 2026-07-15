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
    },
    _children: [],
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
    "  getMe, updateMe, getMembership, ApiError,\n" +
    "  currentUser, signOut,\n" +
    "  isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES,\n" +
    "  onAvatarChanged, isNativeCameraAvailable, captureAvatarImage,\n" +
    "  clear, el, toast, doodle, renderAccountBadges,\n" +
    "  buildSecuritySettings, buildAppearanceSettings,\n" +
    "  PROFILE_PUBLIC_ROUTE, profileMode, identitySummary, profileStrength, publicSummary,\n" +
    "  profileMembershipRow, membershipEnabled, MEMBERSHIP_ROUTE,\n" +
    "} = globalThis.__PROFILE_DEPS__;\n";

  // A test seam appended to the eval copy only: reach the module-private shell/state + internals.
  const seam = "\nexport function __setShell(s){ shell = s; }\n" +
    "export function __getState(){ return state; }\n" +
    "export { validateField, collectPatch, save, load, paintHub, renderStatus, setFieldError, FIELDS };\n";

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
const membershipTierUrl = new URL("../src/assets/membership-tier.js", import.meta.url);

let getMeImpl = async () => ({});
let updateMeImpl = async () => ({});
let getMembershipImpl = async () => ({});
let currentUserImpl = () => null;

const deps = {
  getMe: (...a) => getMeImpl(...a),
  updateMe: (...a) => updateMeImpl(...a),
  getMembership: (...a) => getMembershipImpl(...a),
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
  profileStrength: core.profileStrength,
  publicSummary: core.publicSummary,
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
function makeShell(values = {}) {
  const fields = new Map();
  for (const f of profile.FIELDS) {
    const input = wireClassList(fakeEl("input"));
    input.value = values[f.key] ?? "";
    const errorNode = wireClassList(fakeEl("p"));
    errorNode.hidden = true;
    fields.set(f.key, { input, error: errorNode });
  }
  const saveBtn = wireClassList(fakeEl("button"));
  saveBtn.textContent = "Save changes";
  const status = wireClassList(fakeEl("div"));
  const root = wireClassList(fakeEl("div"));
  const hub = {
    name: wireClassList(fakeEl("div")),
    meta: wireClassList(fakeEl("div")),
    initial: wireClassList(fakeEl("span")),
    bar: wireClassList(fakeEl("i")),
    barPct: wireClassList(fakeEl("span")),
    barNudge: wireClassList(fakeEl("span")),
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

test("validateField: phone mirrors the backend lenient pattern", () => {
  const phone = field("phone");
  assert.equal(profile.validateField(phone, "+44 20 7946 0958"), "", "a valid lenient phone is accepted");
  assert.equal(profile.validateField(phone, "(020) 7946-0958"), "", "separators are allowed");
  assert.match(profile.validateField(phone, "not-a-phone!"), /invalid/i, "letters/'!' fail the pattern");
  assert.match(profile.validateField(phone, "12"), /invalid/i, "too short (min 3) fails the pattern");
});

test("validateField: an empty value is always allowed (clearing a field is never blocked)", () => {
  // Mirrors the backend treating missing/blank as 'leave unchanged' — the browser must not block it.
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
