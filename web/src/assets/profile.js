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
// AVATAR (TM-166, B5). The avatar slot is a real upload control: image preview + file input + upload
// progress + inline error states (see `buildAvatar()`). The bytes go to Firebase Storage at
// `avatars/{uid}`; on success we set the Firebase user's `photoURL` to the download URL — the single
// source of truth. We persist NOTHING avatar-related on our side; the preview + nav read `photoURL`
// straight off the Firebase user (TM-164 also surfaces it on GET /me). Storage isn't enabled in prod
// until the HITL TM-184 — when it isn't configured the control degrades to a disabled state rather
// than hard-failing the page.

import { getMe, updateMe, ApiError } from "./api.js";
import { currentUser } from "./auth.js";
import { isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES } from "./storage.js";
import { paintNavAvatar as onAvatarChanged } from "./nav-avatar.js";
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
    fill: timezoneGuess,
  },
  {
    key: "locale",
    label: "Locale",
    type: "text",
    maxLength: 35,
    autocomplete: "off",
    hint: "BCP-47 tag, e.g. en-GB.",
    fill: localeGuess,
  },
];

const NOTIFICATION_VALUES = new Set(["EMAIL", "PUSH", "BOTH"]);

// Best-guess fillers for the timezone/locale fields (TM-167 union), so a user can one-tap their
// current values instead of typing an IANA/BCP-47 string. Both fail soft to "" if the browser
// can't tell us (validation then leaves the empty field untouched).
function timezoneGuess() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function localeGuess() {
  return (typeof navigator !== "undefined" && navigator.language) || "";
}

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

/**
 * The avatar upload control (TM-166, B5): a circular preview of the current `photoURL`, a file input,
 * an upload progress bar, and an inline error line. On a valid pick it uploads the bytes to Firebase
 * Storage and sets the Firebase user's `photoURL` to the download URL (the single source of truth) —
 * nothing avatar-related is persisted on our side. Degrades to a disabled state when Storage isn't
 * configured (prod before HITL TM-184), so the page never hard-fails on the missing bucket.
 *
 * Returns `{ wrapper, refresh }`; `refresh()` repaints the preview from the current Firebase photoURL.
 */
function buildAvatar() {
  const configured = isStorageConfigured();

  const initial = el("span", { class: "tm-avatar-initial", "aria-hidden": "true", text: "🙂" });
  const image = el("img", { class: "tm-avatar-img", alt: "", hidden: true });
  const frame = el("div", { class: "tm-avatar-frame", "aria-hidden": "true" }, [initial, image]);

  const fileInput = el("input", {
    id: "profile-avatar-file",
    class: "tm-avatar-file",
    type: "file",
    accept: "image/*",
    "aria-describedby": "profile-avatar-error profile-avatar-hint",
    disabled: !configured,
  });

  const progressBar = el("div", { class: "tm-avatar-progress-bar" });
  const progress = el(
    "div",
    {
      class: "tm-avatar-progress",
      role: "progressbar",
      "aria-label": "Upload progress",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      hidden: true,
    },
    [progressBar],
  );

  const error = el("p", { id: "profile-avatar-error", class: "tm-field-error", role: "alert", hidden: true });
  const hint = el("p", {
    id: "profile-avatar-hint",
    class: "tm-muted tm-avatar-note",
    text: configured
      ? `JPG, PNG or GIF, up to ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB.`
      : "Avatar uploads aren't available in this environment yet.",
  });

  /** Paint the preview from the live Firebase photoURL (image if present, else the initial glyph). */
  const refresh = () => {
    const url = currentUser()?.photoURL || "";
    if (url) {
      image.src = url; // assigning .src is XSS-safe (no markup parse) — never innerHTML.
      image.hidden = false;
      initial.hidden = true;
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      initial.hidden = false;
    }
  };

  const setError = (msg) => {
    error.textContent = msg || "";
    error.hidden = !msg;
  };
  const setProgress = (fraction) => {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progress.hidden = false;
    progressBar.style.width = `${pct}%`;
    progress.setAttribute("aria-valuenow", String(pct));
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    setError("");

    // Fail fast on the client (mirrors the Storage rules) before any network round-trip.
    const invalid = validateAvatarFile(file);
    if (invalid) {
      setError(invalid);
      toast(invalid, { type: "error" });
      fileInput.value = "";
      return;
    }

    fileInput.disabled = true;
    setProgress(0);
    try {
      await uploadAvatar(file, setProgress);
      refresh();
      onAvatarChanged(); // repaint the nav avatar from the new photoURL.
      toast("Avatar updated.", { type: "success" });
    } catch (err) {
      const msg = err?.message || "Could not upload your avatar.";
      setError(msg);
      toast(msg, { type: "error" });
    } finally {
      fileInput.disabled = false;
      progress.hidden = true;
      progressBar.style.width = "0%";
      fileInput.value = ""; // allow re-picking the same file after an error.
    }
  });

  refresh();

  const wrapper = el("section", { class: "tm-profile-avatar", "aria-label": "Avatar" }, [
    frame,
    el("div", { class: "tm-avatar-meta" }, [
      el("label", { class: "tm-field-label", for: "profile-avatar-file", text: "Avatar" }),
      fileInput,
      progress,
      hint,
      error,
    ]),
  ]);
  return { wrapper, refresh };
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

  // A "fill" field (timezone/locale) gets a one-tap button that drops in the browser's best guess,
  // then re-validates so any stale inline error clears (TM-167 union — from the #162 build).
  const control = field.fill
    ? el("div", { class: "tm-field-fill" }, [
        input,
        el(
          "button",
          {
            class: "tm-btn tm-btn-sm",
            type: "button",
            onClick: () => {
              const guess = field.fill();
              if (guess) {
                input.value = guess;
                setFieldError(field.key, validateField(field, guess));
              }
            },
          },
          "Use mine",
        ),
      ])
    : input;

  const wrapper = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: field.label }),
    control,
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

  const avatar = buildAvatar();

  const form = el("form", { class: "tm-profile-form", id: "profile-form", novalidate: true, onSubmit: save }, [
    avatar.wrapper,
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

  shell = { form, fields, save, reset, summary, status, avatar };
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
