// Self-service edit-profile page (TM-167) — the #/profile view. Lets a signed-in user view and edit
// their own profile fields (the TM-162 contract): firstName, lastName, city, age, phone, notification
// preference (EMAIL/PUSH/BOTH), timezone, and locale. Loads the current values from GET /api/v1/me and
// saves changes via PATCH /api/v1/me, surfacing both client-side and backend (RFC-7807) validation
// errors next to the offending fields plus a success toast on save. Reuses the TM-133 UX kit (el/
// clear/toast) and the existing styles; the router (TM-109) gates the route + owns view visibility.
//
// XSS-safety is inherited from the kit: every node is built with `el()` (textContent only) — no
// innerHTML seam, so a backend-supplied name/city can never inject markup.
//
// AVATAR (TM-166, B5) — NOT MERGED YET. The avatar upload control is intentionally a disabled,
// clearly-marked placeholder here (see `avatarPlaceholder()`); it is wired to nothing. When TM-166
// lands, drop the real control into that slot — the rest of the page needs no rework.

import { getMe, updateMe, ApiError } from "./api.js";
import { clear, el, toast } from "./ui.js";

// The editable fields and their client-side rules, mirroring the backend's UpdateMeRequest bean
// validation (openapi.json) so we fail fast in the browser AND match what the server will accept.
// Keeping a single declarative list keeps the form, the read-back, and the patch builder in sync.
const TEXT_MAX = 255;
const FIELDS = [
  { key: "firstName", label: "First name", type: "text", maxLength: TEXT_MAX, autocomplete: "given-name" },
  { key: "lastName", label: "Last name", type: "text", maxLength: TEXT_MAX, autocomplete: "family-name" },
  { key: "city", label: "City", type: "text", maxLength: TEXT_MAX, autocomplete: "address-level2" },
  {
    key: "age",
    label: "Age",
    type: "number",
    min: 13,
    max: 120,
    autocomplete: "off",
    hint: "Between 13 and 120.",
  },
  {
    key: "phone",
    label: "Phone",
    type: "tel",
    maxLength: 32,
    autocomplete: "tel",
    // Same shape the backend enforces (UpdateMeRequest.phone pattern): optional +, digits/space/()./- .
    pattern: "^\\+?[0-9 ()./-]{3,32}$",
    hint: "Digits, spaces and + ( ) . / - only.",
  },
  {
    key: "notificationPref",
    label: "Notifications",
    type: "select",
    options: [
      ["EMAIL", "Email"],
      ["PUSH", "Push"],
      ["BOTH", "Email and push"],
    ],
  },
  {
    key: "timezone",
    label: "Time zone",
    type: "text",
    maxLength: 64,
    autocomplete: "off",
    hint: "IANA name, e.g. Europe/London.",
  },
  {
    key: "locale",
    label: "Locale",
    type: "text",
    maxLength: 35,
    autocomplete: "off",
    hint: "BCP-47 tag, e.g. en-GB.",
  },
];

const NOTIFICATION_VALUES = new Set(["EMAIL", "PUSH", "BOTH"]);

const state = {
  loaded: false,
  loading: false,
  error: null, // load error (distinct from per-field validation)
  profile: null, // last MeResponse
};

let shell = null; // { form, fields: Map<key,{input, error, hint}>, save, summary } once built

const $ = (id) => document.getElementById(id);

// ---- client-side validation -----------------------------------------------------------------

/**
 * Validate one field's raw string value against its rules. Returns an error message, or "" if valid.
 * Empty is always allowed (the backend treats missing/blank as "leave unchanged"); we only validate
 * what the user actually typed so we never block clearing a field.
 */
function validateField(field, raw) {
  const value = (raw ?? "").trim();
  if (value === "") return "";
  if (field.type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return "Enter a whole number.";
    if (field.min != null && n < field.min) return `Must be ${field.min} or more.`;
    if (field.max != null && n > field.max) return `Must be ${field.max} or less.`;
    return "";
  }
  if (field.type === "select") {
    if (field.key === "notificationPref" && !NOTIFICATION_VALUES.has(value)) return "Choose a valid option.";
    return "";
  }
  if (field.maxLength != null && value.length > field.maxLength) {
    return `Must be ${field.maxLength} characters or fewer.`;
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return "Format looks invalid.";
  }
  return "";
}

/** Show/clear the inline error message for a field and reflect it on the input for a11y. */
function setFieldError(key, message) {
  const f = shell?.fields.get(key);
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
  for (const field of FIELDS) setFieldError(field.key, "");
}

/** Validate every field; return true if all valid (and paint inline errors as a side effect). */
function validateAll() {
  let ok = true;
  for (const field of FIELDS) {
    const msg = validateField(field, shell.fields.get(field.key).input.value);
    setFieldError(field.key, msg);
    if (msg) ok = false;
  }
  return ok;
}

// ---- data -----------------------------------------------------------------------------------

/** Populate the inputs from a MeResponse (null/undefined → empty; notificationPref defaults sensibly). */
function fillForm(profile) {
  for (const field of FIELDS) {
    const input = shell.fields.get(field.key).input;
    const value = profile?.[field.key];
    if (field.type === "select") {
      input.value = NOTIFICATION_VALUES.has(value) ? value : "EMAIL";
    } else {
      input.value = value == null ? "" : String(value);
    }
  }
  // A read-only summary line so the user can see whose profile this is (email is not editable here).
  if (shell.summary) {
    shell.summary.textContent = profile?.email
      ? `Signed in as ${profile.email}`
      : "Your profile";
  }
}

/** Build the PATCH body: trimmed values, age coerced to a number, blanks sent as "" to clear. */
function collectPatch() {
  const patch = {};
  for (const field of FIELDS) {
    const raw = (shell.fields.get(field.key).input.value ?? "").trim();
    if (field.type === "number") {
      // Only send age when present; an empty number field means "no change" rather than 0.
      if (raw !== "") patch[field.key] = Number(raw);
    } else {
      patch[field.key] = raw;
    }
  }
  return patch;
}

async function load() {
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    const profile = await getMe();
    state.profile = profile;
    state.loaded = true;
    fillForm(profile);
  } catch (err) {
    // A 401 will already have redirected (api.js); surface anything else as a retryable error.
    state.error = "Could not load your profile.";
    console.warn("[profile] GET /api/v1/me failed:", err?.message ?? err);
  } finally {
    state.loading = false;
    renderStatus();
  }
}

async function save(event) {
  event.preventDefault();
  clearAllFieldErrors();
  if (!validateAll()) {
    toast("Please fix the highlighted fields.", { type: "error" });
    return;
  }

  const patch = collectPatch();
  shell.save.disabled = true;
  const original = shell.save.textContent;
  shell.save.textContent = "Saving…";
  try {
    const updated = await updateMe(patch);
    state.profile = updated;
    fillForm(updated);
    toast("Profile saved.", { type: "success" });
  } catch (err) {
    if (err instanceof ApiError && err.fieldErrors.length) {
      // Backend RFC-7807 validation: attach each message to its field; toast a summary for the rest.
      let attached = 0;
      const leftover = [];
      for (const fe of err.fieldErrors) {
        if (shell.fields.has(fe.field)) {
          setFieldError(fe.field, fe.message);
          attached += 1;
        } else {
          leftover.push(fe.message);
        }
      }
      toast(
        leftover.length
          ? leftover.join(" ")
          : `Please fix the highlighted field${attached === 1 ? "" : "s"}.`,
        { type: "error" },
      );
    } else {
      const msg = err instanceof ApiError ? err.message : "Could not save your profile.";
      toast(msg, { type: "error" });
    }
  } finally {
    shell.save.disabled = false;
    shell.save.textContent = original;
  }
}

// ---- rendering ------------------------------------------------------------------------------

/** The disabled, clearly-marked avatar slot pending TM-166 (B5). Wired to nothing — see file header. */
function avatarPlaceholder() {
  // TODO(TM-166): replace this disabled placeholder with the real avatar upload control once B5 lands.
  return el("section", { class: "tm-profile-avatar", "aria-label": "Avatar" }, [
    el("div", { class: "tm-avatar-frame", "aria-hidden": "true" }, [el("span", { text: "🙂" })]),
    el("div", { class: "tm-avatar-meta" }, [
      el("span", { class: "tm-field-label", text: "Avatar" }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: true }, "Upload — coming soon"),
      el("p", { class: "tm-muted tm-avatar-note", text: "Avatar upload arrives with TM-166." }),
    ]),
  ]);
}

function buildField(field) {
  const id = `profile-${field.key}`;
  const errorId = `${id}-error`;
  const hintId = field.hint ? `${id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");

  let input;
  if (field.type === "select") {
    input = el(
      "select",
      { id, class: "tm-input", name: field.key, "aria-describedby": describedBy },
      field.options.map(([value, label]) => el("option", { value, text: label })),
    );
  } else {
    input = el("input", {
      id,
      class: "tm-input",
      type: field.type,
      name: field.key,
      maxLength: field.maxLength,
      min: field.min,
      max: field.max,
      pattern: field.pattern,
      autocomplete: field.autocomplete,
      inputmode: field.type === "number" ? "numeric" : null,
      "aria-describedby": describedBy,
    });
  }
  // Live-clear an inline error as soon as the user starts correcting the field.
  input.addEventListener("input", () => setFieldError(field.key, validateField(field, input.value)));

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
    fields.set(field.key, { input: built.input, error: built.error });
    return built.wrapper;
  });

  const summary = el("p", { class: "tm-muted", id: "profile-summary", text: "Your profile" });
  const save = el("button", { class: "tm-btn tm-btn-primary", type: "submit" }, "Save changes");
  const reset = el(
    "button",
    { class: "tm-btn", type: "button", onClick: () => { fillForm(state.profile); clearAllFieldErrors(); } },
    "Reset",
  );

  const form = el("form", { class: "tm-profile-form", id: "profile-form", novalidate: true, onSubmit: save }, [
    avatarPlaceholder(),
    el("div", { class: "tm-form-grid" }, fieldNodes),
    el("div", { class: "tm-form-actions" }, [save, reset]),
  ]);

  const status = el("div", { id: "profile-status" });

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      el("h2", { text: "Edit profile" }),
      el("a", { class: "tm-btn tm-btn-sm", href: "#/home" }, "Back to home"),
    ]),
    summary,
    status,
    form,
  );

  shell = { form, fields, save, reset, summary, status };
}

/** Reflect load/error state: hide the form while loading or on a load error, show a retry. */
function renderStatus() {
  if (!shell) return;
  clear(shell.status);
  if (state.loading && !state.loaded) {
    shell.form.hidden = true;
    shell.status.append(el("p", { class: "tm-muted", text: "Loading your profile…" }));
    return;
  }
  if (state.error) {
    shell.form.hidden = true;
    shell.status.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.error }),
      el("button", { class: "tm-btn", type: "button", onClick: load }, "Retry"),
    ]));
    return;
  }
  shell.form.hidden = false;
}

// ---- mount ----------------------------------------------------------------------------------

/** Called by the router when the #/profile view becomes active. Builds the shell once, then loads. */
export function enterProfile() {
  const view = $("profile-view");
  if (!view) return;
  if (!shell) buildShell(view);
  load();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmProfile = { enterProfile };
}
