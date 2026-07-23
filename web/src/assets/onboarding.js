// First-login "complete your profile" gate (TM-250) — the #/onboarding view. A new passwordless
// user lands here (routed by the guard in router.js) and CANNOT enter the app until they supply the
// four required minimum fields — Name, Location, Age, and (since TM-880) a valid Phone — which post
// atomically to POST /api/v1/me/onboarding. On success the backend marks onboarding complete and the
// gate lifts; the guard then sends the user on to where they were headed (home, or a deep-linked
// route). TM-880 also routes EXISTING phone-less accounts back through this same gate (the router's
// needsPhoneNumber check), so there is exactly one completion gate, not a second inconsistent one.
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
  POPULAR_LABEL,
  groupCatalogue,
  selectionBounds,
  validateSelection,
  canFinish,
  selectionPillState,
  chipDisabled,
  toInterestsPayload,
  selectedLabelsFromMe,
} from "./onboarding-core.js";
import { interestEmoji } from "./interests-core.js";
// TM-880: the gate now also collects a REQUIRED phone as a (country picker, national number) pair —
// the same TM-781 machinery the edit-profile form uses (one rule set, no second inconsistent gate).
// TM-898 adds the profile form's other two input rules to the gate for the same reason: the TM-877
// allowed-city list (CITY_OPTIONS + cityChoiceError — location is now the same dropdown, not free
// text) and the TM-771 name-like check (nameFormatError) on the captured name.
import {
  splitE164,
  composeE164,
  canonicalE164,
  defaultCountryFor,
  phonePartsError,
  CITY_OPTIONS,
  cityChoiceError,
  nameFormatError,
} from "./profile-core.js";
import { COUNTRIES, flagOf } from "./countries.js";
// TM-930: the gate phone becomes a Firebase phone VERIFY-AND-LINK step. The user proves ownership of
// the number (OTP) and the credential is linked to their signed-in Firebase account, so one verified
// number maps to exactly one account (strict 1:1 comes free from Firebase). Reuses the TM-867 six-box
// OTP widget + the TM-866 resend-cooldown machinery, exactly as login.js's SMS flow does.
import { currentUser, startPhoneVerify, confirmPhoneLink } from "./auth.js";
import { attachOtpInput } from "./otp-input.js";
import { attachResendCooldown } from "./resend-cooldown.js";
import { SUPPORT_EMAIL } from "./help.js";
// TM-1009: the deploy-time switch over the whole verified-phone requirement
// (config.flags.requireVerifiedPhone, shipped OFF). With the flag OFF this gate reverts to the
// pre-TM-930 collect-only phone step: the Send-code/OTP verify controls are never built, prefill
// never paints the verified/locked state, and validateAll's must-verify block (phoneVerifyBlocksSubmit)
// never fires — a shape-valid number submits without an OTP. Flag ON = TM-930 behaviour, unchanged.
import { verifiedPhoneRequired, phoneVerifyBlocksSubmit } from "./verified-phone-flag.js";

// The four required fields and their client-side rules, mirroring the backend OnboardingRequest
// bean validation (name non-blank ≤255 + name-like TM-771/TM-898; location from the TM-877 allowed
// city list TM-898; age 18–99 TM-884; phone required E.164 TM-880) so we reject bad input before
// any round-trip AND match exactly what the server will accept. The
// `field` key is the request property; `meKey` is where the current value lives on a MeResponse (so
// a half-completed gate — or an existing phone-less account routed back through it — pre-fills).
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
    // TM-898: location is the SAME allowed-cities dropdown as the profile edit form's city field
    // (TM-877) — it was free text here, so the gate could persist an off-list city the profile form
    // refuses. The leading blank option keeps "not chosen yet" honest (every gate field is
    // required, so blank simply fails validation); a returning account's saved OFF-LIST city is
    // injected as an extra option by prefill (the fillCitySelect pattern), matching the backend
    // gate's saved-value allowance, so a pre-list profile can still re-submit its own value.
    field: "location",
    meKey: "city",
    label: "Location",
    type: "select",
    options: [["", "Choose a city…"], ...CITY_OPTIONS.map((c) => [c, c])],
    hint: "Pick the city closest to you.",
  },
  {
    field: "age",
    meKey: "age",
    label: "Age",
    type: "number",
    // TM-884: the platform age band is 18–99 (was 13–120), mirroring the backend @Min/@Max.
    min: 18,
    max: 99,
    autocomplete: "off",
    hint: "Between 18 and 99.",
  },
  {
    // TM-880: phone is MANDATORY (email stays optional — it's the Firebase identity, not a form
    // field). The input holds only the NATIONAL number; the +dial comes from the country picker
    // rendered beside it (TM-781 pair), so storage is always unambiguous E.164.
    field: "phone",
    meKey: "phone",
    label: "Phone",
    type: "tel",
    maxLength: 32,
    autocomplete: "tel-national",
    hint: "Pick a country, then your national number.",
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
let interestsShell = null; // { finishBtn, error, chips, pill, pillLabel, pillEmpty, pillFilled } once built

const $ = (id) => document.getElementById(id);

// ---- phone VERIFY-AND-LINK step (TM-930) ----------------------------------------------------
// The gate phone is no longer a free-text field you just type + submit: the user must PROVE they own
// the number via a Firebase phone OTP, and the verified credential is LINKED to their signed-in
// account (auth.js startPhoneVerify → confirmPhoneLink). Only a VERIFIED phone passes the gate UI
// (client-side rule — the backend still accepts unverified phones until TM-931/B). This holds the
// verify sub-state + its DOM handles for the single phone field; `phone` is the only field with a
// verify step, so a single module-level controller (not a per-field map) is enough.
const phoneVerify = {
  built: false, // the verify controls (send button, OTP group, recaptcha) have been built + wired
  verified: false, // the currently-composed E.164 has been proven owned + linked
  verifiedE164: "", // the exact E.164 that was verified (guards a silent picker/input edit)
  verificationId: null, // the in-flight Firebase verificationId between send and confirm
  pendingE164: "", // the exact E.164 the in-flight verificationId was ISSUED for (TM-930 bypass fix)
  sending: false, // a send/verify request is in flight (single-flight guard)
  otp: null, // the attachOtpInput controller over the six boxes
  cooldown: null, // the attachResendCooldown controller over the resend link
  // DOM nodes (built in buildPhoneVerify):
  sendBtn: null,
  otpGroup: null, // the role="group" container holding the six boxes
  otpWrap: null, // the reveal-on-send wrapper (label + boxes + resend), hidden until a send
  statusEl: null, // the "Verified ✓" / helper line
  changeBtn: null, // the "Change number" affordance shown only in the verified/locked state (TM-930)
  adoptBtn: null, // the "Use my verified number" one-tap shown only in the TM-932 mismatch case
  recoveryEl: null, // the "this is my number → contact support" affordance shown only on a collision (TM-987)
  recaptcha: null, // the gate-local invisible reCAPTCHA host
};

// TM-987 cross-account collision recovery. When the retroactive re-gate (TM-992) hard-blocks a
// genuinely-owned number that's already registered on ANOTHER (historical) account, verifying collides
// at Firebase (auth/credential-already-in-use) and there is NO in-app merge yet — so we must not leave
// the user stuck. We surface a "this is my number → contact support" affordance whose mailto opens the
// TM-987 support runbook path (Firebase unlink/merge). The support address is help.js's SUPPORT_EMAIL,
// imported so there is ONE definition (TM-1019 — was a hardcoded copy that could drift).
// EVENTUAL in-app fix: TM-306(b) claim-transfer ("link with proof of both") extended to the retroactive
// collision would replace this manual escape hatch — until then this link is the recovery path TM-992's
// re-gate requires (see TM-987 / the TM-992 scope comment pulled from it).
const RECOVERY_SUBJECT = "Phone number stuck on another account";

/** Human copy for the phone error line, mapping the Firebase auth error codes we care about (TM-930). */
function phoneVerifyErrorCopy(err) {
  const code = err?.code;
  // Collision is the HARD BLOCK — exact copy locked by the product owner.
  if (code === "auth/credential-already-in-use" || code === "auth/account-exists-with-different-credential") {
    return "This number is already registered — sign into that account.";
  }
  if (code === "auth/invalid-verification-code") return "That code isn't right — check the SMS and try again.";
  if (code === "auth/code-expired") return "That code expired — send a new one.";
  if (code === "auth/too-many-requests") return "Too many attempts — please wait a moment and try again.";
  if (code === "auth/invalid-phone-number") return phonePartsError("", "");
  return "Couldn't verify that number. Please try again.";
}

/** The E.164 currently composed from the phone (picker, national input) pair, or "" if incomplete. */
function composedPhoneE164() {
  const entry = shell?.fields.get("phone");
  if (!entry) return "";
  const national = (entry.input.value ?? "").trim();
  const iso2 = entry.country ? entry.country.value : "";
  if (!iso2 || national === "") return "";
  return composeE164(iso2, national);
}

/** Is the phone step satisfied for gate submission? True only once the composed number is verified. */
function phoneIsVerified() {
  return phoneVerify.verified && phoneVerify.verifiedE164 === composedPhoneE164();
}

/** Lock the picker + national input and paint the "Verified ✓" state (TM-930). */
function markPhoneVerified(e164) {
  const entry = shell?.fields.get("phone");
  if (!entry) return;
  phoneVerify.verified = true;
  phoneVerify.verifiedE164 = e164;
  phoneVerify.verificationId = null;
  phoneVerify.pendingE164 = "";
  // The verified lock on the national input is `readOnly` (still focusable/submittable), NOT `disabled`.
  // Clear any `disabled` left over from the in-flight `setPhoneControlsBusy(true)` (which fires while the
  // number is still unverified) — otherwise the input stays `disabled` after verify, and the later
  // `setPhoneControlsBusy(false)` skips re-enabling it (its guard only runs while unverified), so the
  // "Change number" un-lock can't re-open a still-`disabled` field (TM-930).
  entry.input.disabled = false;
  entry.input.readOnly = true;
  entry.input.classList.add("tm-field-locked");
  if (entry.country) entry.country.disabled = true;
  setFieldError("phone", "");
  if (phoneVerify.sendBtn) phoneVerify.sendBtn.hidden = true;
  if (phoneVerify.otpWrap) phoneVerify.otpWrap.hidden = true;
  phoneVerify.otp?.clear();
  phoneVerify.cooldown?.reset();
  if (phoneVerify.statusEl) {
    phoneVerify.statusEl.hidden = false;
    phoneVerify.statusEl.classList.add("tm-phone-verified");
    phoneVerify.statusEl.textContent = "Verified ✓";
  }
  // TM-930: reveal the "Change number" affordance — the ONLY way out of the locked/verified state
  // (the input is readOnly + the picker disabled + Send hidden, so neither the input nor the change
  // listeners can fire to unlock it). Clicking it returns to the editable, unverified state.
  if (phoneVerify.changeBtn) phoneVerify.changeBtn.hidden = false;
  // TM-932: once verified, the "Use my verified number" adopt shortcut is moot — hide it.
  if (phoneVerify.adoptBtn) phoneVerify.adoptBtn.hidden = true;
  // TM-987: verified → any prior collision is resolved — retract the recovery affordance.
  setPhoneRecoveryVisible(false);
}

/**
 * Is a verification currently in flight (a code was sent but not yet confirmed)? True in the window
 * between "Send code" and a successful/failed confirm. Editing the number in this window must drop the
 * stale in-flight code (it was issued for the OLD digits), so the listeners reset on this too — not just
 * on the fully-verified state (TM-930 bypass fix).
 */
function phoneVerifyInFlight() {
  return phoneVerify.verificationId != null || phoneVerify.pendingE164 !== "";
}

/**
 * Return the phone field to the UNVERIFIED state (TM-930) — the user edited a verified number, or a
 * confirm failed. Unlocks the pair, hides the OTP boxes, and clears the "Verified ✓" badge so the
 * user must re-send + re-confirm. Idempotent.
 */
function unverifyPhone() {
  const entry = shell?.fields.get("phone");
  phoneVerify.verified = false;
  phoneVerify.verifiedE164 = "";
  phoneVerify.verificationId = null;
  phoneVerify.pendingE164 = "";
  if (entry) {
    // Clear BOTH lock forms: `readOnly` (the verified lock) AND `disabled` (a leftover from an in-flight
    // `setPhoneControlsBusy(true)`), so the field is genuinely editable again — otherwise the
    // "Change number" click re-opens a field the browser still refuses to fill (TM-930).
    entry.input.disabled = false;
    entry.input.readOnly = false;
    entry.input.classList.remove("tm-field-locked");
    if (entry.country) entry.country.disabled = false;
  }
  if (phoneVerify.sendBtn) phoneVerify.sendBtn.hidden = false;
  if (phoneVerify.otpWrap) phoneVerify.otpWrap.hidden = true;
  phoneVerify.otp?.clear();
  phoneVerify.cooldown?.reset();
  if (phoneVerify.statusEl) {
    phoneVerify.statusEl.hidden = true;
    phoneVerify.statusEl.classList.remove("tm-phone-verified");
    phoneVerify.statusEl.textContent = "";
  }
  // TM-930: the "Change number" affordance only makes sense in the verified/locked state — hide it here.
  if (phoneVerify.changeBtn) phoneVerify.changeBtn.hidden = true;
  // TM-932: the adopt shortcut is re-offered by prefillPhone/maybeOfferAdoptVerified only when a
  // mismatched verified phone is linked — a plain edit-driven un-verify hides it (a user editing the
  // number toward a fresh OTP isn't in the adopt-the-linked-number flow).
  if (phoneVerify.adoptBtn) phoneVerify.adoptBtn.hidden = true;
  // TM-987: editing/re-sending is a fresh attempt (likely a DIFFERENT number) — retract the collision
  // recovery affordance so it only ever shows against the number that actually collided.
  setPhoneRecoveryVisible(false);
}

/**
 * Confirm the OTP (auto-submit from the six-box widget) → link the credential to the signed-in
 * account → PATCH /me { phone } so the verified value survives even if the user abandons the rest of
 * the gate. Collision (auth/credential-already-in-use) is the hard block: the boxes clear, the exact
 * copy paints, and the gate stays unverified. Single-flight via phoneVerify.sending.
 */
async function confirmPhoneOtp(code) {
  if (phoneVerify.sending) return; // a confirm is already running — drop the re-entrant call
  if (!phoneVerify.verificationId) return; // no in-flight verification (shouldn't happen)
  // TM-930 bypass fix: the OTP proves ownership of the number the verificationId was ISSUED for
  // (phoneVerify.pendingE164) — NOT whatever the (editable) input reads now. If the user edited the
  // national number or country picker AFTER "Send code" but before confirming, the composed value has
  // drifted away from the number Firebase actually linked; marking that drifted value verified would
  // let an UNVERIFIED number pass the gate. Guard on the drift and force a fresh send instead.
  const pending = phoneVerify.pendingE164;
  if (!pending) return; // no number on record for this verificationId (shouldn't happen)
  if (composedPhoneE164() !== pending) {
    // The pair changed since the code was sent — the in-flight code is for the OLD number. Drop this
    // stale verification and make the user re-send for the number now on screen.
    unverifyPhone();
    setFieldError("phone", "The number changed — tap Send code to verify it.");
    return;
  }
  phoneVerify.sending = true;
  setPhoneControlsBusy(true);
  setFieldError("phone", "");
  try {
    await confirmPhoneLink(phoneVerify.verificationId, code);
    // Linked. Persist immediately so an abandoned gate still has the verified phone on record. Mark the
    // number the code was ISSUED for (pending) — the guard above proved the input still matches it.
    markPhoneVerified(pending);
    try {
      await updateMe({ phone: pending });
    } catch (patchErr) {
      // The link succeeded (the number is theirs); a failed PATCH is non-fatal — collectBody's
      // atomic POST /me/onboarding still carries the same verified value on submit. Log only.
      console.warn("[onboarding] PATCH /me {phone} after link failed (non-fatal):", patchErr?.message ?? patchErr);
    }
  } catch (err) {
    // A failed confirm keeps the number UNVERIFIED. Clear the boxes (the widget auto-submits on any
    // input that leaves all six filled, so a stale full set would resubmit on the first keystroke)
    // and paint the mapped error. Collision paints the hard-block copy.
    phoneVerify.otp?.clear();
    setFieldError("phone", phoneVerifyErrorCopy(err));
    // TM-987: a cross-account collision hard-block ("already registered") is a dead end without a merge
    // path — reveal the contact-support recovery affordance so a user whose genuinely-owned number is
    // stuck on another historical account has a way forward (the TM-987 runbook; TM-306(b) claim-transfer
    // is the eventual in-app fix). Any OTHER error (bad/expired code, rate limit) hides it — those are
    // retryable on this same account and don't need the support path.
    setPhoneRecoveryVisible(isPhoneCollision(err));
    phoneVerify.otp?.focus();
  } finally {
    phoneVerify.sending = false;
    setPhoneControlsBusy(false);
  }
}

/** Disable/enable the phone verify controls while a send/confirm is in flight. */
function setPhoneControlsBusy(busy) {
  const entry = shell?.fields.get("phone");
  if (phoneVerify.sendBtn) phoneVerify.sendBtn.disabled = busy;
  for (const box of phoneVerify.otp?.boxes ?? []) box.disabled = busy;
  // Don't fight the verified lock: only toggle the pair's enabled-ness while UNverified.
  if (entry && !phoneVerify.verified) {
    entry.input.disabled = busy;
    if (entry.country) entry.country.disabled = busy;
  }
  phoneVerify.cooldown?.syncDisabled();
}

/**
 * "Send code" (or resend): validate the (picker, national) pair, compose E.164, then either
 * SHORT-CIRCUIT (the composed number already equals the signed-in account's linked phone — it is
 * already verified, e.g. a re-gated SMS-sign-in user) or fire startPhoneVerify and reveal the OTP.
 */
async function sendPhoneCode() {
  if (phoneVerify.sending) return;
  const entry = shell?.fields.get("phone");
  if (!entry) return;
  // Same pure rule set as gate submit — reject a blank/unconfirmed/too-short pair before any send.
  const partsError = validateField(FIELDS.find((f) => f.field === "phone"), entry.input.value);
  if (partsError) {
    setFieldError("phone", partsError);
    return;
  }
  const e164 = composedPhoneE164();
  setFieldError("phone", "");

  // SHORT-CIRCUIT: the entered number already IS this account's verified Firebase phone — no OTP.
  if (e164 && currentUser()?.phoneNumber === e164) {
    markPhoneVerified(e164);
    return;
  }

  phoneVerify.sending = true;
  setPhoneControlsBusy(true);
  try {
    phoneVerify.verificationId = await startPhoneVerify(e164, phoneVerify.recaptcha);
    // TM-930 bypass fix: remember the EXACT E.164 this verificationId was issued for, so confirmPhoneOtp
    // marks THIS number verified (and detects a mid-flow input/picker edit) rather than re-composing from
    // the still-editable inputs.
    phoneVerify.pendingE164 = e164;
    // Reveal the six-box OTP; the widget auto-submits through confirmPhoneOtp on the sixth digit.
    if (phoneVerify.otpWrap) phoneVerify.otpWrap.hidden = false;
    phoneVerify.otp?.clear();
    phoneVerify.otp?.focus();
    phoneVerify.cooldown?.start(); // a texted code opens the resend window (TM-866 twin)
  } catch (err) {
    setFieldError("phone", phoneVerifyErrorCopy(err));
  } finally {
    phoneVerify.sending = false;
    setPhoneControlsBusy(false);
  }
}

/**
 * TM-932 mismatch case: the account already has a DIFFERENT verified Firebase phone linked than the
 * one stored on /me. Reveal a one-tap "Use my verified number (…)" affordance so the user can adopt
 * the number Firebase already proved they own, WITHOUT re-OTPing it (they'd still be free to verify
 * the stored number instead via the normal Send-code path). No-op when there's no linked phone (the
 * common retroactive case — nothing to adopt, the user just verifies the stored number) or when the
 * linked phone canonically equals the stored one (that path already went straight to verified).
 *
 * @param {string} verifiedE164 the account's linked Firebase phone (currentUser().phoneNumber), or "".
 * @param {string} storedE164 the stored /me phone (used only to skip when it already matches).
 */
function maybeOfferAdoptVerified(verifiedE164, storedE164) {
  if (!phoneVerify.adoptBtn) return;
  const verifiedCanonical = canonicalE164(verifiedE164);
  // Nothing linked, or the linked number already equals the stored one → no adopt shortcut.
  if (!verifiedCanonical || verifiedCanonical === canonicalE164(storedE164)) {
    phoneVerify.adoptBtn.hidden = true;
    return;
  }
  // A different verified number is on the account — offer to adopt it in one tap.
  phoneVerify.adoptBtn.textContent = `Use my verified number (${verifiedCanonical})`;
  phoneVerify.adoptBtn.hidden = false;
  setFieldError(
    "phone",
    "This number isn't verified yet. Verify it below, or use the number already verified on your account.",
  );
}

/**
 * Adopt the account's already-verified Firebase phone (TM-932 mismatch one-tap): the number is ALREADY
 * linked + proven, so no OTP is needed — we just PATCH /me { phone: <verified> } so the stored value
 * matches the verified one, mirror it into the picker/national inputs, and paint the verified/locked
 * state. The gate can then submit (or the router re-guard clears it) with no manual reload.
 */
async function adoptVerifiedPhone() {
  if (phoneVerify.sending) return;
  const verified = currentUser()?.phoneNumber ?? "";
  const parsed = splitE164(verified);
  if (!parsed) return; // defensive: nothing to adopt (button should have been hidden)
  const entry = shell?.fields.get("phone");
  phoneVerify.sending = true;
  setPhoneControlsBusy(true);
  if (phoneVerify.adoptBtn) phoneVerify.adoptBtn.disabled = true;
  setFieldError("phone", "");
  try {
    // Persist the verified number as the stored phone (no OTP — it's already Firebase-verified). This
    // is the "adopt" half of the mismatch offer; updateProfile applies the changed value like any PATCH.
    await updateMe({ phone: verified });
    // Reflect it in the pair, then land in the verified/locked state so the gate is satisfied.
    if (entry?.country) entry.country.value = parsed.iso2;
    if (entry) entry.input.value = parsed.national;
    markPhoneVerified(verified);
  } catch (err) {
    setFieldError("phone", "Couldn't use your verified number. Please try again, or verify below.");
    console.warn("[onboarding] adopt-verified PATCH /me failed:", err?.message ?? err);
  } finally {
    phoneVerify.sending = false;
    setPhoneControlsBusy(false);
    if (phoneVerify.adoptBtn) phoneVerify.adoptBtn.disabled = false;
  }
}

// ---- client-side validation -----------------------------------------------------------------

/** Validate one field's raw value against its rules. Returns an error message, or "" if valid. */
function validateField(field, raw) {
  const value = (raw ?? "").trim();
  // ALL fields are REQUIRED here (unlike the partial edit-profile form, where blank = "leave alone").
  if (value === "") return `${field.label} is required.`;
  if (field.field === "phone") {
    // TM-880: the (country picker, national number) pair — the same pure TM-781 rule set the edit
    // form runs (phonePartsError: confirm-country gate, digit floor/ceiling), so the two surfaces
    // can never disagree on what a valid phone is.
    const country = shell?.fields.get("phone")?.country;
    return phonePartsError(country ? country.value : "", value);
  }
  if (field.type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return "Enter a whole number.";
    if (field.min != null && n < field.min) return `Must be ${field.min} or more.`;
    if (field.max != null && n > field.max) return `Must be ${field.max} or less.`;
    return "";
  }
  if (field.field === "location") {
    // TM-898: the gate mirrors the profile form's TM-877 dropdown rule — the choice must come from
    // the allowed list, with the caller's already-saved (possibly off-list) city still allowed;
    // that saved value is exactly the extra option prefill's fillCitySelect injects.
    return cityChoiceError(value, state.me?.city);
  }
  if (field.maxLength != null && value.length > field.maxLength) {
    return `Must be ${field.maxLength} characters or fewer.`;
  }
  if (field.field === "name") {
    // TM-898: the captured name seeds firstName/lastName server-side (TM-883), so it carries the
    // same TM-771 name-like rule as the edit form's name fields — mirroring the backend
    // OnboardingRequest pattern so client-valid input can't 400 server-side.
    return nameFormatError(value);
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
  // TM-930: the gate cannot be submitted with an UNVERIFIED phone (client-side rule — the backend
  // still accepts unverified phones until B). A shape-valid but not-yet-verified pair paints the
  // "verify your number" prompt on the phone field. This runs only when the pair itself is valid, so
  // a blank/too-short number surfaces its own error first (not the verify prompt on top of it).
  // TM-1009: the whole must-verify requirement is behind config.flags.requireVerifiedPhone (shipped
  // OFF) — with the flag OFF phoneVerifyBlocksSubmit never blocks, so the gate is collect-only.
  if (ok && phoneVerifyBlocksSubmit(verifiedPhoneRequired(), phoneIsVerified())) {
    setFieldError("phone", "Verify your number to continue — tap Send code.");
    ok = false;
  }
  return ok;
}

// ---- data -----------------------------------------------------------------------------------

/** Pre-fill the inputs from a MeResponse — a returning, half-completed user keeps what they had. */
function prefill(profile) {
  for (const field of FIELDS) {
    const entry = shell.fields.get(field.field);
    if (field.field === "phone") {
      prefillPhone(entry, profile);
      continue;
    }
    const value = profile?.[field.meKey];
    if (field.field === "location") {
      // TM-898: the location dropdown needs the fillCitySelect treatment (off-list injection), not
      // a plain value assignment — an unknown value on a <select> silently selects nothing.
      fillCitySelect(entry.input, value);
      continue;
    }
    entry.input.value = value == null ? "" : String(value);
  }
}

/**
 * Select the saved city in the gate's TM-877 dropdown — the same fillCitySelect pattern as the
 * profile edit form (profile.js): a saved value on the allowed list (or "") selects directly, while
 * a saved OFF-LIST city (e.g. "Dubai", stored before the list existed) gets its own extra option
 * injected so it stays visible and re-submittable. The backend gate carries the matching saved-value
 * allowance (TM-898), so an existing pre-list profile passing back through the gate (TM-880 re-gates
 * phone-less accounts here) is never invalidated. The `data-offlist` marker keeps repeat prefills
 * from stacking duplicate options for the same value; trimming matches the server's trimmed
 * comparison (TM-900), so a legacy padded stored value round-trips too.
 *
 * @param {HTMLSelectElement} select the location <select>.
 * @param {*} value the stored `me.city`.
 */
function fillCitySelect(select, value) {
  const saved = value == null ? "" : String(value).trim();
  if (saved !== "" && !CITY_OPTIONS.includes(saved) && select.getAttribute("data-offlist") !== saved) {
    select.append(el("option", { value: saved, text: saved }));
    select.setAttribute("data-offlist", saved);
  }
  select.value = saved;
}

/**
 * Pre-fill the phone (country picker, national input) pair from the stored value (TM-880), the
 * same three states fillPhoneField handles on the edit form (TM-781):
 *   • saved E.164 — split back into picker + national (an already-phoned account passing through);
 *   • legacy bare number — the explicit confirm-country state: picker moves to the disabled
 *     placeholder, the prompt paints, and submit is blocked until a country is picked;
 *   • no phone — soft-default the picker from the profile city (else GB), unless the user already
 *     picked a country themselves this session.
 *
 * TM-932 (retroactive re-gate): an EXISTING account whose stored phone was never OTP-verified now
 * lands HERE, with the stored number pre-filled into the verify step, so a single OTP proves it. When
 * the account already has a DIFFERENT verified phone linked (the mismatch case — e.g. verified one
 * number, stored another), we ALSO offer a one-tap "adopt the verified number" affordance so the user
 * needn't re-OTP a number Firebase already proved they own (see maybeOfferAdoptVerified).
 */
function prefillPhone(entry, profile) {
  // TM-930: a fresh mount starts UNVERIFIED (unlocks the pair, hides any stale OTP) before we decide
  // the prefill state — a re-entered gate must not inherit the previous session's verified lock.
  unverifyPhone();
  const saved = profile?.phone == null ? "" : String(profile.phone).trim();
  if (!entry.country) {
    entry.input.value = saved; // defensive: no picker built (shouldn't happen)
    return;
  }
  const parsed = splitE164(saved);
  if (parsed) {
    entry.country.value = parsed.iso2;
    entry.input.value = parsed.national;
    setFieldError("phone", "");
    // TM-930/TM-932: a saved E.164 that already IS the signed-in account's linked Firebase phone is
    // proven — land straight in the verified/locked state (no OTP). This is the re-gated SMS-sign-in
    // user, or a returning account whose stored phone matches its verified Firebase number. Compare
    // CANONICAL forms (not raw strings) so a formatted stored value ("+44 7700 900123") still matches
    // Firebase's strict E.164 ("+447700900123") — the same canonicalisation the router's re-gate uses,
    // so the gate never shows "unverified" for a number the router considers already verified (TM-932).
    // TM-1009: the verified/locked prefill state only exists while the verified-phone requirement is
    // ON. With the flag OFF the pair stays plainly editable (collect-only) — no lock, no adopt offer.
    if (verifiedPhoneRequired()) {
      const verified = currentUser()?.phoneNumber ?? "";
      if (canonicalE164(saved) && canonicalE164(saved) === canonicalE164(verified)) {
        markPhoneVerified(saved);
      } else {
        // Retroactive re-gate: the stored number is NOT this account's verified number. Offer the one-tap
        // "adopt my verified number" path when a DIFFERENT verified phone is linked (the mismatch case);
        // otherwise (no linked phone — the common retroactive case) the user just verifies the stored one.
        maybeOfferAdoptVerified(verified, saved);
      }
    }
  } else if (saved !== "") {
    entry.country.value = ""; // the disabled placeholder — the explicit confirm-country state
    entry.input.value = saved;
    setFieldError("phone", phonePartsError("", saved));
  } else {
    entry.input.value = "";
    if (!entry.country.getAttribute("data-user-picked")) {
      entry.country.value = defaultCountryFor({ phone: "", city: profile?.city });
    }
  }
}

/** Build the request body: trimmed name/location, age coerced to a number, phone composed to E.164. */
function collectBody() {
  const get = (k) => (shell.fields.get(k).input.value ?? "").trim();
  // TM-880: storage is E.164, composed from the picker + national input — same as the edit form's
  // collectPatch. validateAll has already blocked a blank/unconfirmed pair before this runs.
  const phoneEntry = shell.fields.get("phone");
  const phone = composeE164(phoneEntry.country ? phoneEntry.country.value : "", get("phone"));
  return { name: get("name"), location: get("location"), age: Number(get("age")), phone };
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
  // submit; selected chips always stay toggleable OFF so the user can swap a pick. The predicate is the
  // pure chipDisabled() in onboarding-core (unit-tested there) so the rule stays DOM-free and covered.
  const disabled = chipDisabled(on, state.selected, state.bounds);
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

/**
 * Repaint the selection pill (paper "Pick interests"): below the minimum it's a grey outline reading
 * "Pick at least N to continue" with a hollow ring; at/above the minimum it flips to the accent-light
 * fill reading "N selected" with a ✓. Driven off the live selection + effective min so it always
 * agrees with the Continue button's enabled state.
 */
function refreshSelectionPill() {
  if (!interestsShell?.pill) return;
  const { pill, pillLabel, pillEmpty, pillFilled } = interestsShell;
  // The satisfied flag + the exact copy come from the pure selectionPillState() in onboarding-core
  // (unit-tested there); this function only maps that decision onto classes/icons/text — no copy logic.
  const { satisfied, label } = selectionPillState(state.selected, state.bounds);
  pill.classList.toggle("tm-interests-pill-on", satisfied);
  // Swap the leading icon (hollow ring below the min → ✓ once satisfied) without innerHTML.
  pillEmpty.hidden = satisfied;
  pillFilled.hidden = !satisfied;
  pillLabel.textContent = label;
}

/** Update the selection pill + the "Continue" CTA enabled state from the live selection. */
function refreshInterestsControls() {
  if (!interestsShell) return;
  refreshSelectionPill();
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

/** The small ✓ check that appears at the right end of a SELECTED chip (paper "Pick interests").
 * Always in the DOM (a trailing span) but hidden by CSS until the chip carries .tm-pf-chip-on, so a
 * toggle is a pure class change — no add/remove-child churn, and the tick inks with --on-accent. */
function chipCheck() {
  return el("span", { class: "tm-interests-chip-check", "aria-hidden": "true" }, [
    svg(
      "svg",
      { viewBox: "0 0 24 24", width: 15, height: 15, fill: "none", stroke: "currentColor",
        "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" },
      [svg("path", { d: "M5 13l4 4L19 7" })],
    ),
  ]);
}

/** One toggle chip for a catalogue row — a real <button> so keyboard + aria-pressed work. The chip
 * carries its label text plus a trailing ✓ (revealed only when selected, paper "Pick interests"). */
function buildChip(row) {
  // Leading catalogue emoji (TM-805), rendered ONLY when the row carries one (interestEmoji → "" when
  // absent), so a glyph-less row degrades to a label-only chip. aria-hidden + the label carries the
  // accessible name, so the emoji is purely decorative to screen readers.
  const emoji = interestEmoji(row);
  const button = el("button", {
    type: "button",
    class: "tm-pf-chip tm-interests-chip",
    "aria-pressed": "false",
    "data-label": row.label,
    onClick: () => toggleInterest(row.label),
  }, [
    emoji ? el("span", { class: "tm-interests-chip-emoji", "aria-hidden": "true", text: emoji }) : null,
    el("span", { class: "tm-interests-chip-label", text: row.label }),
    chipCheck(),
  ]);
  return button;
}

// The synthetic Popular group is rendered under the design's "POPULAR NEAR YOU" section label
// (the core keys the group as POPULAR_LABEL="Popular"; we only relabel it here for display).
const POPULAR_SECTION_LABEL = "Popular near you";

/** Build one group section: an uppercase muted section label + a wrap of toggle chips. */
function buildGroupSection(group, chips) {
  const heading = el("h3", {
    class: "tm-interests-group-head",
    text: group.category === POPULAR_LABEL ? POPULAR_SECTION_LABEL : group.category,
  });
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

/** The selection pill (paper "Pick interests") — a rounded, 2px-bordered pill under the subtitle that
 * reflects progress toward the minimum. Returns the pill node plus handles for {@link refreshSelectionPill}
 * to repaint it (the two leading icons + the label). Starts in the empty (below-min) state. */
function buildSelectionPill() {
  // Hollow ring (shown below the min) + a ✓ (shown once the min is satisfied). Only one is visible at a
  // time — swapped via `hidden` so it's a class/attr change, never innerHTML.
  const pillEmpty = svg(
    "svg",
    { class: "tm-interests-pill-icon", viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
      stroke: "currentColor", "stroke-width": 2.4, "aria-hidden": "true", focusable: "false" },
    [svg("circle", { cx: 12, cy: 12, r: 8 })],
  );
  const pillFilled = svg(
    "svg",
    { class: "tm-interests-pill-icon", viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
      stroke: "currentColor", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false", hidden: true },
    [svg("path", { d: "M5 13l4 4L19 7" })],
  );
  const pillLabel = el("span", { class: "tm-interests-pill-label" });
  const pill = el("div", { class: "tm-interests-pill", "aria-live": "polite" }, [pillEmpty, pillFilled, pillLabel]);
  return { pill, pillLabel, pillEmpty, pillFilled };
}

/**
 * Render the interests picker into the card body (paper "Pick interests", screens 9/10). Header
 * "What are you into?" + accent squiggle, the subtitle, a live selection pill, then a group section per
 * {@link groupCatalogue} ("POPULAR NEAR YOU" first, then the real categories), an inline error slot, and
 * a full-width "Continue →" CTA disabled until {@link canFinish}. NO skip — the step is a hard gate
 * (product-owner decision on TM-804). The always-at-least-one guard is NOT `canFinish(0, {min:0})` (that
 * returns true) — it's {@link selectionBounds}, which FLOORS the effective min to 1 even if the config
 * says 0, so `state.bounds.min` is never below 1 and Continue stays disabled until one interest is picked.
 */
function buildInterestsStep(view) {
  const groups = groupCatalogue(state.catalogue);

  // chips: Map<label, button | button[]> — one entry per label, holding every rendered chip instance so
  // paintChip can keep a highlighted row's Popular + home copies visually in sync.
  const chips = new Map();
  const groupSections = groups.map((group) => buildGroupSection(group, chips));

  const { pill, pillLabel, pillEmpty, pillFilled } = buildSelectionPill();
  const error = el("p", { class: "tm-field-error", role: "alert", hidden: true });

  // Full-width primary "Continue →" CTA. The accent fill + 2px offset ink shadow (enabled) vs grey/no-shadow
  // (disabled, below the min) is carried by the .tm-cta CSS reacting to :disabled — no JS class toggling.
  const finishBtn = el("button", { class: "tm-btn tm-btn-primary tm-cta tm-interests-continue", type: "button", onClick: submitInterests }, [
    el("span", { text: "Continue" }),
    svg(
      "svg",
      { class: "tm-btn-icon", viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
        stroke: "currentColor", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round",
        "aria-hidden": "true", focusable: "false" },
      [svg("path", { d: "M5 12h13M13 6l6 6-6 6" })],
    ),
  ]);

  const body = el("div", { class: "tm-interests-groups" }, groupSections.length
    ? groupSections
    // Defensive empty state: the catalogue fetch succeeded but returned nothing. Don't trap — let them finish.
    : [el("p", { class: "tm-muted", text: "No interests to pick right now — you can add some later." })]);

  clear(view).append(
    el("div", { class: "tm-onboarding-card" }, [
      el("div", { class: "tm-admin-head tm-onboarding-head" }, [
        el("h2", {}, [doodle("crowd", { class: "tm-doodle-header", title: "What are you into?" }), "What are you into?"]),
        // Accent hand-drawn squiggle directly under the heading (paper "Pick interests").
        svg(
          "svg",
          { class: "tm-onboarding-squiggle", viewBox: "0 0 180 11", preserveAspectRatio: "none", fill: "none",
            "aria-hidden": "true", focusable: "false" },
          [svg("path", { d: "M3 7C34 2.5 56 2.5 82 6s54 4.5 68-.5 30-2 36 1.5", stroke: "currentColor", "stroke-width": 3.2, "stroke-linecap": "round" })],
        ),
      ]),
      el("p", { class: "tm-muted", text: "Pick a few — we'll line up meetups that fit." }),
      pill,
      body,
      error,
      el("div", { class: "tm-form-actions" }, [finishBtn]),
    ]),
  );

  interestsShell = { finishBtn, error, chips, pill, pillLabel, pillEmpty, pillFilled };
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
  // A handset for the mandatory phone field (TM-880), same line-art style as its siblings.
  phone: () => fieldIcon(["M5.5 4h3l1.6 4-2 1.6a12.5 12.5 0 0 0 6.3 6.3l1.6-2 4 1.6v3q0 1.5-1.6 1.5A16.4 16.4 0 0 1 4 5.6Q4 4 5.5 4z"]),
};

function buildField(field) {
  const id = `onboarding-${field.field}`;
  const errorId = `${id}-error`;
  const hintId = field.hint ? `${id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");

  let input;
  if (field.type === "select") {
    // TM-898: the location dropdown — the same select machinery as the profile form's city field
    // (profile.js buildField), so the two surfaces offer the identical TM-877 allowed list.
    input = el(
      "select",
      { id, class: "tm-input", name: field.field, required: true, "aria-describedby": describedBy },
      field.options.map(([value, label]) => el("option", { value, text: label })),
    );
  } else {
    input = el("input", {
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
  }
  // Live-clear an inline error as soon as the user starts correcting the field (a <select> fires
  // "input" on a choice too, so the one listener covers both control kinds).
  input.addEventListener("input", () => {
    // TM-930: editing the phone un-verifies it (the proof was for the OLD digits, so the user must
    // re-send + re-confirm) AND drops any in-flight code — an edit made in the send→confirm window
    // would otherwise leave the OTP boxes live for the OLD number and let an unverified number pass
    // (TM-930 bypass fix). When locked/readOnly no input event fires, so this runs while editable.
    if (field.field === "phone" && (phoneVerify.verified || phoneVerifyInFlight())) unverifyPhone();
    setFieldError(field.field, validateField(field, input.value));
  });

  // TM-880: the phone field gets the mandatory country picker rendered BEFORE the national-number
  // input — the exact TM-781 control the edit-profile form uses (same options format, same disabled
  // "Confirm country…" placeholder that only prefillPhone can select programmatically for a legacy
  // bare number, same sticky data-user-picked semantics against the city soft-default).
  let country = null;
  if (field.field === "phone") {
    country = el(
      "select",
      {
        id: `${id}-country`,
        class: "tm-input tm-phone-country",
        name: "phoneCountry",
        "aria-label": "Phone country",
        "aria-describedby": describedBy,
      },
      [
        el("option", { value: "", text: "Confirm country…", disabled: true, hidden: true }),
        ...COUNTRIES.map((c) => el("option", { value: c.iso2, text: `${flagOf(c.iso2)} ${c.name} +${c.dial}` })),
      ],
    );
    country.value = "GB"; // concrete default pre-load; prefillPhone applies the real selection
    country.addEventListener("change", () => {
      country.setAttribute("data-user-picked", "true");
      // TM-930: switching the dial code changes the composed E.164, so a prior/in-flight verification no
      // longer applies — un-verify (unlocks the pair, hides the OTP) and require a fresh send + confirm.
      // In-flight too: a picker change in the send→confirm window must drop the stale code (bypass fix).
      if (phoneVerify.verified || phoneVerifyInFlight()) unverifyPhone();
      setFieldError(field.field, validateField(field, input.value));
    });
  }

  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const hint = field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null;

  // paper-complete-profile field: an uppercase muted label (via .tm-field-label CSS) + a leading inline
  // icon sitting inside a wrapper alongside the input. .tm-field-input keeps the icon + input on one row;
  // the input keeps its id/name/class so validation + submit are unchanged. The phone field seats its
  // country picker between the icon and the national input (the tm-phone-row flex pairing, TM-880).
  const icon = FIELD_ICONS[field.field]?.();
  const inputRow = country
    ? el("div", { class: "tm-field-input tm-phone-row" }, [icon, country, input])
    : el("div", { class: "tm-field-input" }, [icon, input]);

  // TM-930: the phone field grows a verify-and-link step — a "Send code" button, a gate-local
  // invisible reCAPTCHA host, a six-box OTP group (revealed on send), a resend link, and a
  // "Verified ✓" status line. Built with el()/attachOtpInput; the controllers live on `phoneVerify`.
  // TM-1009: only while the verified-phone requirement is ON — with the flag OFF (the shipped
  // default) none of the verify controls exist and the phone step is collect-only. Every phoneVerify
  // consumer null-guards its DOM handles, so the unbuilt state is safe.
  const verifyNodes =
    field.field === "phone" && verifiedPhoneRequired() ? buildPhoneVerify(id, describedBy) : [];

  const wrapper = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: field.label }),
    inputRow,
    hint,
    error,
    ...verifyNodes,
  ]);
  // `country` is only present for the phone field (TM-880) — undefined elsewhere.
  return { wrapper, input, error, country };
}

/**
 * Build + wire the TM-930 phone verify controls and stash their handles on `phoneVerify`. Returns the
 * DOM nodes to append inside the phone field wrapper (send button, OTP reveal, status line, and the
 * hidden reCAPTCHA host). Uses only el()/attachOtpInput — no innerHTML.
 */
function buildPhoneVerify(id, describedBy) {
  // Six single-char boxes (TM-867 shape: class="auth-otp-box" in a role="group"), first carries the
  // one-time-code autocomplete for OS autofill. ids prefixed `${id}-otp` so they're inspectable.
  const boxes = Array.from({ length: 6 }, (_, i) =>
    el("input", {
      id: i === 0 ? `${id}-otp` : `${id}-otp-${i + 1}`,
      class: "auth-otp-box",
      type: "text",
      inputmode: "numeric",
      // No maxLength: the TM-867 widget's distribute() fans a full pasted/autofilled/programmatically
      // set code out from box 0 across all six — a maxLength=1 would truncate that whole-code write to
      // one char (breaking OS one-time-code autofill AND the e2e `fill(firstBox, code)` peek pattern).
      autocomplete: i === 0 ? "one-time-code" : "off",
      "aria-label": `Digit ${i + 1} of 6`,
    }),
  );
  const otpGroup = el(
    "div",
    { id: `${id}-otp-group`, class: "auth-otp tm-phone-otp", role: "group", "aria-label": "Phone verification code" },
    boxes,
  );

  const resendBtn = el("button", {
    id: `${id}-resend`,
    type: "button",
    class: "tm-btn tm-phone-resend",
    text: "Send another code",
  });

  const otpWrap = el(
    "div",
    { class: "tm-phone-otp-wrap", hidden: true },
    [
      el("p", { class: "tm-muted tm-field-hint", text: "Enter the 6-digit code we texted you." }),
      otpGroup,
      resendBtn,
    ],
  );

  const sendBtn = el("button", {
    id: `${id}-send`,
    type: "button",
    class: "tm-btn tm-phone-send",
    text: "Send code",
    "aria-describedby": describedBy,
  });

  const statusEl = el("p", { id: `${id}-verified`, class: "tm-field-hint tm-phone-status", role: "status", hidden: true });

  // TM-930: the ONLY escape from the verified/locked state. Once verified the national input is
  // readOnly, the picker disabled, and Send hidden — so the input `input` / picker `change` listeners
  // (the usual un-verify triggers) can never fire. This button returns the field to the editable,
  // unverified state so a user who verified the WRONG number can correct + re-verify it (auth.js
  // confirmPhoneLink already handles updatePhoneNumber for changing an already-linked number). Hidden
  // until markPhoneVerified reveals it.
  const changeBtn = el("button", {
    id: `${id}-change`,
    type: "button",
    class: "tm-btn tm-phone-change",
    text: "Change number",
    hidden: true,
  });

  // TM-932: the one-tap "adopt my already-verified number" affordance, shown ONLY in the mismatch case
  // (the account has a DIFFERENT verified Firebase phone than the one stored on /me — e.g. verified one
  // number, stored another). Clicking it PATCHes /me { phone: <verified> } and lands verified with no
  // OTP (the number is already proven). Hidden until maybeOfferAdoptVerified reveals it. Its label is
  // set at reveal time (it carries the verified number).
  const adoptBtn = el("button", {
    id: `${id}-adopt`,
    type: "button",
    class: "tm-btn tm-phone-adopt",
    text: "Use my verified number",
    hidden: true,
  });

  // TM-987: the cross-account collision recovery affordance. Hidden until a hard-block collision
  // (auth/credential-already-in-use) reveals it. It's a mailto to support (the TM-987 runbook path) plus
  // a short "this is your number?" prompt, so a user whose genuinely-owned number is stuck on another
  // historical account isn't left at a dead end. Built with el() (textContent only — XSS-safe) and theme
  // tokens; the <a> is a normal link so it's keyboard-reachable + screen-reader announced.
  const recoveryEl = el(
    "p",
    { id: `${id}-recovery`, class: "tm-field-hint tm-phone-recovery", role: "status", hidden: true },
    [
      "Is this your number? ",
      el("a", {
        class: "tm-phone-recovery-link",
        href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(RECOVERY_SUBJECT)}`,
        text: "Contact support",
      }),
      " to move it to this account.",
    ],
  );

  // The gate-local invisible reCAPTCHA host — the login one (#recaptcha-container) lives in the login
  // view, which isn't mounted here. Firebase renders the invisible widget into this element.
  const recaptcha = el("div", { id: `${id}-recaptcha`, class: "tm-phone-recaptcha", "aria-hidden": "true" });

  sendBtn.addEventListener("click", () => sendPhoneCode());
  resendBtn.addEventListener("click", () => {
    if (phoneVerify.cooldown?.isActive()) return; // synthetic-click guard (matches login.js)
    sendPhoneCode();
  });
  changeBtn.addEventListener("click", () => {
    // Unlock the pair (input editable, picker enabled, Send back) and drop the verified/linked state so
    // the user can enter a different number and re-verify it. Focus the national input for the edit.
    unverifyPhone();
    const entry = shell?.fields.get("phone");
    entry?.input.focus();
  });
  adoptBtn.addEventListener("click", () => adoptVerifiedPhone()); // TM-932 mismatch one-tap

  phoneVerify.sendBtn = sendBtn;
  phoneVerify.otpGroup = otpGroup;
  phoneVerify.otpWrap = otpWrap;
  phoneVerify.statusEl = statusEl;
  phoneVerify.changeBtn = changeBtn;
  phoneVerify.adoptBtn = adoptBtn;
  phoneVerify.recoveryEl = recoveryEl;
  phoneVerify.recaptcha = recaptcha;
  // The six-box widget auto-submits through confirmPhoneOtp on the sixth digit (TM-867 onComplete),
  // exactly like login.js's SMS step — no explicit verify click.
  phoneVerify.otp = attachOtpInput({ group: otpGroup, onComplete: (code) => confirmPhoneOtp(code) });
  phoneVerify.cooldown = attachResendCooldown({ button: resendBtn, codeNoun: "SMS code" });
  phoneVerify.built = true;

  return [sendBtn, adoptBtn, statusEl, changeBtn, recoveryEl, otpWrap, recaptcha];
}

/** Show/hide the TM-987 cross-account collision recovery affordance (contact-support link). */
function setPhoneRecoveryVisible(visible) {
  if (phoneVerify.recoveryEl) phoneVerify.recoveryEl.hidden = !visible;
}

/** Whether an error is the cross-account phone collision hard-block (TM-987 recovery trigger). */
function isPhoneCollision(err) {
  const code = err?.code;
  return code === "auth/credential-already-in-use" || code === "auth/account-exists-with-different-credential";
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
    // `country` is the phone field's TM-781-style picker (undefined for every other field) — kept in
    // the shell so validateField/collectBody/prefillPhone can read the selected iso2 (TM-880).
    fields.set(field.field, { input: built.input, error: built.error, country: built.country });
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
