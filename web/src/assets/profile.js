// Self-service edit-profile page — TM-167 / F1.
//
// The `#/profile` view: shows the signed-in user's profile (from GET /api/v1/me, TM-162) and lets
// them edit it, saving via PATCH /api/v1/me. Framework-free, built on the TM-133 UX kit (el/toast)
// and the authenticated API client (api.js). router.js owns visibility + calls enterProfile() on
// entry; this module owns the form.
//
// Validation is surfaced from both sides: the inputs carry native constraints, and the backend's
// RFC 7807 errors (per-field on a 400, ApiError.fieldErrors) are rendered inline under each field.
//
// Avatar (AC): the upload control depends on B5 (TM-166: POST /api/v1/me/avatar + Cloud Storage),
// which isn't merged yet. It's rendered as a clearly-disabled, forward-wired section so the page is
// complete for every text field today and the avatar drops in with a small change when B5 lands.

import { el, clear, toast } from "./ui.js";
import { getMe, patchMe, ApiError } from "./api.js";

// The editable fields, in display order. `kind` drives the input; `hint` is placeholder text.
const FIELDS = [
  { name: "firstName", label: "First name", kind: "text", autocomplete: "given-name", maxlength: 100 },
  { name: "lastName", label: "Last name", kind: "text", autocomplete: "family-name", maxlength: 100 },
  { name: "city", label: "City", kind: "text", autocomplete: "address-level2", maxlength: 120 },
  { name: "age", label: "Age", kind: "number", min: 13, max: 120 },
  { name: "phone", label: "Phone", kind: "tel", autocomplete: "tel", maxlength: 32, hint: "+44 20 7946 0000" },
  {
    name: "notificationPref",
    label: "Notifications",
    kind: "select",
    options: [
      ["EMAIL", "Email only"],
      ["PUSH", "Push only"],
      ["BOTH", "Email and push"],
    ],
  },
  { name: "timezone", label: "Timezone", kind: "fill", hint: "Europe/London", fill: timezoneGuess, fillLabel: "Use mine" },
  { name: "locale", label: "Language", kind: "fill", hint: "en-GB", fill: localeGuess, fillLabel: "Use mine" },
];

const state = { me: null, loading: false, saving: false, error: null };
const inputs = new Map(); // field name -> input element
const errorSlots = new Map(); // field name -> inline error <span>
let view = null;

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

// ---- data ---------------------------------------------------------------------------------

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    state.me = await getMe();
  } catch (err) {
    // 401 is already handled by api.js (refresh + redirect); surface anything else.
    state.error = "Could not load your profile. Please try again.";
    console.warn("[profile] GET /api/v1/me failed:", err?.message ?? err);
  } finally {
    state.loading = false;
    render();
  }
}

/**
 * Collect the editable fields into a PATCH body. Only non-empty values are sent: the backend
 * treats an omitted field as "leave unchanged" (so clearing a field isn't supported in v1 — a
 * documented limitation). `age` is sent as a number.
 */
function collectBody() {
  const body = {};
  for (const f of FIELDS) {
    const raw = inputs.get(f.name)?.value ?? "";
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (value === "") continue;
    body[f.name] = f.kind === "number" ? Number(value) : value;
  }
  return body;
}

function clearFieldErrors() {
  for (const slot of errorSlots.values()) {
    slot.textContent = "";
    slot.hidden = true;
  }
}

function showFieldErrors(fieldErrors) {
  for (const [field, message] of Object.entries(fieldErrors)) {
    const slot = errorSlots.get(field);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
  }
}

async function save(event) {
  event.preventDefault();
  if (state.saving) return;
  clearFieldErrors();
  state.saving = true;
  syncSaveButton();
  try {
    const updated = await patchMe(collectBody());
    state.me = updated;
    populate(); // reflect any normalisation the server applied
    toast("Profile saved.", { type: "success" });
  } catch (err) {
    if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
      showFieldErrors(err.fieldErrors);
      toast("Please fix the highlighted fields.", { type: "error" });
    } else if (err instanceof ApiError) {
      // A non-field problem (e.g. an unknown timezone → 400 detail, or a 409 conflict).
      toast(err.message, { type: "error" });
    } else {
      toast("Could not save your profile. Please try again.", { type: "error" });
      console.warn("[profile] PATCH /api/v1/me failed:", err?.message ?? err);
    }
  } finally {
    state.saving = false;
    syncSaveButton();
  }
}

// ---- view ---------------------------------------------------------------------------------

/** Fill the inputs from the current `state.me`. */
function populate() {
  if (!state.me) return;
  for (const f of FIELDS) {
    const input = inputs.get(f.name);
    if (!input) continue;
    const value = state.me[f.name];
    input.value = value == null ? "" : String(value);
  }
}

function syncSaveButton() {
  const btn = view?.querySelector("#profile-save");
  if (btn) {
    btn.disabled = state.saving;
    btn.textContent = state.saving ? "Saving…" : "Save changes";
  }
}

function fieldRow(f) {
  const errorSlot = el("span", { class: "field-error", role: "alert", hidden: true });
  errorSlots.set(f.name, errorSlot);

  let input;
  if (f.kind === "select") {
    input = el(
      "select",
      { id: `profile-${f.name}`, class: "tm-input" },
      f.options.map(([value, label]) => el("option", { value, text: label })),
    );
  } else {
    input = el("input", {
      id: `profile-${f.name}`,
      class: "tm-input",
      type: f.kind === "number" ? "number" : f.kind === "tel" ? "tel" : "text",
      autocomplete: f.autocomplete || "off",
      placeholder: f.hint || "",
      ...(f.maxlength ? { maxlength: f.maxlength } : {}),
      ...(f.min != null ? { min: f.min } : {}),
      ...(f.max != null ? { max: f.max } : {}),
    });
  }
  inputs.set(f.name, input);

  // A "fill" field gets a button that drops in the browser's best guess (timezone/locale).
  const control =
    f.kind === "fill"
      ? el("div", { class: "field-fill" }, [
          input,
          el(
            "button",
            {
              type: "button",
              class: "tm-btn tm-btn-sm",
              onClick: () => {
                const guess = f.fill();
                if (guess) input.value = guess;
              },
            },
            f.fillLabel || "Use mine",
          ),
        ])
      : input;

  return el("label", { class: "field" }, [el("span", { text: f.label }), control, errorSlot]);
}

/** The avatar section — forward-wired but disabled until B5 (TM-166) lands. */
function avatarSection() {
  const photoUrl = state.me?.photoURL || null;
  return el("div", { class: "profile-avatar" }, [
    el("div", { class: "profile-avatar-preview", "aria-hidden": "true" }, [
      photoUrl ? el("img", { src: photoUrl, alt: "", class: "profile-avatar-img" }) : el("span", { text: "🙂" }),
    ]),
    el("div", { class: "profile-avatar-meta" }, [
      el("span", { class: "field-label", text: "Profile photo" }),
      el("input", { type: "file", accept: "image/*", class: "tm-input", disabled: true, "aria-label": "Upload profile photo" }),
      el("p", { class: "field-note", text: "Photo upload is coming soon (depends on TM-166)." }),
    ]),
  ]);
}

function render() {
  if (!view) return;
  clear(view);
  inputs.clear();
  errorSlots.clear();

  if (state.loading) {
    view.append(el("p", { class: "status", text: "Loading your profile…" }));
    return;
  }
  if (state.error) {
    view.append(
      el("div", { class: "profile-card" }, [
        el("p", { class: "auth-error", text: state.error }),
        el("button", { class: "tm-btn tm-btn-primary", type: "button", onClick: load }, "Retry"),
      ]),
    );
    return;
  }

  const form = el("form", { id: "profile-form", class: "profile-form", novalidate: true, onSubmit: save }, [
    avatarSection(),
    el("div", { class: "profile-fields" }, FIELDS.map(fieldRow)),
    el("div", { class: "profile-actions" }, [
      el("button", { id: "profile-save", class: "tm-btn tm-btn-primary", type: "submit" }, "Save changes"),
    ]),
  ]);

  view.append(
    el("div", { class: "profile-card" }, [
      el("div", { class: "profile-head" }, [
        el("h2", { text: "Edit profile" }),
        el("p", { class: "profile-sub", text: state.me?.email || state.me?.uid || "" }),
      ]),
      form,
    ]),
  );
  populate();
}

// ---- mount --------------------------------------------------------------------------------

/** Called by the router when the profile view becomes active. Builds the form and loads /me. */
export function enterProfile() {
  view = document.getElementById("profile-view");
  if (!view) return;
  load();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmProfile = { enterProfile };
}
