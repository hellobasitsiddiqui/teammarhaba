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

import {
  getMe,
  submitOnboarding,
  updateMe,
  getInterestCatalogue,
  getInterestConfig,
  ApiError,
} from "./api.js";
import { clear, el, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import {
  groupCatalogue,
  selectionBounds,
  validateSelection,
  canFinish,
  toInterestsPayload,
  selectedLabelsFromMe,
} from "./onboarding-core.js";

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
  // ---- interests PICK STEP (TM-776) — a post-gate step in the SAME view. The atomic name/location/age
  // gate above is untouched; interests are the separate PATCH /me follow-on, entered only AFTER the gate
  // has lifted (onboardingCompleted=true), so a failure here can never trap a user out of the app.
  step: "profile", // "profile" | "interests"
  me: null, // the last GET /me (used to pre-select a returning half-onboarded user's saved picks)
  catalogue: null, // Array<{label,category,highlighted,sortWeight}> once fetched, or null
  bounds: { min: 1, max: 3 }, // effective selection bounds (server config, hard-min-1 floored)
  selected: new Set(), // the labels the user has toggled on
  interestsLoading: false,
  catalogueFailed: false, // a non-fatal catalogue/config fetch failure → skip the step, don't trap
};

let shell = null; // { form, fields: Map<field,{input,error}>, submit } once built
let interestsShell = null; // { finishBtn, countLine, error, chips: Map<label,button> } once built

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
    state.me = profile; // cache for the interests step's returning-user pre-select
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
    const updated = await submitOnboarding(collectBody());
    if (updated) state.me = updated; // freshest /me (carries any already-saved interests for pre-select)
    toast("Welcome to Circle!", { type: "success" });
    // The atomic gate has lifted (server now reports onboardingCompleted). Instead of finishing here,
    // move to the SECOND step — pick interests — in the same view (TM-776). We do NOT call onComplete()
    // yet; that happens once interests are saved (or the fetch failed, see enterInterestsStep). This
    // preserves the TM-250 all-or-nothing contract: the gate submitted atomically and independently of
    // interests, which are a clean PATCH /me follow-on the onboarding endpoint could never carry.
    await enterInterestsStep();
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
      const msg = err instanceof ApiError ? err.message : "Couldn't save your profile. Please try again.";
      toast(msg, { type: "error" });
    }
  } finally {
    shell.submit.disabled = false;
    shell.submit.textContent = original;
  }
}

// ---- interests PICK STEP (TM-776) -----------------------------------------------------------
//
// A post-gate step in the SAME onboarding view. The atomic name/location/age gate has already lifted
// (onboardingCompleted=true) by the time we get here, so NOTHING below can trap a user out of the app:
// if the catalogue/config can't be fetched we skip the step and finish; if the interests PATCH fails
// we keep the user on the step to retry (their gate submission already stuck). Interests are always
// recoverable later from the profile Interests card.

/**
 * Enter the interests step: lazily fetch the catalogue + config in parallel, pre-select a returning
 * user's saved picks, then re-render the card body into the picker. On any fetch failure the step is
 * skipped entirely (a gated user is never trapped) and control hands back to the router via onComplete.
 */
async function enterInterestsStep() {
  const view = $("onboarding-view");
  if (!view) {
    onComplete();
    return;
  }
  state.interestsLoading = true;
  try {
    const [catalogue, config] = await Promise.all([getInterestCatalogue(), getInterestConfig()]);
    state.catalogue = Array.isArray(catalogue) ? catalogue : [];
    state.bounds = selectionBounds(config);
  } catch (err) {
    // Non-fatal: the user already passed the atomic gate. Skip the step rather than trap them; they can
    // add interests later from the profile Interests card (I6).
    console.warn("[onboarding] interests catalogue/config fetch failed — skipping the step:", err?.message ?? err);
    state.catalogueFailed = true;
    onComplete();
    return;
  } finally {
    state.interestsLoading = false;
  }

  // Pre-select the returning half-onboarded user's saved picks, keeping only labels still on offer.
  const offered = new Set(state.catalogue.map((r) => r.label));
  state.selected = new Set(selectedLabelsFromMe(state.me).filter((label) => offered.has(label)));

  state.step = "interests";
  buildInterestsStep(view);
}

/** Repaint one chip's selected/disabled visual state from `state.selected` + the max cap. */
function paintChip(button, label) {
  const on = state.selected.has(label);
  // .tm-pf-chip-on is a MODIFIER layered on top of the base .tm-pf-chip (which carries the
  // padding/border/radius) — exactly how profile.js pairs them — so keep .tm-pf-chip always and only
  // toggle the -on modifier. Toggling them mutually-exclusively would strip a selected chip's padding.
  button.classList.toggle("tm-pf-chip-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  // Max-cap UX: once the ceiling is hit, dim/disable the UNSELECTED chips so the limit is felt before
  // submit; selected chips always stay toggleable OFF so the user can swap a pick.
  const atMax = state.selected.size >= state.bounds.max;
  const disabled = atMax && !on;
  button.disabled = disabled;
  button.setAttribute("aria-disabled", disabled ? "true" : "false");
}

/** Repaint every chip (after any selection change) so the max-cap dimming stays consistent. */
function repaintAllChips() {
  if (!interestsShell) return;
  for (const [label, value] of interestsShell.chips) {
    // A label maps to a single button, or an array (a highlighted row rendered in Popular AND its home
    // category) — paint every instance so both copies stay in sync.
    const buttons = Array.isArray(value) ? value : [value];
    for (const button of buttons) paintChip(button, label);
  }
}

/** Update the live "N of max M selected" count line + the Finish CTA enabled state. */
function refreshInterestsControls() {
  if (!interestsShell) return;
  const n = state.selected.size;
  interestsShell.countLine.textContent = `${n} of max ${state.bounds.max} selected`;
  interestsShell.finishBtn.disabled = !canFinish(state.selected, state.bounds);
  // Clear any stale inline error once the selection is valid again.
  if (canFinish(state.selected, state.bounds)) setInterestsError("");
}

/** Toggle a label in the selection, respecting the hard max, then repaint everything. */
function toggleInterest(label) {
  if (state.selected.has(label)) {
    state.selected.delete(label);
  } else {
    if (state.selected.size >= state.bounds.max) return; // hard cap — ignore (the chip is disabled anyway)
    state.selected.add(label);
  }
  repaintAllChips();
  refreshInterestsControls();
}

/** Show/clear the inline error near the chips (mirrors setFieldError for the picker). */
function setInterestsError(message) {
  if (!interestsShell) return;
  interestsShell.error.textContent = message || "";
  interestsShell.error.hidden = !message;
}

/** One toggle chip for a catalogue row — a real <button> so keyboard + aria-pressed work. */
function buildChip(row) {
  const button = el("button", {
    type: "button",
    class: "tm-pf-chip",
    "aria-pressed": "false",
    "data-label": row.label,
    text: row.label,
    onClick: () => toggleInterest(row.label),
  });
  return button;
}

/** Build one group section: a muted category heading + a wrap of toggle chips. */
function buildGroupSection(group, chips) {
  const heading = el("h3", { class: "tm-interests-group-head", text: group.category });
  const chipWrap = el("div", { class: "tm-pf-chips tm-interests-chips" });
  for (const row of group.items) {
    // A highlighted row appears in Popular AND its home category. Selection is keyed by LABEL, so the
    // SAME <button> instance can't live in two DOM parents; build a distinct button per placement and
    // register both under the label so a toggle repaints every copy in sync.
    const chip = buildChip(row);
    chipWrap.append(chip);
    if (chips.has(row.label)) {
      // Second placement (Popular + home): remember all instances for this label.
      const existing = chips.get(row.label);
      const list = Array.isArray(existing) ? existing : [existing];
      list.push(chip);
      chips.set(row.label, list);
    } else {
      chips.set(row.label, chip);
    }
  }
  return el("section", { class: "tm-interests-group" }, [heading, chipWrap]);
}

/**
 * Render the interests picker into the card body: bump the step pill to "Step 2 of 3", swap the
 * heading + doodle, then a group section per {@link groupCatalogue} (Popular first), a live count line,
 * an inline error slot, and a primary "Finish" CTA disabled until {@link canFinish}. A "Skip for now"
 * link is rendered ONLY when the effective min is 0 (the seed default is 1 → hard-min-1 → no skip).
 */
function buildInterestsStep(view) {
  const groups = groupCatalogue(state.catalogue);

  // chips: Map<label, button | button[]> — one entry per label, holding every rendered chip instance so
  // paintChip can keep a highlighted row's Popular + home copies visually in sync.
  const chips = new Map();
  const groupSections = groups.map((group) => buildGroupSection(group, chips));

  const countLine = el("p", { class: "tm-interests-count tm-muted", "aria-live": "polite" });
  const error = el("p", { class: "tm-field-error", role: "alert", hidden: true });

  const finishBtn = el("button", { class: "tm-btn tm-btn-primary tm-cta", type: "button", onClick: submitInterests }, [
    el("span", { text: "Finish" }),
    svg(
      "svg",
      { class: "tm-btn-icon", viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
        stroke: "currentColor", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round",
        "aria-hidden": "true", focusable: "false" },
      [svg("path", { d: "M5 12h13M13 6l6 6-6 6" })],
    ),
  ]);

  const actions = [finishBtn];
  // Skip is only offered when a user is genuinely allowed to pick nothing (min 0). With the seed default
  // min 1 the CTA simply stays disabled until at least one is chosen — no Skip link.
  if (state.bounds.min === 0) {
    actions.push(
      el("button", { class: "tm-btn tm-interests-skip", type: "button", text: "Skip for now", onClick: () => onComplete() }),
    );
  }

  const body = el("div", { class: "tm-interests-groups" }, groupSections.length
    ? groupSections
    // Defensive empty state: the catalogue fetch succeeded but returned nothing. Don't trap — let them finish.
    : [el("p", { class: "tm-muted", text: "No interests to pick right now — you can add some later." })]);

  clear(view).append(
    el("div", { class: "tm-onboarding-card" }, [
      el("div", { class: "tm-admin-head tm-onboarding-head" }, [
        el("span", { class: "tm-step-pill", "aria-hidden": "true", text: "Step 2 of 3" }),
        el("h2", {}, [doodle("crowd", { class: "tm-doodle-header", title: "Pick your interests" }), "Pick your interests"]),
        svg(
          "svg",
          { class: "tm-onboarding-squiggle", viewBox: "0 0 180 11", preserveAspectRatio: "none", fill: "none",
            "aria-hidden": "true", focusable: "false" },
          [svg("path", { d: "M3 7C34 2.5 56 2.5 82 6s54 4.5 68-.5 30-2 36 1.5", stroke: "currentColor", "stroke-width": 3.2, "stroke-linecap": "round" })],
        ),
      ]),
      el("p", { class: "tm-muted", text: "Choose a few things you're into so we can suggest better meetups." }),
      body,
      countLine,
      error,
      el("div", { class: "tm-form-actions" }, actions),
    ]),
  );

  interestsShell = { finishBtn, countLine, error, chips };
  repaintAllChips();
  refreshInterestsControls();
}

/**
 * Save the picked interests via PATCH /api/v1/me (interests = the array of labels). Validates
 * client-side first (fail-fast UX mirror of the server), then submits. On success → finish (onComplete).
 * On a server 400 (a label just got retired, or a bounds mismatch) → surface it near the chips + toast,
 * and STAY on the step. Never re-runs the atomic onboarding POST.
 */
async function submitInterests() {
  if (!interestsShell) return;
  setInterestsError("");
  const check = validateSelection(state.selected, state.bounds);
  if (!check.ok) {
    setInterestsError(check.message);
    return;
  }

  interestsShell.finishBtn.disabled = true;
  const original = interestsShell.finishBtn.querySelector("span")?.textContent ?? "Finish";
  const labelSpan = interestsShell.finishBtn.querySelector("span");
  if (labelSpan) labelSpan.textContent = "Saving…";
  try {
    await updateMe({ interests: toInterestsPayload(state.selected) });
    toast("You're all set!", { type: "success" });
    onComplete(); // interests saved → hand control back to the router, which routes the user on.
  } catch (err) {
    if (err instanceof ApiError) {
      // Surface the server's message (e.g. a bounds mismatch, or a label retired since we loaded).
      const msg = err.fieldErrors.length ? err.fieldErrors.map((fe) => fe.message).join(" ") : err.message;
      setInterestsError(msg || "Couldn't save your interests. Please try again.");
      toast(msg || "Couldn't save your interests. Please try again.", { type: "error" });
    } else {
      toast("Couldn't save your interests. Please try again.", { type: "error" });
    }
  } finally {
    if (labelSpan) labelSpan.textContent = original;
    // Re-enable per the current selection validity (a failed save leaves a valid selection re-submittable).
    interestsShell.finishBtn.disabled = !canFinish(state.selected, state.bounds);
  }
}

// The router supplies this when it mounts the view, so the gate can hand control back on success
// without onboarding.js importing the router (avoids a cycle). Defaults to a no-op until set.
let onComplete = () => {};

// ---- rendering ------------------------------------------------------------------------------

// Small SVG builder for the paper-complete-profile inline field icons + accent squiggle. Uses
// createElementNS (createElement can't make real SVG) and setAttribute only — no innerHTML seam, in
// keeping with el()/doodles.js. Purely presentational chrome; touches no field/validation/submit code.
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child != null) node.append(child);
  }
  return node;
}
/** A framed line-art icon (stroke=currentColor, so it inks with the field label token). */
function fieldIcon(paths) {
  return svg(
    "svg",
    {
      class: "tm-field-icon", viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
      stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false",
    },
    paths.map((d) => svg("path", { d })),
  );
}
// A leading icon per real field (paper-complete-profile): person for name, pin for location, calendar
// for age. Keyed by the field property so it never affects the FIELDS array / validation / submit.
const FIELD_ICONS = {
  name: () => fieldIcon(["M12 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8", "M5.5 20a6.5 6.5 0 0 1 13 0"]),
  location: () => fieldIcon(["M12 21s6.5-5.5 6.5-10.5a6.5 6.5 0 0 0-13 0C5.5 15.5 12 21 12 21z", "M12 12.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4"]),
  age: () => fieldIcon(["M3.5 6.5q0-1.5 2-1.5h13q2 0 2 1.5v13q0 1.5-2 1.5h-13q-2 0-2-1.5z", "M3.5 9.5h17", "M8 3v3.5M16 3v3.5"]),
};

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

  // paper-complete-profile field: an uppercase muted label (via .tm-field-label CSS) + a leading inline
  // icon sitting inside a wrapper alongside the input. .tm-field-input keeps the icon + input on one row;
  // the input keeps its id/name/class so validation + submit are unchanged.
  const icon = FIELD_ICONS[field.field]?.();
  const inputRow = el("div", { class: "tm-field-input" }, [icon, input]);

  const wrapper = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: field.label }),
    inputRow,
    hint,
    error,
  ]);
  return { wrapper, input, error };
}

// TM-684: avatar upload + bio ship disabled; wire to onboarding payload
// Both are DISABLED visual stubs only — NOT in the FIELDS array, NOT validated, NOT read by
// collectBody(); they never touch the onboarding request. Rendered purely to match the mockup.
function buildAvatarStub() {
  const cam = svg(
    "svg",
    { class: "tm-avatar-cam", viewBox: "0 0 24 24", width: 34, height: 34, fill: "none",
      stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false" },
    [
      svg("path", { d: "M4 8.5h3l1.4-2h7.2L20 8.5h.5A1.5 1.5 0 0 1 22 10v8a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 18v-8A1.5 1.5 0 0 1 3.5 8.5" }),
      svg("circle", { cx: 12, cy: 13.6, r: 3.5 }),
    ],
  );
  const ring = el("div", { class: "tm-avatar-stub", "aria-hidden": "true" }, [cam]);
  return el("div", { class: "tm-avatar-uploader" }, [
    ring,
    el("span", { class: "tm-avatar-uploader-label", text: "Add a photo" }),
    el("span", { class: "tm-soon-tag", text: "Soon" }),
  ]);
}

function buildBioStub() {
  // A disabled short-bio field stub — matches the field styling but is inert (disabled, no name).
  const ta = el("textarea", {
    class: "tm-input tm-textarea", rows: 2, disabled: true, "aria-disabled": "true",
    placeholder: "A short line about you",
  });
  return el("div", { class: "tm-form-field tm-form-field-disabled" }, [
    el("label", { class: "tm-field-label", text: "Short bio" }, [el("span", { class: "tm-soon-tag", text: "Soon" })]),
    ta,
  ]);
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
  // paper-complete-profile CTA: primary "Continue" with a trailing arrow glyph (aria-hidden decoration).
  const submitBtn = el("button", { class: "tm-btn tm-btn-primary tm-cta", type: "submit" }, [
    el("span", { text: "Continue" }),
    svg(
      "svg",
      { class: "tm-btn-icon", viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
        stroke: "currentColor", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round",
        "aria-hidden": "true", focusable: "false" },
      [svg("path", { d: "M5 12h13M13 6l6 6-6 6" })],
    ),
  ]);

  const form = el("form", { class: "tm-onboarding-form", id: "onboarding-form", novalidate: true, onSubmit: submit }, [
    buildAvatarStub(),
    el("div", { class: "tm-form-grid" }, fieldNodes.length ? [fieldNodes[0], buildBioStub(), ...fieldNodes.slice(1)] : fieldNodes),
    el("div", { class: "tm-form-actions" }, [submitBtn]),
  ]);

  clear(view).append(
    el("div", { class: "tm-onboarding-card" }, [
      el("div", { class: "tm-admin-head tm-onboarding-head" }, [
        // Static decorative "Step 1 of 3" chrome — there is no real wizard, so it's a plain pill, no skip.
        el("span", { class: "tm-step-pill", "aria-hidden": "true", text: "Step 1 of 3" }),
        el("h2", {}, [doodle("host", { class: "tm-doodle-header", title: "Complete your profile" }), "Complete your profile"]),
        // Accent underline-squiggle under the heading (paper-complete-profile).
        svg(
          "svg",
          { class: "tm-onboarding-squiggle", viewBox: "0 0 180 11", preserveAspectRatio: "none", fill: "none",
            "aria-hidden": "true", focusable: "false" },
          [svg("path", { d: "M3 7C34 2.5 56 2.5 82 6s54 4.5 68-.5 30-2 36 1.5", stroke: "currentColor", "stroke-width": 3.2, "stroke-linecap": "round" })],
        ),
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
