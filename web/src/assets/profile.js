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

import { getMe, updateMe, getMembership, ApiError } from "./api.js";
import { currentUser, signOut } from "./auth.js";
import { isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES } from "./storage.js";
import { paintNavAvatar as onAvatarChanged } from "./nav-avatar.js";
import { isNativeCameraAvailable, captureAvatarImage } from "./native-camera.js";
import { clear, el, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { renderAccountBadges } from "./account-badges.js";
import { buildSecuritySettings } from "./biometric-settings.js";
import { buildAppearanceSettings } from "./appearance-settings.js";
// Pure Profile-screen logic (TM-514) — the identity/strength/public-preview models + route→mode map,
// unit-tested in web/tools/profile-core.test.mjs.
import {
  PROFILE_PUBLIC_ROUTE,
  profileMode,
  identitySummary,
  accountContact,
  profileStrength,
  publicSummary,
  validateProfileField,
  NOTIFICATION_PREFS,
} from "./profile-core.js";
// Membership tier metadata (TM-643) — the membership row now reflects the caller's REAL tier via the
// pure, unit-tested profileMembershipRow() (which sources tier NAMES from the shared tier catalogue),
// and "Manage" links to the membership screen when the feature flag is on.
import { profileMembershipRow, membershipEnabled, MEMBERSHIP_ROUTE } from "./membership-tier.js";

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

// Notification-pref values live in profile-core.js (NOTIFICATION_PREFS) — shared with the validator.

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
  // Thin delegate to the pure, unit-tested rule in profile-core.js (TM-162/TM-752). Keeping the logic
  // there means the behaviour — incl. the phone 7–15 digit guard on top of the char-pattern — is
  // guarded by tests, not just this DOM shell.
  return validateProfileField(field, raw);
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
      input.value = NOTIFICATION_PREFS.has(value) ? value : "EMAIL";
    } else {
      input.value = value == null ? "" : String(value);
    }
  }
  // Account-state badges (TM-168): email-verified / age-verified / MFA from the /me state block.
  // `includeUnknown` so the user always sees all three — including any the backend couldn't read —
  // rather than having a badge silently vanish.
  if (shell.badges) {
    clear(shell.badges);
    const group = renderAccountBadges(profile, { includeUnknown: true });
    if (group) shell.badges.append(group);
  }
  // Paint the paper-profile hub summary (identity + completeness) from the same /me payload.
  paintHub(profile);
}

/**
 * Paint the Profile hub summary (paper-profile): the identity header (avatar glyph + name + "City ·
 * age") and the "Profile strength" completeness bar + nudge — the restyled continuation of the
 * shipped completeness prompt. Reads the pure models from profile-core.js; no-op when the hub isn't
 * built (e.g. mid-teardown). The avatar image itself is owned by buildAvatar()/its refresh().
 */
function paintHub(profile) {
  const hub = shell?.hub;
  if (!hub) return;
  // Real /me data is landing — drop the loading skeleton so the concrete identity + strength paint
  // in (TM-663). Until this runs the hub shows a skeleton, never a misleading "0% / Your profile".
  shell?.root?.classList.remove("tm-pf-loading");
  const id = identitySummary(profile);
  hub.name.textContent = id.short;
  hub.meta.textContent = id.metaLine || "Add your city and age";
  hub.initial.textContent = id.initial;

  // Account contact (TM-783): the email + phone this account is registered with.
  const contact = accountContact(profile);
  hub.email.textContent = contact.email || "No email on file";
  hub.phone.textContent = contact.phoneDisplay;
  // A missing phone reads as a muted prompt, not a real value.
  hub.phone.classList.toggle("tm-pf-contact-empty", !contact.hasPhone);
  hub.email.classList.toggle("tm-pf-contact-empty", !contact.email);

  // Completeness: the photo counts too, read live off the Firebase user's photoURL (the single source
  // of truth, same as the avatar control) rather than anything persisted on our side.
  const hasPhoto = Boolean(currentUser()?.photoURL);
  const strength = profileStrength(profile, { hasPhoto });
  hub.bar.style.width = `${strength.percent}%`;
  hub.barPct.textContent = `${strength.percent}% complete`;
  // The nudge points at the first gaps; at 100% it reads as a reassurance, and we drop the arrow.
  hub.barNudge.textContent = strength.complete ? strength.nudge : `${strength.nudge} →`;
}

/** Build the PATCH body: trimmed values, age coerced to a number; blank fields are omitted. */
function collectPatch() {
  const patch = {};
  for (const field of FIELDS) {
    const raw = (shell.fields.get(field.key).input.value ?? "").trim();
    if (field.type === "number") {
      // Only send age when present; an empty number field means "no change" rather than 0.
      if (raw !== "") patch[field.key] = Number(raw);
    } else if (raw !== "") {
      // Omit blank optional text fields rather than sending "" — a blank phone would otherwise
      // be rejected by the server pattern (TM-188), and an untouched field should mean "no change".
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
  // Membership tier (TM-643) — a SEPARATE endpoint (GET /me/membership; MeResponse carries no tier),
  // fetched fresh (apiFetch uses cache:"no-store") on every profile entry so the row shows the caller's
  // CURRENT tier, e.g. "Monthly member" right after subscribing, not a stale "Pay as you go".
  await loadMembership();
}

/**
 * Fetch the caller's membership (TM-643) and paint the profile membership row from the REAL tier.
 * Best-effort and isolated from the /me load: a failed/absent read (or the feature being unavailable)
 * leaves the free-base default rather than breaking the page — the same defensive posture the
 * membership screen (enterMembershipTier) takes.
 */
async function loadMembership() {
  try {
    const membership = await getMembership();
    paintMembership(membership);
  } catch (err) {
    console.warn("[profile] GET /api/v1/me/membership failed:", err?.message ?? err);
  }
}

/**
 * Paint the Profile membership row (TM-643) from the caller's real membership. The tier→text mapping is
 * the pure, unit-tested profileMembershipRow() (membership-tier.js), so a paid subscriber sees their
 * actual tier label. No-op when the row isn't built (e.g. mid-teardown).
 */
function paintMembership(membership) {
  const memb = shell?.membership;
  if (!memb) return;
  memb.sub.textContent = profileMembershipRow(membership).text;
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
      const msg = err instanceof ApiError ? err.message : "Couldn't save your profile.";
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
  // On a Capacitor native platform (TM-278 Android shell) we offer the native capture/gallery picker
  // (TM-281) instead of the bare web file input. Off-device this is false, so the web flow is unchanged.
  const native = configured && isNativeCameraAvailable();

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
    // On native we drive uploads through the camera button instead; hide the bare file input so there's
    // a single, OS-appropriate entry point. The label's `for=` still points at it for a11y parity.
    hidden: native,
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
  const sizeHint = `JPG, PNG or GIF, up to ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB.`;
  const hint = el("p", {
    id: "profile-avatar-hint",
    class: "tm-muted tm-avatar-note",
    text: !configured
      ? "Avatar uploads aren't available in this environment yet."
      : native
        ? `Take a photo or choose one from your gallery. ${sizeHint}`
        : sizeHint,
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

  // Single upload path shared by BOTH the web file input and the native camera button (TM-281): a
  // picked image (web `<input>` or native capture/gallery) is validated then handed to the EXISTING
  // `uploadAvatar` — there is no parallel upload mechanism. `busy(state)` lets the caller disable its
  // own control (the file input or the camera button) while bytes transfer.
  const handlePickedFile = async (file, busy) => {
    if (!file) return;
    setError("");

    // Fail fast on the client (mirrors the Storage rules) before any network round-trip.
    const invalid = validateAvatarFile(file);
    if (invalid) {
      setError(invalid);
      toast(invalid, { type: "error" });
      return;
    }

    busy(true);
    setProgress(0);
    try {
      await uploadAvatar(file, setProgress);
      refresh();
      onAvatarChanged(); // repaint the nav avatar from the new photoURL.
      toast("Avatar updated.", { type: "success" });
    } catch (err) {
      const msg = err?.message || "Couldn't upload your avatar.";
      setError(msg);
      toast(msg, { type: "error" });
    } finally {
      busy(false);
      progress.hidden = true;
      progressBar.style.width = "0%";
    }
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    await handlePickedFile(file, (b) => {
      fileInput.disabled = b;
    });
    fileInput.value = ""; // allow re-picking the same file after success or error.
  });

  // Native capture/gallery button (TM-281) — only built on a Capacitor native platform. It opens the
  // OS picker (camera or photos), and routes the captured image through the SAME `handlePickedFile`
  // path. Cancel is a graceful no-op (captureAvatarImage resolves null); a permission denial throws a
  // friendly Error we surface inline + as a toast.
  let cameraBtn = null;
  if (native) {
    cameraBtn = el(
      "button",
      {
        id: "profile-avatar-camera",
        class: "tm-btn tm-btn-sm",
        type: "button",
        "aria-describedby": "profile-avatar-error profile-avatar-hint",
        onClick: async () => {
          setError("");
          cameraBtn.disabled = true;
          try {
            const file = await captureAvatarImage();
            if (!file) return; // user cancelled — leave the current avatar untouched.
            await handlePickedFile(file, (b) => {
              cameraBtn.disabled = b;
            });
          } catch (err) {
            const msg = err?.message || "Couldn't open the camera. Please try again.";
            setError(msg);
            toast(msg, { type: "error" });
          } finally {
            cameraBtn.disabled = false;
          }
        },
      },
      "Take or choose photo",
    );
  }

  refresh();

  const wrapper = el("section", { class: "tm-profile-avatar", "aria-label": "Avatar" }, [
    frame,
    el("div", { class: "tm-avatar-meta" }, [
      el("label", { class: "tm-field-label", for: "profile-avatar-file", text: "Avatar" }),
      fileInput,
      cameraBtn,
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

// A gear icon (paper-profile top bar). Decorative → aria-hidden; the link that wraps it carries the
// accessible label. Drawn with currentColor so it inks with the Paper foreground token.
function gearIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "tm-pf-gear-icon");
  svg.innerHTML =
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>';
  return svg;
}

/** A titled card matching the paper-profile card (border + offset shadow via tokens). */
function pfCard(title, children, extraClass = "") {
  return el("section", { class: `tm-pf-card ${extraClass}`.trim() }, [
    title ? el("h3", { class: "tm-pf-ctitle", text: title }) : null,
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

/** One paper-profile menu row: a label with a chevron. `to` = hash link; `onClick` = in-page action. */
function menuRow(label, { to = null, onClick = null, muted = false } = {}) {
  const chev = el("span", { class: "tm-pf-chev", "aria-hidden": "true", text: "›" });
  const cls = `tm-pf-menu-row${muted ? " tm-pf-menu-muted" : ""}`;
  if (to) return el("a", { class: cls, href: to }, [el("span", { text: label }), chev]);
  return el("button", { class: cls, type: "button", onClick }, [el("span", { text: label }), chev]);
}

/** Scroll a same-page element into view and focus it (Notifications / Privacy menu rows). */
function focusOnPage(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  if (typeof node.focus === "function") node.focus({ preventScroll: true });
}

/** Sign the user out (reused by the hub menu's "Sign out" row — same effect as the top-nav control). */
async function doSignOut() {
  try {
    await signOut();
  } catch (err) {
    toast(err?.message || "Couldn't sign out.", { type: "error" });
  }
}

// Build the Profile screen (view mode) — the paper-profile hub (identity + strength + interests +
// membership + menu) with the paper-edit-profile form inline. Kept on the single `#/profile` route
// (so the shipped self-service edit e2e, which expects #profile-form on #/profile, stays green) and
// rebuilt on each entry (matching the prior reload-on-entry lifecycle).
function buildShell(view) {
  const fields = new Map();
  const fieldNodes = FIELDS.map((field) => {
    const built = buildField(field);
    fields.set(field.key, { input: built.input, error: built.error });
    return built.wrapper;
  });

  // Account-state badges (TM-168): preserved, restyled into the hub just under the identity header;
  // populated by fillForm once /me loads.
  const badges = el("div", { class: "tm-profile-badges", id: "profile-badges" });
  // NB: must NOT be named `save` — that would shadow the module-level `save` submit handler, so the
  // form's `onSubmit: save` would bind this button element instead of the handler and the form would
  // do a native submit / page reload instead of PATCHing (TM-199).
  const saveBtn = el("button", { class: "tm-btn tm-btn-primary", type: "submit" }, "Save changes");
  const reset = el(
    "button",
    { class: "tm-btn", type: "button", onClick: () => { fillForm(state.profile); clearAllFieldErrors(); } },
    "Reset",
  );

  const avatar = buildAvatar();

  const form = el("form", { class: "tm-profile-form", id: "profile-form", novalidate: true, onSubmit: save }, [
    avatar.wrapper,
    el("div", { class: "tm-form-grid" }, fieldNodes),
    el("div", { class: "tm-form-actions" }, [saveBtn, reset]),
  ]);

  const status = el("div", { id: "profile-status" });

  // ── Identity header (paper-profile) ── avatar glyph + name + "City · age". Painted by paintHub().
  // The name/meta start BLANK (not the "Your profile" placeholder) so the pre-load render never shows
  // a concrete, misleading empty-profile identity for an established user (TM-663) — the CSS skeleton
  // (.tm-pf-loading) fills the gap until paintHub() lands the real values from /me. The 🙂 glyph is the
  // genuine no-avatar fallback (not a wrong value), and it's hidden behind the skeleton while loading.
  const hubInitial = el("span", { class: "tm-pf-avatar", "aria-hidden": "true", text: "🙂" });
  const hubName = el("div", { class: "tm-pf-name", text: "" });
  const hubMeta = el("div", { class: "tm-pf-sub", text: "" });
  // ── Account contact (TM-783) ── the email + phone this account is registered with, painted by
  // paintHub() from the same /me payload. Email is the account identity; phone shows the number or a
  // "No phone number added" prompt so the line is never silently blank.
  const hubEmail = el("div", { class: "tm-pf-contact-line", text: "" });
  const hubPhone = el("div", { class: "tm-pf-contact-line", text: "" });
  const hubContact = el("div", { class: "tm-pf-contact", "aria-label": "Account contact" }, [
    el("div", { class: "tm-pf-contact-row" }, [
      el("span", { class: "tm-pf-contact-ic", "aria-hidden": "true", text: "✉️" }),
      hubEmail,
    ]),
    el("div", { class: "tm-pf-contact-row" }, [
      el("span", { class: "tm-pf-contact-ic", "aria-hidden": "true", text: "📞" }),
      hubPhone,
    ]),
  ]);
  const idHeader = el("section", { class: "tm-pf-id", "aria-label": "You" }, [
    hubInitial,
    el("div", {}, [hubName, hubMeta, hubContact]),
  ]);

  // ── Profile strength (paper-profile) ── the restyled completeness prompt. Painted by paintHub().
  // The percentage starts BLANK (not "0% complete") so a loaded user never sees a misleading concrete
  // 0% for a heartbeat before /me resolves (TM-663) — the skeleton bar shows until paintHub() lands the
  // real strength; the bar fill starts at 0 width and the skeleton class overlays it while loading.
  const bar = el("i");
  const barPct = el("span", { text: "" });
  const barNudge = el("span", { class: "tm-pf-barnudge", text: "" });
  const strengthCard = pfCard("Profile strength", [
    el("div", { class: "tm-pf-bar" }, [bar]),
    el("div", { class: "tm-pf-barlbl" }, [barPct, barNudge]),
  ]);

  // ── Interests (paper-profile) ── no interests field exists on the backend yet (MeResponse has none),
  // so this matches the wireframe visually with an empty "add" affordance + an honest hint. Live
  // interest chips need a backend field — noted as a TM-514 follow-up.
  // reconcile with TM-511 component library (chip component)
  const interestsCard = pfCard("Interests", [
    el("div", { class: "tm-pf-chips" }, [
      el("span", { class: "tm-pf-chip tm-pf-chip-add", text: "＋ add" }),
    ]),
    el("p", { class: "tm-muted tm-pf-hint", text: "Add interests so people find you — coming soon." }),
  ]);

  // ── Membership (paper-profile) ── the tier row reflects the caller's REAL membership (TM-643): the
  // sub text is painted from GET /me/membership in load() via paintMembership() (through the pure
  // profileMembershipRow mapping) rather than a hardcoded "Pay as you go" — so a Monthly/Diamond
  // subscriber sees their actual tier. It starts on the free-base default and is corrected once the
  // membership resolves. "Manage" is a live link to the membership screen (#/membership) when the
  // membership feature flag is ON; while the flag is OFF that route is inert (router.js gates it), so
  // it stays a muted, non-interactive label rather than a dead link (the original wireframe affordance).
  const membershipSub = el("div", { class: "tm-pf-sub", text: profileMembershipRow(null).text });
  const membershipManage = membershipEnabled()
    ? el("a", { class: "tm-pf-go", href: MEMBERSHIP_ROUTE, text: "Manage →" })
    : el("span", { class: "tm-pf-go tm-muted", text: "Manage →" });
  const membershipCard = pfCard(
    null,
    [
      el("div", { class: "tm-pf-memb-main" }, [
        el("h3", { class: "tm-pf-ctitle", text: "Membership" }),
        membershipSub,
      ]),
      membershipManage,
    ],
    "tm-pf-memb",
  );

  // ── Edit profile (paper-edit-profile) ── the shipped self-service form, restyled into a kit card.
  const editCard = pfCard("Edit profile", [form], "tm-pf-edit");

  // Security + Appearance settings blocks (TM-282 / TM-529) — self-rendering. Appearance = the Paper
  // per-user controls (accent swatch + wavy/sketchy toggle), persisted server-side. Wrapped in a
  // labelled block the "Privacy & my data" menu row scrolls to.
  const security = buildSecuritySettings();
  const appearance = buildAppearanceSettings();
  const settingsBlock = el("section", { class: "tm-pf-settings", id: "profile-settings" }, [
    appearance,
    security,
    // QA diagnostics link (TM-297) — unobtrusive way into #/diagnostics (GPS / FCM token / plugins).
    el("p", { class: "tm-diag-link" }, [
      el("a", { class: "tm-btn tm-btn-sm", href: "#/diagnostics" }, "Diagnostics"),
    ]),
  ]);

  // ── Menu (paper-profile) ── the four wireframe rows plus an entry into the public-profile preview.
  // My events + Sign out are real actions; Notifications / Privacy scroll to the relevant on-page
  // control (no fabricated routes). Public profile → the additive #/profile/public preview.
  const menuCard = pfCard(
    null,
    [
      el("nav", { class: "tm-pf-menu", "aria-label": "Profile menu" }, [
        menuRow("My events", { to: "#/events" }),
        menuRow("Notifications", { onClick: () => focusOnPage("profile-notificationPref") }),
        menuRow("Public profile", { to: PROFILE_PUBLIC_ROUTE }),
        menuRow("Privacy & my data", { onClick: () => focusOnPage("profile-settings") }),
        menuRow("Sign out", { onClick: doSignOut, muted: true }),
      ]),
    ],
    "tm-pf-menu-card",
  );

  // The screen mounts with `tm-pf-loading` so the identity + strength area renders as a skeleton
  // (CSS shimmer, no concrete text) until the first /me paint. paintHub() removes the class when real
  // data lands; renderStatus() also removes it on a load error so the skeleton never hangs (TM-663).
  const root = el("div", { class: "tm-pf tm-pf-loading" }, [
    el("header", { class: "tm-pf-topbar" }, [
      // A host-badge doodle beside the heading (TM-215) — decorative; CSS shows it only when the sketchy toggle is on.
      el("h2", { class: "tm-pf-title" }, [doodle("host", { class: "tm-doodle-header", title: "Your profile" }), "Profile"]),
      el("a", { class: "tm-pf-gear", href: "#/diagnostics", "aria-label": "Diagnostics and settings" }, [gearIcon()]),
    ]),
    idHeader,
    badges,
    strengthCard,
    interestsCard,
    membershipCard,
    status,
    editCard,
    menuCard,
    settingsBlock,
  ]);
  clear(view).append(root);

  shell = {
    form,
    fields,
    save: saveBtn,
    reset,
    badges,
    status,
    avatar,
    root,
    hub: { name: hubName, meta: hubMeta, initial: hubInitial, email: hubEmail, phone: hubPhone, bar, barPct, barNudge },
    // The membership row's sub text (TM-643) — repainted from GET /me/membership by paintMembership().
    membership: { sub: membershipSub },
  };
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
    // Clear the hub skeleton so it never hangs when /me fails — the error card below carries the
    // retry, and the (blank) identity/strength placeholders are hidden rather than shimmering forever.
    shell.root?.classList.remove("tm-pf-loading");
    shell.form.hidden = true;
    shell.status.append(el("div", { class: "tm-error tm-empty" }, [
      // An empty-state doodle (TM-215) so a load failure still reads warmly; CSS shows it only under sketchy Paper.
      doodle("chat", { class: "tm-doodle-empty", title: "Couldn't load your profile" }),
      el("p", { text: state.error }),
      el("button", { class: "tm-btn", type: "button", onClick: load }, "Retry"),
    ]));
    return;
  }
  shell.form.hidden = false;
}

// ---- public-profile preview (paper-public-profile) ------------------------------------------

// The public-profile preview (#/profile/public) — "how other members see you". A real other-user
// endpoint (`GET /users/{id}`) doesn't exist yet, so this previews the caller's OWN public profile
// from /me (noted as a TM-514 follow-up). Its own lightweight shell (no edit form / no badges) mounted
// into the same #profile-view container; the Message / Block actions are inert in a self-preview.
let publicShell = null;

function buildPublicShell(view) {
  const avatar = el("span", { class: "tm-pf-avatar tm-pf-avatar-lg", "aria-hidden": "true", text: "🙂" });
  const name = el("h2", { class: "tm-pf-pub-name", text: "Your profile" });
  const meta = el("div", { class: "tm-pf-sub tm-pf-pub-meta", text: "" });

  // Interests placeholder — same backend gap as the hub (no interests field yet).
  // reconcile with TM-511 component library (chip component)
  const chips = el("div", { class: "tm-pf-chips tm-pf-pub-chips" }, [
    el("span", { class: "tm-pf-chip tm-pf-chip-add", text: "＋ interests" }),
  ]);

  const inCommon = el(
    "div",
    { class: "tm-pf-pub-note" },
    "This is how other members see your public profile.",
  );

  // Message / Block are disabled in a self-preview (you don't message or report yourself); they
  // become live once real other-user profiles land (with the users endpoint).
  const message = el("button", { class: "tm-btn tm-btn-primary tm-pf-pub-btn", type: "button", disabled: true }, "Message");
  const block = el("button", { class: "tm-btn tm-pf-pub-btn tm-pf-pub-ghost", type: "button", disabled: true }, "Block or report");

  const status = el("div", { id: "profile-status" });

  clear(view).append(
    el("div", { class: "tm-pf tm-pf-public" }, [
      el("header", { class: "tm-pf-topbar tm-pf-pub-top" }, [
        el("a", { class: "tm-pf-gear tm-pf-back", href: PROFILE_ROUTE_HASH, "aria-label": "Back to profile" }, "‹"),
        el("span", { class: "tm-pf-title tm-muted", text: "Public preview" }),
      ]),
      status,
      el("section", { class: "tm-pf-pub-body" }, [
        avatar,
        name,
        meta,
        chips,
        inCommon,
        message,
        block,
      ]),
    ]),
  );

  publicShell = { avatar, name, meta, status };
}

function fillPublic(profile) {
  if (!publicShell) return;
  const pub = publicSummary(profile);
  publicShell.name.textContent = pub.short;
  publicShell.meta.textContent = pub.metaLine || "Add your city to your profile";
  publicShell.avatar.textContent = pub.initial;
}

async function loadPublic() {
  if (!publicShell) return;
  clear(publicShell.status);
  publicShell.status.append(el("p", { class: "tm-muted", text: "Loading your profile…" }));
  try {
    const profile = await getMe();
    state.profile = profile;
    state.loaded = true;
    clear(publicShell.status);
    fillPublic(profile);
  } catch (err) {
    clear(publicShell.status);
    publicShell.status.append(el("div", { class: "tm-error tm-empty" }, [
      el("p", { text: "Could not load your profile." }),
      el("button", { class: "tm-btn", type: "button", onClick: loadPublic }, "Retry"),
    ]));
    console.warn("[profile] public preview GET /api/v1/me failed:", err?.message ?? err);
  }
}

// ---- mount ----------------------------------------------------------------------------------

const PROFILE_ROUTE_HASH = "#/profile";

/**
 * Called by the router when a Profile route becomes active. Builds the layout for the requested mode
 * (the hub + edit form for #/profile, or the public-profile preview for #/profile/public) and loads
 * /me. Rebuilt on each entry (matching the prior reload-on-entry lifecycle); the router only re-enters
 * when the profile sub-route actually changes, so a repeated guard() for the same route doesn't refetch.
 *
 * @param {string} [hash] the active hash route (defaults to the live location hash)
 */
export function enterProfile(hash) {
  const view = $("profile-view");
  if (!view) return;
  const active = typeof hash === "string" ? hash : (typeof window !== "undefined" ? window.location.hash : "");
  if (profileMode(active) === "public") {
    buildPublicShell(view);
    loadPublic();
  } else {
    buildShell(view);
    load();
  }
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmProfile = { enterProfile };
}
