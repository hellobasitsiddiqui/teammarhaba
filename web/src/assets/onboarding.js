// First-login "complete your profile" gate (TM-250) — the #/onboarding view. A new passwordless
// user lands here (routed by the guard in router.js) and CANNOT enter the app until they supply the
// three required minimum fields — Name, Location, Age — which post atomically to
// POST /api/v1/me/onboarding. On success the backend marks onboarding complete and the gate lifts;
// the guard then sends the user on to where they were headed (home, or a deep-linked route).
//
// Why a dedicated atomic endpoint (not the partial PATCH /me): the gate is all-or-nothing — name +
// location + age are validated together and the onboarding-complete flag flips in the same
// transaction, so a half-filled gate can never let the user slip into the app (TM-250).
//
// Reuses the TM-133 UX kit (el/clear/toast) + the existing styles + the same client-side validation
// shape as the edit-profile view (TM-167), so the two surfaces fail fast the same way. XSS-safety is
// inherited from el() (textContent only — no innerHTML seam).

import { getMe, submitOnboarding, ApiError } from "./api.js";
import { clear, el, toast } from "./ui.js";
import { doodle } from "./doodles.js";

// The three required fields and their client-side rules, mirroring the backend OnboardingRequest
// bean validation (name/location non-blank ≤255; age 13–120) so we reject bad input before any
// round-trip AND match exactly what the server will accept. The `field` key is the request property;
// `meKey` is where the current value lives on a MeResponse (so a half-completed gate pre-fills).
const TEXT_MAX = 255;
const FIELDS = [
  {
    field: "name",
    meKey: "displayName",
    label: "Name",
    type: "text",
    maxLength: TEXT_MAX,
    autocomplete: "name",
    hint: "How you'll appear to others.",
  },
  {
    field: "location",
    meKey: "city",
    label: "Location",
    type: "text",
    maxLength: TEXT_MAX,
    autocomplete: "address-level2",
    hint: "Your town or city.",
  },
  {
    field: "age",
    meKey: "age",
    label: "Age",
    type: "number",
    min: 13,
    max: 120,
    autocomplete: "off",
    hint: "Between 13 and 120.",
  },
];

const state = {
  loading: false,
  loaded: false,
};

let shell = null; // { form, fields: Map<field,{input,error}>, submit } once built

const $ = (id) => document.getElementById(id);

// ---- client-side validation -----------------------------------------------------------------

/** Validate one field's raw value against its rules. Returns an error message, or "" if valid. */
function validateField(field, raw) {
  const value = (raw ?? "").trim();
  // All three are REQUIRED here (unlike the partial edit-profile form, where blank = "leave alone").
  if (value === "") return `${field.label} is required.`;
  if (field.type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return "Enter a whole number.";
    if (field.min != null && n < field.min) return `Must be ${field.min} or more.`;
    if (field.max != null && n > field.max) return `Must be ${field.max} or less.`;
    return "";
  }
  if (field.maxLength != null && value.length > field.maxLength) {
    return `Must be ${field.maxLength} characters or fewer.`;
  }
  return "";
}

/** Show/clear the inline error for a field and reflect it on the input for a11y. */
function setFieldError(fieldKey, message) {
  const f = shell?.fields.get(fieldKey);
  if (!f) return;
  f.error.textContent = message || "";
  f.error.hidden = !message;
  if (message) {
    f.input.setAttribute("aria-invalid", "true");
    f.input.classList.add("tm-field-invalid");
  } else {
    f.input.removeAttribute("aria-invalid");
    f.input.classList.remove("tm-field-invalid");
  }
}

function clearAllFieldErrors() {
  for (const field of FIELDS) setFieldError(field.field, "");
}

/** Validate every field; paint inline errors; return true iff all valid. */
function validateAll() {
  let ok = true;
  for (const field of FIELDS) {
    const msg = validateField(field, shell.fields.get(field.field).input.value);
    setFieldError(field.field, msg);
    if (msg) ok = false;
  }
  return ok;
}

// ---- data -----------------------------------------------------------------------------------

/** Pre-fill the inputs from a MeResponse — a returning, half-completed user keeps what they had. */
function prefill(profile) {
  for (const field of FIELDS) {
    const input = shell.fields.get(field.field).input;
    const value = profile?.[field.meKey];
    input.value = value == null ? "" : String(value);
  }
}

/** Build the request body: trimmed name/location, age coerced to a number. */
function collectBody() {
  const get = (k) => (shell.fields.get(k).input.value ?? "").trim();
  return { name: get("name"), location: get("location"), age: Number(get("age")) };
}

async function load() {
  state.loading = true;
  // Best-effort pre-fill: a failure here is non-fatal (the user just starts from blank).
  try {
    const profile = await getMe();
    prefill(profile);
  } catch (err) {
    console.warn("[onboarding] GET /api/v1/me failed (starting blank):", err?.message ?? err);
  } finally {
    state.loading = false;
    state.loaded = true;
  }
}

async function submit(event) {
  event.preventDefault();
  clearAllFieldErrors();
  if (!validateAll()) {
    toast("Please complete all fields.", { type: "error" });
    return;
  }

  shell.submit.disabled = true;
  const original = shell.submit.textContent;
  shell.submit.textContent = "Saving…";
  try {
    await submitOnboarding(collectBody());
    toast("Welcome to TeamMarhaba!", { type: "success" });
    // The gate has lifted (server now reports onboardingCompleted). Hand control back to the guard,
    // which re-checks gating and routes the now-onboarded user on to home / their intended route.
    onComplete();
  } catch (err) {
    if (err instanceof ApiError && err.fieldErrors.length) {
      // Backend RFC-7807 validation: attach each message to its field; toast the leftovers.
      const leftover = [];
      for (const fe of err.fieldErrors) {
        if (shell.fields.has(fe.field)) setFieldError(fe.field, fe.message);
        else leftover.push(fe.message);
      }
      toast(leftover.length ? leftover.join(" ") : "Please fix the highlighted fields.", { type: "error" });
    } else {
      const msg = err instanceof ApiError ? err.message : "Could not save your profile. Please try again.";
      toast(msg, { type: "error" });
    }
  } finally {
    shell.submit.disabled = false;
    shell.submit.textContent = original;
  }
}

// The router supplies this when it mounts the view, so the gate can hand control back on success
// without onboarding.js importing the router (avoids a cycle). Defaults to a no-op until set.
let onComplete = () => {};

// ---- rendering ------------------------------------------------------------------------------

function buildField(field) {
  const id = `onboarding-${field.field}`;
  const errorId = `${id}-error`;
  const hintId = field.hint ? `${id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");

  const input = el("input", {
    id,
    class: "tm-input",
    type: field.type,
    name: field.field,
    required: true,
    maxLength: field.maxLength,
    min: field.min,
    max: field.max,
    autocomplete: field.autocomplete,
    inputmode: field.type === "number" ? "numeric" : null,
    "aria-describedby": describedBy,
  });
  // Live-clear an inline error as soon as the user starts correcting the field.
  input.addEventListener("input", () => setFieldError(field.field, validateField(field, input.value)));

  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const hint = field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null;

  const wrapper = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: field.label }),
    input,
    hint,
    error,
  ]);
  return { wrapper, input, error };
}

function buildShell(view) {
  const fields = new Map();
  const fieldNodes = FIELDS.map((field) => {
    const built = buildField(field);
    fields.set(field.field, { input: built.input, error: built.error });
    return built.wrapper;
  });

  // NB: must NOT be named `submit` — that would shadow the module-level `submit` handler so the
  // form's `onSubmit: submit` binds this button element, not the handler → native submit / reload
  // (the TM-199 shadowing trap). Use `submitBtn`.
  const submitBtn = el("button", { class: "tm-btn tm-btn-primary", type: "submit" }, "Continue");

  const form = el("form", { class: "tm-onboarding-form", id: "onboarding-form", novalidate: true, onSubmit: submit }, [
    el("div", { class: "tm-form-grid" }, fieldNodes),
    el("div", { class: "tm-form-actions" }, [submitBtn]),
  ]);

  clear(view).append(
    el("div", { class: "tm-onboarding-card" }, [
      el("div", { class: "tm-admin-head" }, [
        el("h2", {}, [doodle("host", { class: "tm-doodle-header", title: "Complete your profile" }), "Complete your profile"]),
      ]),
      el("p", { class: "tm-muted", id: "onboarding-intro", text: "Just a few details to get you started — you can change these later." }),
      form,
    ]),
  );

  shell = { form, fields, submit: submitBtn };
}

// ---- mount ----------------------------------------------------------------------------------

/**
 * Called by the router when the #/onboarding view becomes active. Builds the shell once, pre-fills
 * from GET /me, and registers the `done` callback the gate invokes after a successful submit so the
 * router can re-evaluate gating and move the user on.
 *
 * @param {Function} [done] invoked once onboarding completes successfully (router re-guards).
 */
export function enterOnboarding(done) {
  onComplete = typeof done === "function" ? done : () => {};
  const view = $("onboarding-view");
  if (!view) return;
  if (!shell) buildShell(view);
  load();
}

// Bridge for ad-hoc use / parity with the other view modules.
if (typeof window !== "undefined") {
  window.tmOnboarding = { enterOnboarding };
}
