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

import {
  getMe,
  updateMe,
  getMembership,
  getInterestCatalogue,
  getInterestConfig,
  ApiError,
} from "./api.js";
import { currentUser, signOut, startPhoneVerify, confirmPhoneLink } from "./auth.js";
// TM-982: the phone is a VERIFIED IDENTITY. Editing it in the profile form must go through the SAME
// Firebase OTP verify-and-link the onboarding gate uses (TM-930), so the stored number is always the
// Firebase-verified one and a number linked to another account hard-blocks. Reuses the TM-867 six-box
// OTP widget + the TM-866 resend-cooldown machinery, exactly as onboarding.js's gate does.
import { attachOtpInput } from "./otp-input.js";
import { attachResendCooldown } from "./resend-cooldown.js";
import { isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES } from "./storage.js";
// TM-846: avatar changes are BROADCAST, not hand-repainted per surface. The upload success path
// announces once; every avatar surface subscribes (nav-avatar.js for the nav chip — loaded directly
// by index.html — and this module for the control preview + the identity header / strength hub).
import { announceAvatarChanged, onAvatarChangedEvent } from "./avatar-events.js";
import { isNativeCameraAvailable, captureAvatarImage } from "./native-camera.js";
import { clear, confirmDialog, el, modal, toast } from "./ui.js";
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
  strengthRingGeometry,
  publicSummary,
  validateProfileField,
  NOTIFICATION_PREFS,
  // TM-877: the city dropdown's allowed list + its validator (which also allows the caller's
  // already-saved off-list city, so an existing "Dubai" profile is never invalidated).
  CITY_OPTIONS,
  cityChoiceError,
  splitE164,
  composeE164,
  canonicalE164,
  defaultCountryFor,
  phonePartsError,
  PHONE_PICK_COUNTRY_MESSAGE,
  // TM-982: the pure "did the phone change, and if so is the new number verified?" gate — the profile
  // save is blocked while a CHANGED phone is unverified; an UNCHANGED phone is a no-op (no re-verify).
  phoneEditNeedsVerify,
  // TM-1005: the pure "offer to verify the CURRENT, UNCHANGED stored number" rule — true when the
  // stored phone is present but isn't the account's Firebase-verified one. Powers the "Verify this
  // number" affordance (same OTP flow, no re-typing); never blocks a save.
  phoneCurrentNeedsVerify,
  // TM-777 (I5): the pure next-day completeness-nudge decision (picked==1 + not-shown-today → CTA).
  // The max it targets is injected by the renderer from state.interestConfig (TM-778's shared config).
  nextDayInterestsNudge,
} from "./profile-core.js";
// TM-1005: the grace banner's "Verify now" CTA lands on #/profile and announces itself via this shared
// event (contract lives in the pure phone-reverify-core.js so the two halves can't drift); this module
// listens and reveals + focuses the "Verify this number" affordance once the phone field has painted.
// TM-1018: the cross-account collision predicate + the recovery-affordance copy come from the SAME pure
// module the onboarding gate uses, so the "Is this your number? Contact support" escape hatch is
// identical on both surfaces (and can't silently exist on only one — the bug for the retro cohort, whose
// only reachable verify surface during the grace window is THIS profile form, not the bouncing gate).
import {
  PHONE_VERIFY_REQUEST_EVENT,
  isPhoneCollision,
  PHONE_RECOVERY_MAILTO,
  PHONE_RECOVERY_PROMPT,
  PHONE_RECOVERY_LINK_TEXT,
  PHONE_RECOVERY_SUFFIX,
} from "./phone-reverify-core.js";
// Country data for the phone picker (TM-781): the pinned+sorted list and the emoji-flag derivation.
// CSP-safe — flags are Unicode regional-indicator emoji built from the iso2, no external assets.
import { COUNTRIES, flagOf } from "./countries.js";
// TM-1009: the deploy-time switch over the whole verified-phone requirement
// (config.flags.requireVerifiedPhone, shipped OFF). With the flag OFF the TM-982 phone-edit save
// gate below (phoneNeedsVerify) is a no-op — a CHANGED number saves without an OTP, and since the
// Send-code affordance keys off the same rule, no verify UI sprouts either. ON = TM-982, unchanged.
import { verifiedPhoneRequired } from "./verified-phone-flag.js";
// Pure Interests-card logic (TM-778) — chip view-model, catalogue grouping, add/remove-within-min/max,
// and the min/max config normaliser, unit-tested in web/tools/interests-core.test.mjs.
import {
  normaliseInterestConfig,
  savedInterestLabels,
  interestChipsModel,
  catalogueGroups,
  toggleInterest,
  selectionError,
} from "./interests-core.js";
// Membership tier metadata (TM-643) — the membership row now reflects the caller's REAL tier via the
// pure, unit-tested profileMembershipRow() (which sources tier NAMES from the shared tier catalogue),
// and "Manage" links to the membership screen when the feature flag is on.
import { profileMembershipRow, profileManageAffordance, membershipEnabled } from "./membership-tier.js";

// The editable fields and their client-side rules, mirroring the backend's UpdateMeRequest bean
// validation (openapi.json) so we fail fast in the browser AND match what the server will accept.
// Keeping a single declarative list keeps the form, the read-back, and the patch builder in sync.
const TEXT_MAX = 255;
// firstName/lastName/city are name-like (TM-771): validateProfileField requires at least one letter
// and rejects digits, so a purely numeric "name" can no longer save. The hint mirrors the age/phone
// fields' pattern of telling the user the rule up front.
const NAME_HINT = "Letters, spaces, hyphens and apostrophes only.";
const FIELDS = [
  { key: "firstName", label: "First name", type: "text", maxLength: TEXT_MAX, autocomplete: "given-name", hint: NAME_HINT },
  { key: "lastName", label: "Last name", type: "text", maxLength: TEXT_MAX, autocomplete: "family-name", hint: NAME_HINT },
  {
    // TM-877: city is a dropdown of the interim allowed list (admin-managed version is TM-878),
    // reusing the existing select machinery (see notificationPref). The leading blank option keeps
    // "no city yet" honest — a new user is never silently defaulted to the first city — and
    // collectPatch's blank-omission then means "no change", exactly like the old text field.
    // fillForm keeps an already-saved OFF-LIST city (e.g. "Dubai") selectable via an injected
    // option, so an existing profile is preserved, never overwritten on save.
    key: "city",
    label: "City",
    type: "select",
    options: [["", "Choose a city…"], ...CITY_OPTIONS.map((c) => [c, c])],
  },
  {
    key: "age",
    label: "Age",
    type: "number",
    // TM-884: the platform age band is 18–99 (was 13–120), mirrored by the backend @Min/@Max.
    // Existing under-18 accounts are GRANDFATHERED: validateField/collectPatch let an UNCHANGED
    // saved age through so those accounts can still edit the rest of their profile.
    min: 18,
    max: 99,
    autocomplete: "off",
    hint: "Between 18 and 99.",
  },
  {
    key: "phone",
    label: "Phone",
    type: "tel",
    maxLength: 32,
    autocomplete: "tel-national",
    // The input holds only the NATIONAL number since TM-781 (the +dial comes from the country
    // picker rendered beside it). This lenient char-pattern is DELIBERATELY looser than the
    // backend's tightened E.164 stored-value pattern: the strict shape (mandatory +dial, digit
    // floor/ceiling) is enforced by the pure phone rules in profile-core (phonePartsError), which
    // give targeted messages ("pick a country…") where a bare pattern-mismatch could not.
    pattern: "^\\+?[0-9 ()./-]{3,32}$",
    hint: "Pick a country, then the national number — digits, spaces and ( ) . / - only.",
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
  // Interests card (TM-778): the min/max bounds (from GET /api/v1/interests/config, else defaults) and
  // the offered catalogue (from GET /api/v1/interests/catalogue) for the ADD picker. Both come from the
  // PUBLIC picker read endpoints (TM-776; any signed-in user) and are fetched best-effort on profile
  // load; the saved interests themselves live on state.profile.interests (from /me). TM-777 (I5) reuses
  // state.interestConfig.max (this SAME best-effort config) as the max the next-day nudge copy targets —
  // one fetch, one source of truth — falling back to the seeded default when the config read failed.
  interestConfig: normaliseInterestConfig(null),
  interestCatalogue: null, // null = not yet loaded / read failed — the picker degrades honestly
  interestsSaving: false, // guards against concurrent PATCHes while a chip add/remove is in flight
};

let shell = null; // { form, fields: Map<key,{input, error, hint}>, save, summary } once built

const $ = (id) => document.getElementById(id);

// ---- phone VERIFY-AND-LINK step (TM-982) ----------------------------------------------------
// Phone is a VERIFIED IDENTITY: changing it in the profile form must go through a Firebase phone OTP,
// with the verified credential LINKED to the signed-in account (auth.js startPhoneVerify →
// confirmPhoneLink), exactly like the onboarding gate (TM-930). Only a VERIFIED changed number passes
// the profile save; a number already linked to ANOTHER account hard-blocks (Firebase itself rejects
// the link with auth/credential-already-in-use, which we surface as the locked hard-block copy).
//
// This mirrors onboarding.js's `phoneVerify` controller, scoped to the single profile phone field.
// The KEY difference from onboarding: onboarding requires EVERY phone to be verified (a fresh gate);
// here an UNCHANGED phone is a no-op (the user might be editing only their city), so the save-block and
// the verify controls key off whether the composed number DIFFERS from the loaded/stored one
// (`phoneEditNeedsVerify`, the pure rule) — never re-OTP a number the user didn't touch.
const phoneVerify = {
  built: false, // the verify controls (send button, OTP group, recaptcha) have been built + wired
  storedE164: "", // the CANONICAL phone loaded from /me — the "unchanged" baseline (set by fillPhoneField)
  verified: false, // the currently-composed E.164 has been proven owned + linked THIS session
  verifiedE164: "", // the exact E.164 that was verified (guards a silent picker/input edit)
  verificationId: null, // the in-flight Firebase verificationId between send and confirm
  pendingE164: "", // the exact E.164 the in-flight verificationId was ISSUED for (edit-drop guard)
  sending: false, // a send/verify request is in flight (single-flight guard)
  otp: null, // the attachOtpInput controller over the six boxes
  cooldown: null, // the attachResendCooldown controller over the resend link
  // DOM nodes (built in buildPhoneVerify):
  sendBtn: null,
  otpWrap: null, // the reveal-on-send wrapper (label + boxes + resend), hidden until a send
  statusEl: null, // the "Verified ✓" / helper line
  recoveryEl: null, // TM-1018: the "this is my number → contact support" affordance, shown only on a collision
  recaptcha: null, // the profile-local invisible reCAPTCHA host
};

/** Human copy for the phone error line, mapping the Firebase auth error codes we care about (TM-982);
 *  identical mapping to the onboarding gate so the two surfaces speak with one voice. */
function phoneVerifyErrorCopy(err) {
  const code = err?.code;
  // Collision is the HARD BLOCK — the exact copy locked by the product owner (matches the gate).
  if (code === "auth/credential-already-in-use" || code === "auth/account-exists-with-different-credential") {
    return "This number is already registered — sign into that account.";
  }
  if (code === "auth/invalid-verification-code") return "That code isn't right — check the SMS and try again.";
  if (code === "auth/code-expired") return "That code expired — send a new one.";
  if (code === "auth/too-many-requests") return "Too many attempts — please wait a moment and try again.";
  if (code === "auth/invalid-phone-number") return phonePartsError("", "");
  return "Couldn't verify that number. Please try again.";
}

/** The E.164 currently composed from the phone (picker, national) pair, or "" if incomplete. */
function composedPhoneE164() {
  const entry = shell?.fields.get("phone");
  if (!entry) return "";
  const national = (entry.input.value ?? "").trim();
  const iso2 = entry.country ? entry.country.value : "";
  if (!iso2 || national === "") return "";
  return composeE164(iso2, national);
}

/**
 * Does the phone as it stands in the form REQUIRE verification before the profile can be saved? Pure
 * decision delegated to profile-core.phoneEditNeedsVerify: an unchanged number is fine; a CHANGED
 * number needs the exact composed value verified this session. When this is false the save proceeds;
 * when true the save is blocked and the phone field paints the verify prompt.
 */
function phoneNeedsVerify() {
  // TM-1009: the whole verified-phone requirement is deploy-time switchable (shipped OFF). With the
  // flag OFF a changed number needs no re-verify — this single early-return covers both consumers
  // (the save block in validateAll AND the Send-code affordance in refreshPhoneVerifyAffordance).
  if (!verifiedPhoneRequired()) return false;
  const composed = composedPhoneE164();
  const verified = phoneVerify.verified ? phoneVerify.verifiedE164 : "";
  return phoneEditNeedsVerify(phoneVerify.storedE164, composed, verified);
}

/**
 * TM-1005: should the phone field offer "Verify this number" for the CURRENT, UNCHANGED stored phone?
 * Pure decision delegated to profile-core.phoneCurrentNeedsVerify: true when the number in the form IS
 * the stored one but that stored number is not the account's Firebase-verified phone (the exact
 * needsVerifiedPhone eligibility — all email-code/admin accounts + pre-verify legacy accounts). This
 * NEVER blocks a save (the TM-982 save gate is untouched); it only reveals the affordance that runs
 * the same startPhoneVerify → confirmPhoneLink flow without the user re-typing their number.
 */
function phoneNeedsCurrentVerify() {
  // TM-1020: gate on the same TM-1009 kill-switch as phoneNeedsVerify — with verified-phone parked
  // OFF the profile must NOT sprout a "Verify this number" affordance that solicits a real OTP for a
  // requirement the flag has switched off. This is the 5th consumer TM-1009's fold missed.
  if (!verifiedPhoneRequired()) return false;
  return phoneCurrentNeedsVerify(phoneVerify.storedE164, composedPhoneE164(), currentUser()?.phoneNumber);
}

/** Lock the picker + national input and paint the "Verified ✓" state (TM-982). Mirrors the gate. */
function markPhoneVerified(e164) {
  const entry = shell?.fields.get("phone");
  if (!entry) return;
  phoneVerify.verified = true;
  phoneVerify.verifiedE164 = e164;
  phoneVerify.verificationId = null;
  phoneVerify.pendingE164 = "";
  // The verified lock is `readOnly` (still focusable/submittable), NOT `disabled` — and we clear any
  // `disabled` a prior in-flight setPhoneControlsBusy(true) left on, so the field is genuinely locked
  // (not stuck disabled) and the input listener can still fire to un-verify a later edit (same fix as
  // the gate, TM-930).
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
  // TM-1018: verified → any prior collision is resolved — retract the recovery affordance.
  setPhoneRecoveryVisible(false);
}

/**
 * Is a verification currently in flight (a code was sent but not yet confirmed)? True between "Send
 * code" and a successful/failed confirm. Editing the number in this window must drop the stale in-flight
 * code (it was issued for the OLD digits), so the listeners reset on this too — the same bypass fix the
 * gate carries (TM-930).
 */
function phoneVerifyInFlight() {
  return phoneVerify.verificationId != null || phoneVerify.pendingE164 !== "";
}

/** The gentle "verify your new number" prompt shown on a changed-but-unverified phone (TM-982). */
const PHONE_VERIFY_PROMPT = "New number — tap Send code to verify it before saving.";

/**
 * Return the phone field to the UNVERIFIED, editable state (TM-982) — the user edited a verified number,
 * changed the picker, or a confirm failed. Unlocks the pair, hides the OTP boxes, clears the badge.
 * Idempotent. NOTE: this does NOT clear storedE164 (the loaded baseline) — only the session-verified
 * proof — so an edit back to the ORIGINAL number is still recognised as "unchanged" and saves without
 * an OTP (phoneEditNeedsVerify returns false for stored===composed).
 */
function unverifyPhone() {
  const entry = shell?.fields.get("phone");
  phoneVerify.verified = false;
  phoneVerify.verifiedE164 = "";
  phoneVerify.verificationId = null;
  phoneVerify.pendingE164 = "";
  if (entry) {
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
  // TM-1018: editing/re-sending is a fresh attempt (likely a DIFFERENT number) — retract the collision
  // recovery affordance so it only ever shows against the number that actually collided (mirrors the gate).
  setPhoneRecoveryVisible(false);
  refreshPhoneVerifyAffordance();
}

/** The TM-1005 label for verifying the CURRENT, unchanged stored number (vs "Send code" on a change). */
const PHONE_VERIFY_CURRENT_LABEL = "Verify this number";
/** The TM-982 label for verifying a CHANGED number — the affordance's original wording. */
const PHONE_VERIFY_CHANGED_LABEL = "Send code";

/**
 * Reflect the current phone edit state onto the verify controls. The verify button is shown in exactly
 * two states, and its label tells them apart:
 *   • the composed number CHANGED and isn't yet verified/in-flight (TM-982) → "Send code";
 *   • the composed number is the UNCHANGED stored one but that stored phone was never Firebase-verified
 *     (TM-1005 — phoneNeedsCurrentVerify: email-code/admin accounts + pre-verify legacy accounts) →
 *     "Verify this number", the missing path out of the re-verify dead-end. Same OTP flow, no re-typing.
 * A number that is unchanged AND account-verified hides the button, so the common "edit only my city"
 * save never sprouts a stray verify affordance. Called after every phone edit + on prefill. No-op until
 * the controls are built.
 */
function refreshPhoneVerifyAffordance() {
  if (!phoneVerify.built || !phoneVerify.sendBtn) return;
  if (phoneVerify.verified || phoneVerifyInFlight()) return; // verified/in-flight controls own their own visibility
  const needsVerify = phoneNeedsVerify();
  // Evaluate the TM-1005 unchanged-but-unverified case only when the changed-number gate isn't already
  // claiming the button — the two states are disjoint by construction (changed vs unchanged), but the
  // short-circuit keeps the changed path's wording authoritative the moment an edit lands.
  const needsCurrentVerify = !needsVerify && phoneNeedsCurrentVerify();
  phoneVerify.sendBtn.hidden = !(needsVerify || needsCurrentVerify);
  phoneVerify.sendBtn.textContent = needsCurrentVerify ? PHONE_VERIFY_CURRENT_LABEL : PHONE_VERIFY_CHANGED_LABEL;
  // An unchanged number clears any lingering verify prompt; a changed one gets a gentle nudge.
  if (!needsVerify) {
    if (shell?.fields.get("phone")?.error?.textContent === PHONE_VERIFY_PROMPT) setFieldError("phone", "");
  }
  // TM-1005: if the grace banner's CTA asked us to surface the verify affordance, consume that request
  // now that the button's visibility for the current state is settled.
  consumePendingVerifyReveal();
}

// ---- TM-1005: banner-CTA → profile handoff ---------------------------------------------------
// The grace banner (phone-reverify-notice.js) navigates to #/profile and dispatches
// PHONE_VERIFY_REQUEST_EVENT. The profile usually hasn't painted yet at that moment (buildShell +
// GET /me are async behind the route change), so the request is remembered here and consumed by the
// first refreshPhoneVerifyAffordance() that runs with the affordance actually visible — scroll + focus
// land the user straight on the "Verify this number" button. If the account turns out not to need
// verification by the time the profile paints (e.g. verified on another device), the stale request is
// dropped rather than left to hijack a later visit.
let pendingVerifyReveal = false;

/** Consume a pending banner-CTA reveal request: focus the verify affordance if it's visible, or drop
 *  the request when the loaded profile no longer needs any phone verification. No-op otherwise. */
function consumePendingVerifyReveal() {
  if (!pendingVerifyReveal) return;
  if (!phoneVerify.built || !phoneVerify.sendBtn) return;
  // Only act while the profile is the VISIBLE route. The CTA's hash-nav routes asynchronously, so at
  // dispatch time a STALE profile mount (from an earlier visit) may still be painted under a hidden
  // #profile-view — consuming against that would focus a hidden node and eat the request before the
  // rebuilt, visible profile ever sees it. Keep it pending until the view is actually showing.
  const view = typeof document !== "undefined" ? document.getElementById("profile-view") : null;
  if (!view || view.hidden) return;
  if (!phoneVerify.sendBtn.hidden) {
    pendingVerifyReveal = false;
    // getAttribute (not .id) — the attribute is what buildPhoneVerify set, and it reads identically in
    // the real DOM and the node-test fake elements (which don't reflect attributes onto properties).
    focusOnPage(phoneVerify.sendBtn.getAttribute("id"));
    return;
  }
  // Profile is loaded and the affordance (rightly) isn't showing → nothing to point at; drop the
  // request so it can't surprise-focus the phone field on some later, unrelated repaint.
  if (state.loaded && !phoneNeedsVerify() && !phoneNeedsCurrentVerify()) pendingVerifyReveal = false;
}

if (typeof window !== "undefined") {
  window.addEventListener(PHONE_VERIFY_REQUEST_EVENT, () => {
    pendingVerifyReveal = true;
    // Try immediately — the user may already be ON the profile (the banner renders there too), in
    // which case the affordance is painted and focusable right now; otherwise the flag waits for the
    // post-load refreshPhoneVerifyAffordance().
    consumePendingVerifyReveal();
  });
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
 * SHORT-CIRCUIT (the composed number already IS this account's linked Firebase phone — already verified,
 * no OTP) or fire startPhoneVerify and reveal the OTP. Mirrors the onboarding gate's sendPhoneCode.
 */
async function sendPhoneCode() {
  if (phoneVerify.sending) return;
  const entry = shell?.fields.get("phone");
  if (!entry) return;
  // Same pure rule set as save — reject a blank/unconfirmed/too-short pair before any send.
  const partsError = validateField({ key: "phone" }, entry.input.value);
  if (partsError) {
    setFieldError("phone", partsError);
    return;
  }
  const e164 = composedPhoneE164();
  setFieldError("phone", "");

  // SHORT-CIRCUIT: the entered number already IS this account's verified Firebase phone — no OTP needed.
  if (e164 && canonicalE164(currentUser()?.phoneNumber) === canonicalE164(e164)) {
    markPhoneVerified(e164);
    return;
  }

  phoneVerify.sending = true;
  setPhoneControlsBusy(true);
  try {
    phoneVerify.verificationId = await startPhoneVerify(e164, phoneVerify.recaptcha);
    // Remember the EXACT E.164 this verificationId was issued for, so confirmPhoneOtp marks THIS number
    // verified (and detects a mid-flow input/picker edit) rather than re-composing from the live inputs.
    phoneVerify.pendingE164 = e164;
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
 * Confirm the OTP (auto-submit from the six-box widget) → link the credential to the signed-in account.
 * Collision (auth/credential-already-in-use) is the hard block: the boxes clear, the locked copy paints,
 * the phone stays unverified, and the TM-1018 recovery affordance reveals (see below). On success the
 * number is verified in the UI; a CHANGED number is ALSO PATCHed to /me immediately (TM-1018) so an
 * abandoned form still has the verified phone on record — the rest of the form stays on the deferred Save.
 * Single-flight via phoneVerify.sending.
 */
async function confirmPhoneOtp(code) {
  if (phoneVerify.sending) return; // a confirm is already running — drop the re-entrant call
  if (!phoneVerify.verificationId) return; // no in-flight verification (shouldn't happen)
  // Bypass fix (mirrors the gate): the OTP proves ownership of the number the verificationId was ISSUED
  // for (pendingE164) — NOT whatever the (editable) input reads now. If the user edited the number after
  // "Send code" but before confirming, drop the stale verification and force a fresh send.
  const pending = phoneVerify.pendingE164;
  if (!pending) return;
  if (composedPhoneE164() !== pending) {
    unverifyPhone();
    setFieldError("phone", "The number changed — tap Send code to verify it.");
    return;
  }
  phoneVerify.sending = true;
  setPhoneControlsBusy(true);
  setFieldError("phone", "");
  try {
    await confirmPhoneLink(phoneVerify.verificationId, code);
    // Linked + proven. Mark the number the code was ISSUED for (pending) — the guard above proved the
    // input still matches it.
    markPhoneVerified(pending);
    if (canonicalE164(pending) === phoneVerify.storedE164 && phoneVerify.storedE164 !== "") {
      // TM-1005: the user verified their CURRENT stored number (the "Verify this number" path). The
      // stored value is already right — there is nothing to save (collectPatch omits an unchanged
      // phone), so don't tell them to. The account-level need is now met (currentUser().phoneNumber is
      // this number), so ask the grace banner to re-check itself — it clears immediately instead of
      // waiting for the next auth change. Loose global seam (not an import) — the notice module is a
      // self-wiring singleton and this must stay a no-op wherever it isn't loaded (tests, native shells).
      toast("Number verified ✓", { type: "success", timeout: 2500 });
      if (typeof window !== "undefined") window.tmPhoneReverifyNotice?.refresh?.();
    } else {
      // TM-1018: a CHANGED number is now verified + linked. Persist it to /me IMMEDIATELY — exactly like
      // the onboarding gate (onboarding.js confirmPhoneOtp) — so a user who abandons the form between the
      // two forks (verified-at-Firebase vs stored-on-/me) doesn't leave the account with a verified
      // phone Firebase knows but /me doesn't. The rest of the form still saves on the user-driven Save;
      // only the verified phone is written eagerly. A failed PATCH is non-fatal: the credential is
      // already linked (the number is theirs) and collectPatch re-sends the same value on the form Save,
      // so we log and let the user save the composed phone with the rest — never a dead end.
      try {
        await updateMe({ phone: pending });
      } catch (patchErr) {
        console.warn("[profile] PATCH /me {phone} after link failed (non-fatal):", patchErr?.message ?? patchErr);
      }
      toast("Number verified — save to update your profile.", { type: "success", timeout: 2500 });
    }
  } catch (err) {
    // A failed confirm keeps the number UNVERIFIED. Clear the boxes (the widget auto-submits on any
    // input that leaves all six filled, so a stale full set would resubmit on the first keystroke) and
    // paint the mapped error. Collision paints the hard-block copy AND reveals the recovery affordance.
    phoneVerify.otp?.clear();
    setFieldError("phone", phoneVerifyErrorCopy(err));
    // TM-1018: a cross-account collision is a dead end without a merge path — reveal the same
    // contact-support recovery affordance the onboarding gate shows (TM-987). During the grace window the
    // gate bounces, so THIS profile form is the only reachable verify surface for the retro cohort; a
    // user whose genuinely-owned number is stuck on an old account needs the escape hatch here too. Any
    // OTHER error (bad/expired code, rate limit) hides it — those retry on this same account.
    setPhoneRecoveryVisible(isPhoneCollision(err));
    phoneVerify.otp?.focus();
  } finally {
    phoneVerify.sending = false;
    setPhoneControlsBusy(false);
  }
}

// ---- client-side validation -----------------------------------------------------------------

/**
 * Validate one field's raw string value against its rules. Returns an error message, or "" if valid.
 * Empty is always allowed (the backend treats missing/blank as "leave unchanged"); we only validate
 * what the user actually typed so we never block clearing a field.
 */
function validateField(field, raw) {
  // Thin delegate to the pure, unit-tested rules in profile-core.js (TM-162/TM-752). Keeping the
  // logic there means the behaviour — incl. the phone 7–15 digit guard on top of the char-pattern —
  // is guarded by tests, not just this DOM shell.
  if (field.key === "phone") {
    // TM-781: the phone is a (country picker, national number) PAIR — validated by the pure
    // phonePartsError so the whole rule (the confirm-country gate that blocks saving a legacy bare
    // number + the TM-752 digit guard on the national part) lives in profile-core, not here.
    const country = shell?.fields.get("phone")?.country;
    return phonePartsError(country ? country.value : "", raw);
  }
  if (field.key === "city") {
    // TM-877: the city must come from the allowed dropdown list — except the caller's own saved
    // off-list city (kept selectable by fillForm), which must stay valid so it's never overwritten.
    return cityChoiceError(raw, state.profile?.city);
  }
  if (field.key === "age") {
    // TM-884 grandfather: an existing account whose SAVED age is now out of band (e.g. a 15-year-old
    // from the 13–120 era) must still be able to save the rest of their profile — an UNCHANGED age
    // is not a new attestation, so it passes here (and collectPatch omits it from the PATCH).
    const raw2 = String(raw ?? "").trim();
    if (raw2 !== "" && state.profile?.age != null && raw2 === String(state.profile.age)) return "";
  }
  return validateProfileField(field, raw);
}

/** Show/clear the inline error message for a field and reflect it on the offending control for a11y. */
function setFieldError(key, message) {
  const f = shell?.fields.get(key);
  if (!f) return;
  f.error.textContent = message || "";
  f.error.hidden = !message;
  // TM-781: the confirm-country prompt is a defect of the COUNTRY PICKER (its value is the ""
  // placeholder), not of the national input — so aria-invalid + the red ring must land on the
  // select the user actually has to change, and the (perfectly fine) input must not be blamed.
  // Every other message faults the input, exactly as before the picker existed.
  const countryAtFault = Boolean(message) && Boolean(f.country) && message === PHONE_PICK_COUNTRY_MESSAGE;
  setControlInvalid(f.input, Boolean(message) && !countryAtFault);
  if (f.country) setControlInvalid(f.country, countryAtFault);
}

/** Reflect one control's invalid state: aria-invalid for AT + the tm-field-invalid ring for sighted users. */
function setControlInvalid(control, invalid) {
  if (invalid) {
    control.setAttribute("aria-invalid", "true");
    control.classList.add("tm-field-invalid");
  } else {
    control.removeAttribute("aria-invalid");
    control.classList.remove("tm-field-invalid");
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
  // TM-982: a CHANGED phone must be Firebase-verified before the profile can be saved (phone is a
  // verified identity). This runs only after the per-field shape checks pass for the phone, so a
  // blank/too-short/unconfirmed pair surfaces its own error first rather than the verify prompt on
  // top of it. An UNCHANGED phone is a no-op here (phoneNeedsVerify → false), so editing only the
  // city/name never trips this gate.
  if (ok && !shell.fields.get("phone").error.textContent && phoneNeedsVerify()) {
    setFieldError("phone", PHONE_VERIFY_PROMPT);
    ok = false;
  }
  return ok;
}

// ---- data -----------------------------------------------------------------------------------

/** Populate the inputs from a MeResponse (null/undefined → empty; notificationPref defaults sensibly). */
function fillForm(profile) {
  for (const field of FIELDS) {
    const entry = shell.fields.get(field.key);
    const value = profile?.[field.key];
    if (field.key === "phone") {
      // TM-781: the stored phone maps onto TWO controls (country picker + national input).
      fillPhoneField(entry, value, profile);
      continue;
    }
    const input = entry.input;
    if (field.key === "city") {
      fillCitySelect(input, value);
    } else if (field.type === "select") {
      input.value = NOTIFICATION_PREFS.has(value) ? value : "EMAIL";
    } else {
      input.value = value == null ? "" : String(value);
    }
  }
  // TM-907: switch the name fields to read-only PRE-EMPTIVELY when the account is name-locked, so the
  // user sees the lock rather than saving-then-hitting the backend 422. Runs AFTER the value fill above
  // so the carve-out can read each field's just-set value.
  applyNameLock(profile);
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

// The name fields this Profile surface edits (TM-907). displayName is NOT edited here (it's set on the
// onboarding gate), so only first/last are lockable on this screen; the backend locks displayName on
// its own write path regardless.
const LOCKABLE_NAME_KEYS = ["firstName", "lastName"];

/**
 * TM-907 read-only name lock. When {@code me.nameLocked} is true, a user with real-world event history
 * may no longer CHANGE an already-set first/last name — so we render each ALREADY-SET name field
 * read-only up front (not save-then-error) and reveal a visible, screen-reader-announced explanation.
 *
 * <p><b>Carve-out (must-not-break):</b> a currently-EMPTY name field stays fully editable even when
 * locked — a user who attended with only a displayName can still SET their first/last once (mirroring
 * the backend's "seed-when-unset" allowance), so a locked empty name never becomes an unfixable
 * profile-strength gap. Only a field holding a non-blank value is frozen.
 *
 * <p>Idempotent and reversible: called on every fillForm (initial load, Reset, post-save repaint), it
 * both sets AND clears the read-only state, so an admin-corrected / unlocked profile repaints editable.
 * a11y: read-only is conveyed by the real {@code readOnly} property + {@code aria-readonly="true"} +
 * a {@code .tm-input-locked} class AND the visible note — never by colour alone.
 */
function applyNameLock(profile) {
  const locked = Boolean(profile?.nameLocked);
  let anyFrozen = false;
  for (const key of LOCKABLE_NAME_KEYS) {
    const entry = shell.fields.get(key);
    if (!entry) continue;
    const input = entry.input;
    // Carve-out: only freeze a name that is ALREADY set — an empty one stays settable once.
    const hasValue = (input.value ?? "").trim() !== "";
    const freeze = locked && hasValue;
    input.readOnly = freeze;
    if (freeze) {
      input.setAttribute("aria-readonly", "true");
      input.classList.add("tm-input-locked");
      anyFrozen = true;
    } else {
      input.removeAttribute("aria-readonly");
      input.classList.remove("tm-input-locked");
    }
  }
  // The visible explanation shows only when at least one name field is actually frozen (a locked user
  // with an all-empty name sees no note and can still fill it in — the carve-out, honestly reflected).
  if (shell.nameLockNote) shell.nameLockNote.hidden = !anyFrozen;
}

/**
 * Fill the phone country picker + national input from the stored value (TM-781). Three states:
 *
 *   • saved E.164 ("+447700900123") — split back into picker + national. The SAVED country always
 *     wins here, so a later city change can never flip an existing phone's country.
 *   • legacy bare number ("07700 900123", stored before TM-781) — incomplete: the picker moves to
 *     the disabled "Confirm country…" placeholder and the confirm prompt is painted immediately;
 *     validateAll() blocks saving until the user picks a real country (an explicit product rule —
 *     we must not guess which country a bare number belongs to).
 *   • no saved phone — SOFT-default the picker from the user's city (curated map, fallback GB),
 *     unless the user already picked a country themselves this session (data-user-picked, set by
 *     the picker's change listener) — an explicit selection always outranks the soft default.
 *
 * @param {{input: HTMLElement, error: HTMLElement, country: HTMLElement|undefined}} entry the
 *   phone field's controls from the shell.
 * @param {*} value the stored `me.phone`.
 * @param {object|null|undefined} profile the full MeResponse (for the city soft-default).
 */
function fillPhoneField(entry, value, profile) {
  const saved = value == null ? "" : String(value).trim();
  // TM-982: (re)establish the "unchanged" baseline for the verify gate and drop any prior session's
  // verified lock — a fresh load/reset must not inherit a stale "Verified ✓" from a previous state.
  // storedE164 is the CANONICAL loaded value (or "" for none/legacy), so an edit BACK to it reads as
  // unchanged and saves without an OTP. unverifyPhone() also refreshes the Send-code affordance.
  phoneVerify.storedE164 = canonicalE164(saved);
  unverifyPhone();
  if (!entry.country) {
    // Defensive: no picker built (shouldn't happen) — fall back to the pre-TM-781 raw fill.
    entry.input.value = saved;
    return;
  }
  const parsed = splitE164(saved);
  if (parsed) {
    entry.country.value = parsed.iso2;
    entry.input.value = parsed.national;
    setFieldError("phone", ""); // a clean stored value clears any stale confirm-state prompt
  } else if (saved !== "") {
    entry.country.value = ""; // the disabled placeholder — the explicit confirm-country state
    entry.input.value = saved;
    setFieldError("phone", phonePartsError("", saved));
  } else {
    entry.input.value = "";
    if (!entry.country.getAttribute("data-user-picked")) {
      entry.country.value = defaultCountryFor({ phone: "", city: profile?.city });
    }
    setFieldError("phone", "");
  }
  // The loaded number is unchanged by construction, so the Send-code affordance stays hidden until an
  // actual edit; refresh explicitly so a reset from a mid-edit state hides a stray button.
  refreshPhoneVerifyAffordance();
}

/**
 * Select the saved city in the TM-877 dropdown. A saved value on the allowed list (or "") selects
 * directly. A saved OFF-LIST city (e.g. "Dubai", stored before the list existed) gets its own extra
 * option injected so it stays both VISIBLE and SELECTABLE — the product rule: an existing city is
 * preserved, never silently overwritten on save. The `data-offlist` marker keeps re-fills (reset /
 * post-save refresh) from stacking duplicate options for the same value.
 *
 * @param {HTMLSelectElement} select the city <select>.
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

// ── Next-day interests nudge persistence (TM-777 / I5) ──────────────────────────────────────────
// The "last time we showed the add-more-interests CTA" is stored client-side in localStorage, keyed
// per-uid exactly like tour.js's `stateKey` (`tm.<feature>.v1.<uid>`) — NO backend field, NO API call.
// The pure decision (profile-core.nextDayInterestsNudge) compares this stored day against today; these
// three helpers are the thin read/write around it, try/catch-wrapped so private-mode storage failures
// degrade to "no persistence" (the CTA may simply re-show on the next paint) but never break paintHub.

/** Per-uid localStorage key for the last time the interests nudge was shown (tour.js keying convention). */
function interestsNudgeKey() {
  const uid = currentUser()?.uid || "anon";
  return `tm.i5.interestsNudge.v1.${uid}`;
}

/** The stored "last shown" ISO timestamp, or null when never shown / storage is unavailable. */
function readLastInterestsPrompt() {
  try {
    return localStorage.getItem(interestsNudgeKey());
  } catch {
    return null; // storage unavailable (private mode) — treat as never shown; non-fatal.
  }
}

/** Stamp "the interests nudge was shown at `nowISO`" so the same-day suppression fires next paint. */
function recordInterestsPromptShown(nowISO) {
  try {
    localStorage.setItem(interestsNudgeKey(), nowISO);
  } catch {
    /* storage unavailable (private mode) — the nudge just won't persist; non-fatal. */
  }
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
  // TM-846: the identity avatar is a real avatar SURFACE — the photo when the Firebase user has one
  // (photoURL, the single source of truth — read live, same as the avatar control), else the initial
  // glyph. Exactly one of the pair is visible at a time.
  const photoURL = currentUser()?.photoURL || "";
  hub.glyph.textContent = id.initial;
  if (photoURL) {
    hub.photo.src = photoURL; // assigning .src is XSS-safe (no markup parse) — never innerHTML.
    hub.photo.hidden = false;
    hub.glyph.hidden = true;
  } else {
    hub.photo.removeAttribute("src");
    hub.photo.hidden = true;
    hub.glyph.hidden = false;
  }

  // Account contact (TM-783): the email + phone this account is registered with.
  const contact = accountContact(profile);
  hub.email.textContent = contact.email || "No email on file";
  hub.phone.textContent = contact.phoneDisplay;
  // A missing phone reads as a muted prompt, not a real value.
  hub.phone.classList.toggle("tm-pf-contact-empty", !contact.hasPhone);
  hub.email.classList.toggle("tm-pf-contact-empty", !contact.email);

  // Completeness: the photo counts too, read live off the same photoURL as the identity avatar above
  // (the single source of truth) rather than anything persisted on our side.
  const strength = profileStrength(profile, { hasPhoto: Boolean(photoURL) });
  // TM-913: drive the progress RING. The fill arc's dash-offset = C · (1 − percent/100) so the visible
  // arc is exactly `percent` of the circle; the centre label shows the bare percent (the word "complete"
  // stays in the nudge line below, per the agreed default). The aria progressbar semantics live on the
  // ring container — set valuenow + a spoken valuetext so a screen reader announces the live strength.
  hub.ringArc.style.strokeDashoffset = String(strengthRingGeometry(strength.percent, RING_R).dashoffset);
  hub.barPct.textContent = `${strength.percent}%`;
  hub.ring.setAttribute("aria-valuenow", String(strength.percent));
  hub.ring.setAttribute("aria-valuetext", `${strength.percent}% complete`);
  // The nudge points at the first gaps — each one a tappable jump to its field (TM-881); at 100% it
  // reads as a reassurance and we drop the arrow.
  paintStrengthNudge(hub.barNudge, strength);

  // Interests card (TM-778) — repaint the saved-interest chips from the same /me payload.
  paintInterests(profile);

  // TM-777 (I5): the next-day completeness nudge — a quiet, once-a-day CTA to add more interests when
  // the user has picked exactly one. Pure decision (clock, stored last-prompt day, and the real
  // interests max injected); the CTA button is hidden by default and only revealed when it's due.
  const i5 = nextDayInterestsNudge(profile, {
    now: new Date(),
    lastPromptISO: readLastInterestsPrompt(),
    // The real interests max — reuse the SAME best-effort config the interests card fetched
    // (state.interestConfig, from GET /api/v1/interests/config via loadInterestsMeta; defaults to the
    // seeded max when that read failed) so "add N more" names the true bound, tracking an admin change.
    max: state.interestConfig.max,
  });
  hub.barInterestsCta.hidden = !i5.show;
  if (i5.show) {
    hub.barInterestsCta.textContent = i5.message;
    // Stamp "shown today" so the same-day suppression fires on the next paint (don't nag twice a day).
    recordInterestsPromptShown(new Date().toISOString());
  }
}

/**
 * The DOM id a strength-gap key (profile-core STRENGTH_FIELDS) jumps to when its "Add …" prompt is
 * activated (TM-881). Name/city/age/phone map straight onto their `profile-<field>` controls (city
 * is the TM-877 SELECT — focusable like any input). Photo has no form field: it targets the avatar
 * control — the native capture button when the Capacitor shell built one (the web file input is
 * hidden there, TM-281), else the file input itself. Resolved at CLICK time, not render time, so it
 * follows whatever avatar control the current platform actually rendered.
 *
 * @param {string} key a `profileStrength().gaps[].key`
 * @returns {string} the id to hand to focusOnPage.
 */
function strengthGapTarget(key) {
  if (key === "photo") {
    return document.getElementById("profile-avatar-camera") ? "profile-avatar-camera" : "profile-avatar-file";
  }
  return { name: "profile-firstName", city: "profile-city", age: "profile-age", phone: "profile-phone" }[key];
}

/**
 * Render the strength card's "what's missing" nudge (TM-881). Keeps the shipped copy shape — at
 * most the first two gaps, "Add <gap> + <gap> →" — but each named gap is now a REAL button (not the
 * old inert span text) that scrolls to and focuses its field via the same focusOnPage the menu rows
 * and the interests CTA use. Real <button>s give keyboard reach + Enter/Space activation for free;
 * the aria-label restores the "Add" verb a screen reader would otherwise miss ("a phone" alone).
 * At 100% the nudge is pure reassurance — text only, no controls, no arrow.
 *
 * @param {HTMLElement} node the nudge container (shell.hub.barNudge).
 * @param {ReturnType<typeof profileStrength>} strength the current strength model.
 */
function paintStrengthNudge(node, strength) {
  node.textContent = ""; // wipe the previous paint (text or buttons) before rebuilding
  if (strength.complete) {
    node.textContent = strength.nudge;
    return;
  }
  const named = strength.gaps.slice(0, 2); // the nudge names at most two gaps (the profile-core rule)
  node.append("Add ");
  named.forEach((gap, i) => {
    if (i > 0) node.append(" + ");
    node.append(
      el("button", {
        type: "button",
        class: "tm-pf-nudge-gap",
        "aria-label": `Add ${gap.label}`,
        onClick: () => focusOnPage(strengthGapTarget(gap.key)),
      }, gap.label),
    );
  });
  node.append(" →");
}

// ---- interests card (TM-778) -----------------------------------------------------------------

/**
 * Repaint the Interests card body from a MeResponse: one removable chip per saved interest plus the
 * single PERSISTENT entry chip into the in-place picker (TM-970). Below the max the chip reads "＋ add";
 * AT the max it relabels to "Manage" — the SAME control opening the SAME picker — so a user with all
 * slots filled can still open it to remove/swap (previously the chip vanished at the cap, dead-ending
 * the only route to the picker). Reads the saved interests off `profile.interests` and the min/max
 * bounds off `state.interestConfig` (best-effort GET config, else defaults). Purely a map over the
 * unit-tested `interestChipsModel` — the label/visibility decision lives in `addChipModel` there.
 */
function paintInterests(profile) {
  const body = shell?.interestsBody;
  if (!body) return;
  // Pass the offered catalogue (TM-805) so each saved chip resolves its leading emoji by label — the
  // saved MeResponse.interests carry no emoji, so the glyph is looked up against the catalogue the ADD
  // picker already loaded (best-effort; no catalogue → label-only chips, exactly as before).
  const model = interestChipsModel(profile?.interests, { ...state.interestConfig, catalogue: state.interestCatalogue });
  clear(body);

  const chips = el("div", { class: "tm-pf-chips" });
  for (const chip of model.chips) {
    // Leading catalogue emoji (TM-805), rendered only when present. Decorative → aria-hidden.
    const emojiSpan = chip.emoji
      ? el("span", { class: "tm-pf-chip-emoji", "aria-hidden": "true", text: chip.emoji })
      : null;
    // A saved interest renders as a filled (accent) chip. When removable, it carries a "×" remove
    // control; at the minimum the chip stays but is non-removable (removing would 400 server-side).
    if (chip.removable) {
      chips.append(
        el("button", {
          type: "button",
          class: "tm-pf-chip tm-pf-chip-on tm-pf-chip-remove",
          "aria-label": `Remove ${chip.label}`,
          disabled: state.interestsSaving,
          onClick: () => removeInterest(chip.label),
        }, [emojiSpan, el("span", { text: chip.label }), el("span", { class: "tm-pf-chip-x", "aria-hidden": "true", text: "×" })]),
      );
    } else {
      chips.append(el("span", { class: "tm-pf-chip tm-pf-chip-on" }, [emojiSpan, el("span", { text: chip.label })]));
    }
  }
  // The persistent entry chip into the in-place picker (TM-970): "＋ add" below the max, "Manage" at
  // the max — same control, same picker, so there's never a dead-end where the only route to swap an
  // interest is hidden. The at-max variant carries a -manage modifier for its distinct (non-dashed)
  // styling. Label + action come from the unit-tested addChipModel via model.entry.
  if (model.entry.show) {
    chips.append(
      el("button", {
        type: "button",
        class: model.entry.action === "manage"
          ? "tm-pf-chip tm-pf-chip-add tm-pf-chip-manage"
          : "tm-pf-chip tm-pf-chip-add",
        "aria-label": model.entry.action === "manage" ? "Manage interests" : "Add interests",
        disabled: state.interestsSaving,
        onClick: openInterestPicker,
      }, model.entry.label),
    );
  }
  body.append(chips);
  body.append(el("p", { class: "tm-muted tm-pf-hint", text: model.hint }));
}

/**
 * Load the interests metadata (min/max config + the catalogue for the ADD picker) after the profile
 * itself has painted. Both come from the PUBLIC picker read endpoints (GET /api/v1/interests/config and
 * /catalogue, TM-776) — any signed-in user may read them, so a normal (non-admin) user gets the real
 * catalogue and bounds. Kept BEST-EFFORT anyway: those api.js helpers THROW on a non-2xx, so the whole
 * read is wrapped so a transient failure just leaves the default bounds / an "unavailable" ADD state —
 * the VIEW + REMOVE paths never depend on these, and the backend PATCH /me stays the authoritative gate.
 * Repaints the card once the config lands so the bounds (hence the chip removability + hint) reflect the
 * server config.
 */
async function loadInterestsMeta({ repaint = true } = {}) {
  try {
    const [config, catalogue] = await Promise.all([getInterestConfig(), getInterestCatalogue()]);
    state.interestConfig = normaliseInterestConfig(config);
    state.interestCatalogue = catalogue; // the public catalogue array (active rows, highlights-first)
  } catch (err) {
    // A failed read degrades to the defaults / an unavailable picker rather than breaking the card.
    // Reset to the default bounds (not a stale earlier value) so a FAILED refresh across a load()
    // re-entry can't leave the card — or the TM-777 nudge copy — pinned to an out-of-date max.
    state.interestConfig = normaliseInterestConfig(null);
    state.interestCatalogue = null;
    console.warn("[profile] GET /api/v1/interests catalogue/config failed:", err?.message ?? err);
  }
  // Repaint with the real bounds now they're known (they affect removability + the hint copy). Skipped
  // (repaint:false) when load() fetched this BEFORE the first paint — fillForm→paintHub then paints the
  // card + the TM-777 nudge with the bounds already in place, avoiding a redundant (and nudge-hiding,
  // once same-day-stamped) second paintHub.
  if (repaint && state.profile) paintInterests(state.profile);
}

/** Persist a new interests set via PATCH /me, then repaint from the returned MeResponse. */
async function saveInterests(labels) {
  if (state.interestsSaving) return;
  state.interestsSaving = true;
  if (state.profile) paintInterests(state.profile); // disable the chips while the PATCH is in flight
  try {
    const updated = await updateMe({ interests: labels });
    state.profile = updated;
    fillForm(updated); // repaints the whole hub (incl. the interests card) from the fresh /me
    toast("Interests updated.", { type: "success", timeout: 2000 });
  } catch (err) {
    // The backend is the authoritative min/max + catalogue gate; surface its RFC-7807 detail verbatim
    // (e.g. "at least 1" / "at most 3" / "Unknown or retired interest").
    const message = err instanceof ApiError ? err.message : "Couldn't update your interests. Please try again.";
    toast(message, { type: "error" });
  } finally {
    state.interestsSaving = false;
    if (state.profile) paintInterests(state.profile);
  }
}

/** Remove one saved interest: PATCH /me with the reduced label set (min-gated by the chip render). */
function removeInterest(label) {
  const remaining = savedInterestLabels(state.profile?.interests).filter((l) => l !== label);
  return saveInterests(remaining);
}

/**
 * Open the catalogue ADD picker — a modal of the grouped, offered interests as toggle chips, with a
 * live selection count and a Save that PATCHes the whole chosen set. Starts from the caller's currently
 * saved interests so the picker doubles as an editor. When the catalogue can't be read (a transient
 * failure on the public catalogue endpoint — see the api.js note), the modal explains the ADD picker
 * isn't available yet rather than showing an empty list, so the affordance never silently does nothing.
 */
function openInterestPicker() {
  const max = state.interestConfig.max;
  const catalogue = state.interestCatalogue;

  // No readable catalogue → honest "not available yet" body (VIEW + REMOVE still work on the card).
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    modal(
      "Add interests",
      el("div", { class: "tm-pf-picker-empty" }, [
        el("p", { text: "The interests list isn't available right now. Please try again later." }),
      ]),
    );
    return;
  }

  // Pending selection seeded from the saved set; Save PATCHes it. `let` so the toggle handlers can swap
  // it and refresh the picker's selection state in place.
  let selected = savedInterestLabels(state.profile?.interests);
  const bodyWrap = el("div", { class: "tm-pf-picker" });
  const dialog = modal("Add interests", bodyWrap);

  // ── TM-860: the picker body is built ONCE; toggles repaint IN PLACE. ────────────────────────────
  // The old renderPicker() clear(bodyWrap)-and-rebuilt every chip on each toggle. Wiping the scroll
  // container's content collapses its height mid-frame, and real mobile engines (iOS Safari / Android
  // WebView — NOT desktop Chromium, which rebuilds synchronously and keeps scrollTop) clamp
  // .tm-modal-body's scrollTop to 0 — so selecting a chip near the bottom bounced the user back to the
  // top of the list. Instead we keep handles to every selection-dependent node and mutate only those,
  // mirroring onboarding.js's paintChip pattern (which is why onboarding never had this bug).
  const chipHandles = []; // { label, button } for every catalogue chip, in render order
  let countNode = null; //  the "N of max selected" line
  let errorNode = null; //  the selection-error line (always present; hidden when the set is savable)
  let saveBtn = null; //    the Save button (disabled while the selection violates min/max)

  /**
   * Repaint everything that depends on `selected`, WITHOUT touching the DOM structure: each chip's
   * on/off modifier + aria-pressed, the at-max dimming of the *other* chips, the count line, and the
   * error + Save-disabled pair. Same rules the initial build used (catalogueGroups/selectionError) —
   * this is just those decisions re-applied to the existing nodes.
   */
  const refreshPicker = () => {
    const chosen = new Set(selected);
    const atMax = chosen.size >= max;
    countNode.textContent = `${chosen.size} of ${max} selected`;
    for (const { label, button } of chipHandles) {
      const on = chosen.has(label);
      // Like onboarding's paintChip: `.tm-pf-chip-on` is a MODIFIER layered on the base `.tm-pf-chip`
      // (which carries the padding/border) — toggle only the modifier, never the base class.
      button.classList.toggle("tm-pf-chip-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      // Disabled only at the cap AND not selected (deselecting to make room must always stay possible)
      // — the same predicate catalogueGroups computes for its options' `disabled` flag.
      button.disabled = atMax && !on;
    }
    const err = selectionError(selected, state.interestConfig);
    errorNode.textContent = err;
    errorNode.hidden = !err;
    saveBtn.disabled = Boolean(err);
  };

  // Build the static structure once: the count line, the grouped chips, and the actions row. All
  // selection-dependent state (on/off, disabled, count, error) is painted by refreshPicker() below —
  // one source of truth, so the initial paint and every toggle repaint can never drift apart.
  const { groups } = catalogueGroups(catalogue, selected, { max });
  countNode = el("p", { class: "tm-muted tm-pf-picker-count" });
  bodyWrap.append(countNode);
  for (const group of groups) {
    bodyWrap.append(el("h4", { class: "tm-pf-picker-cat", text: group.category }));
    const row = el("div", { class: "tm-pf-chips" });
    for (const opt of group.options) {
      // Leading catalogue emoji (TM-805) on the picker chip, only when the row carries one.
      const emojiSpan = opt.emoji
        ? el("span", { class: "tm-pf-chip-emoji", "aria-hidden": "true", text: opt.emoji })
        : null;
      const button = el("button", {
        type: "button",
        class: "tm-pf-chip tm-pf-picker-opt",
        onClick: () => {
          selected = toggleInterest(selected, opt.label, { max });
          refreshPicker(); // in place — never clear/rebuild, so the body's scroll position survives
        },
      }, [emojiSpan, el("span", { text: opt.label })]);
      chipHandles.push({ label: opt.label, button });
      row.append(button);
    }
    bodyWrap.append(row);
  }
  // The error line is ALWAYS in the tree (hidden when savable) so refreshPicker only flips text +
  // hidden — inserting/removing it per toggle would be a structural change again. role="alert" makes
  // a newly-revealed message announce itself to assistive tech.
  errorNode = el("p", { class: "tm-field-error", role: "alert", hidden: true });
  saveBtn = el("button", {
    type: "button",
    class: "tm-btn tm-btn-primary",
    onClick: async () => {
      dialog.close();
      await saveInterests(selected);
    },
  }, "Save");
  bodyWrap.append(el("div", { class: "tm-pf-picker-actions" }, [errorNode, saveBtn]));
  refreshPicker();
}

/** Build the PATCH body: trimmed values, age coerced to a number; blank fields are omitted. */
function collectPatch() {
  const patch = {};
  for (const field of FIELDS) {
    const entry = shell.fields.get(field.key);
    const raw = (entry.input.value ?? "").trim();
    if (field.key === "phone") {
      // TM-781: storage is E.164, composed from the picker + national input on save. composeE164
      // returns "" for a blank national number — so blank stays blank (omitted, matching the
      // untouched-means-no-change PATCH semantics) and a dial-code-only "+44" can never be sent.
      // An unconfirmed country with a number present also composes to "", but validateAll() has
      // already blocked that path before collectPatch runs.
      const composed = composeE164(entry.country ? entry.country.value : "", raw);
      if (composed !== "") patch[field.key] = composed;
      continue;
    }
    if (field.type === "number") {
      // Only send age when present; an empty number field means "no change" rather than 0.
      // TM-884 grandfather: an UNCHANGED age is omitted too — re-saving the form must not turn the
      // pre-filled saved age into a "new" attestation the tightened 18–99 backend range would
      // reject for a grandfathered (13–120 era) account. Only an actual edit is sent.
      if (raw !== "" && !(state.profile?.[field.key] != null && Number(raw) === Number(state.profile[field.key]))) {
        patch[field.key] = Number(raw);
      }
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
    // Fetch /me AND the interests metadata (TM-778 config + catalogue) in parallel, so the FIRST hub
    // paint already has the real min/max bounds. This matters for the TM-777 (I5) next-day nudge: its
    // copy names `state.interestConfig.max`, and paintHub stamps "shown today" the once it fires — so
    // the max must be known BEFORE that single paint (a later repaint would be suppressed same-day and
    // hide the just-shown CTA). loadInterestsMeta is best-effort (swallows its own errors), so a config
    // failure just leaves the default bounds; getMe's own failure still lands in the catch below.
    const [profile] = await Promise.all([getMe(), loadInterestsMeta({ repaint: false })]);
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
    // TM-1005: a saved phone CHANGE alters what the re-verify grace banner should say (the new stored
    // number was just verify-and-linked, TM-982, so the banner's "verify your phone" nag is now stale).
    // Ask it to re-check itself instead of leaving it wrong until the next auth change. Loose global
    // seam — a safe no-op wherever the notice module isn't loaded (tests, native shells).
    if ("phone" in patch && typeof window !== "undefined") window.tmPhoneReverifyNotice?.refresh?.();
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
      // TM-846: ONE broadcast repaints EVERY avatar surface — the nav chip (nav-avatar.js
      // subscribes), this control's own preview and the identity header + strength % (the
      // module-level subscription below buildAvatar) — so no surface is left stale until reload.
      announceAvatarChanged();
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

// TM-846: this page's avatar surfaces repaint on the avatar-changed broadcast — the upload control's
// own preview AND the identity header + strength % (paintHub reads photoURL live, so `hasPhoto` and
// the "a photo" gap correct themselves the moment the upload lands, no reload). Registered ONCE at
// module level (never per buildShell — that would stack a listener per page entry); the optional
// chaining makes it a safe no-op when the profile screen isn't mounted, and the state.profile guard
// keeps a load-error page from being repainted with blank identity data.
onAvatarChangedEvent(() => {
  shell?.avatar?.refresh();
  if (shell?.hub && state.profile) paintHub(state.profile);
});

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
  input.addEventListener("input", () => {
    // TM-982: editing the phone un-verifies it (the proof was for the OLD digits, so the user must
    // re-send + re-confirm) AND drops any in-flight code — an edit made in the send→confirm window
    // would otherwise leave the OTP boxes live for the OLD number and let an unverified number pass.
    // When locked/readOnly no input event fires, so this runs only while the field is editable.
    if (field.key === "phone" && (phoneVerify.verified || phoneVerifyInFlight())) unverifyPhone();
    setFieldError(field.key, validateField(field, input.value));
    // Re-evaluate the "changed number needs verify" affordance after every phone edit.
    if (field.key === "phone") refreshPhoneVerifyAffordance();
  });

  // TM-781: the phone field gets a mandatory country picker rendered BEFORE the national-number
  // input. Options read "<emoji flag> <Country name> +<dial>" from the curated countries.js list
  // (GB then AE pinned, rest name-sorted); the flags are Unicode regional-indicator emoji, so the
  // self-only CSP needs no external assets. The leading "Confirm country…" placeholder is disabled
  // + hidden: only fillPhoneField can select it PROGRAMMATICALLY (the legacy bare-number confirm
  // state) — a user can never move the picker back to "no country", so it always holds a selection
  // and a number can never be composed without one.
  let country = null;
  if (field.key === "phone") {
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
    // A concrete default so the picker is never empty pre-load; fillPhoneField applies the real
    // selection (saved-phone country / city soft-default) once /me lands.
    country.value = "GB";
    country.addEventListener("change", () => {
      // An explicit user pick is sticky: fillPhoneField's soft default must never override it.
      country.setAttribute("data-user-picked", "true");
      // TM-982: switching the dial code changes the composed E.164, so any prior/in-flight verification
      // no longer applies — un-verify (unlock + hide the OTP) and require a fresh send + confirm.
      if (phoneVerify.verified || phoneVerifyInFlight()) unverifyPhone();
      // Re-validate the pair so picking a country clears the legacy confirm-country prompt live.
      setFieldError(field.key, validateField(field, input.value));
      refreshPhoneVerifyAffordance();
    });
  }

  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const hint = field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null;

  // A "fill" field (timezone/locale) gets a one-tap button that drops in the browser's best guess,
  // then re-validates so any stale inline error clears (TM-167 union — from the #162 build).
  // The phone field reuses the same committed flex-row style to seat the picker beside the input.
  const control = country
    ? el("div", { class: "tm-field-fill tm-phone-row" }, [country, input])
    : field.fill
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

  // TM-982: the phone field grows a verify-and-link step — a "Send code" button (revealed only when the
  // number CHANGED), a profile-local invisible reCAPTCHA host, a six-box OTP group (revealed on send), a
  // resend link, and a "Verified ✓" status line. Built with el()/attachOtpInput; controllers on
  // `phoneVerify`. No verify controls on any other field.
  const verifyNodes = field.key === "phone" ? buildPhoneVerify(id, describedBy) : [];

  const wrapper = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: id, text: field.label }),
    control,
    hint,
    error,
    ...verifyNodes,
  ]);
  // `country` is only present for the phone field (TM-781) — undefined elsewhere.
  return { wrapper, input, error, country };
}

/**
 * Build + wire the TM-982 phone verify controls and stash their handles on `phoneVerify`. Returns the
 * DOM nodes to append inside the phone field wrapper (send button, OTP reveal, status line, and the
 * hidden reCAPTCHA host). Uses only el()/attachOtpInput — no innerHTML. Mirrors the onboarding gate's
 * buildPhoneVerify (TM-930), minus the gate-only "Change number" / "adopt verified" affordances: on the
 * profile form the number stays editable, so an ordinary edit of the input/picker un-verifies it — the
 * input/picker listeners in buildField do that — and there is no locked-out state to escape from.
 */
function buildPhoneVerify(id, describedBy) {
  // Six single-char boxes (TM-867 shape: class="auth-otp-box" in a role="group"); the first carries the
  // one-time-code autocomplete for OS autofill. ids prefixed `${id}-otp` so they're inspectable.
  const boxes = Array.from({ length: 6 }, (_, i) =>
    el("input", {
      id: i === 0 ? `${id}-otp` : `${id}-otp-${i + 1}`,
      class: "auth-otp-box",
      type: "text",
      inputmode: "numeric",
      // No maxLength: the TM-867 widget's distribute() fans a full pasted/autofilled/programmatic code
      // out from box 0 across all six — a maxLength=1 would truncate that whole-code write to one char.
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
    hidden: true, // shown by refreshPhoneVerifyAffordance only once the number actually changes
    "aria-describedby": describedBy,
  });

  const statusEl = el("p", { id: `${id}-verified`, class: "tm-field-hint tm-phone-status", role: "status", hidden: true });

  // TM-1018: the cross-account collision recovery affordance — the SAME "Is this your number? Contact
  // support" escape hatch the onboarding gate carries (TM-987), shared verbatim from phone-reverify-core
  // so the two surfaces can't drift. Hidden until a verify collides ("already registered"); it's a
  // mailto to support (the TM-987 runbook path) so a user whose genuinely-owned number is stuck on an
  // old account isn't left at a dead end on the ONLY verify surface the retro cohort can reach during
  // the grace window. Built with el() (textContent only — XSS-safe); the <a> is keyboard-reachable + SR-announced.
  const recoveryEl = el(
    "p",
    { id: `${id}-recovery`, class: "tm-field-hint tm-phone-recovery", role: "status", hidden: true },
    [
      PHONE_RECOVERY_PROMPT,
      el("a", {
        class: "tm-phone-recovery-link",
        href: PHONE_RECOVERY_MAILTO,
        text: PHONE_RECOVERY_LINK_TEXT,
      }),
      PHONE_RECOVERY_SUFFIX,
    ],
  );

  // The profile-local invisible reCAPTCHA host — the login one (#recaptcha-container) lives in the login
  // view, which isn't mounted here. Firebase renders the invisible widget into this element.
  const recaptcha = el("div", { id: `${id}-recaptcha`, class: "tm-phone-recaptcha", "aria-hidden": "true" });

  sendBtn.addEventListener("click", () => sendPhoneCode());
  resendBtn.addEventListener("click", () => {
    if (phoneVerify.cooldown?.isActive()) return; // synthetic-click guard (matches login.js / the gate)
    sendPhoneCode();
  });

  phoneVerify.sendBtn = sendBtn;
  phoneVerify.otpWrap = otpWrap;
  phoneVerify.statusEl = statusEl;
  phoneVerify.recoveryEl = recoveryEl;
  phoneVerify.recaptcha = recaptcha;
  // The six-box widget auto-submits through confirmPhoneOtp on the sixth digit (TM-867 onComplete),
  // exactly like login.js's SMS step / the onboarding gate — no explicit verify click.
  phoneVerify.otp = attachOtpInput({ group: otpGroup, onComplete: (code) => confirmPhoneOtp(code) });
  phoneVerify.cooldown = attachResendCooldown({ button: resendBtn, codeNoun: "SMS code" });
  phoneVerify.built = true;

  return [sendBtn, statusEl, recoveryEl, otpWrap, recaptcha];
}

/** Show/hide the TM-1018 cross-account collision recovery affordance (contact-support link). */
function setPhoneRecoveryVisible(visible) {
  if (phoneVerify.recoveryEl) phoneVerify.recoveryEl.hidden = !visible;
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

// ── Profile-strength progress ring (TM-913) ──────────────────────────────────────────────────────
// The completeness ring's geometry. A 0..100 viewBox with a generous radius keeps the stroke crisp at
// any DPI (SVG is resolution-independent) and gives room for the border-width stroke without clipping.
// The circumference is the dasharray total; paintHub() sets dashoffset = C · (1 − percent/100) so the
// visible arc is exactly `percent` of the circle (dashoffset C = empty, 0 = full).
const RING_R = 42;
const RING_C = strengthRingGeometry(0, RING_R).circumference; // ≈ 263.894 (dasharray total)

const SVG_NS = "http://www.w3.org/2000/svg";
/** SVG-namespaced element (createElement can't make real SVG). setAttribute-only → XSS-safe like el(). */
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * Build the profile-strength progress ring (TM-913). Returns the ring container (a labelled
 * role="progressbar"), the fill `arc` (a <circle> whose stroke-dashoffset paintHub() drives to the
 * percent) and the centred `pct` <span> (the visible label paintHub() fills, e.g. "87%").
 *
 * a11y: the container is the progressbar — aria-valuemin/max are fixed (0..100); paintHub() sets
 * aria-valuenow + aria-valuetext to the live percent. The centre percent IS the visible label, so the
 * bar carries no separate visible caption. Decorative SVG is aria-hidden (the semantics live on the
 * container), so a screen reader announces one "N%, progressbar" node, not the raw circles.
 *
 * @returns {{ ring: HTMLElement, arc: SVGCircleElement, pct: HTMLElement }}
 */
function strengthRing() {
  // The track (full faint circle) + the fill arc (accent, dash-clipped to `percent`). Rotated −90° so
  // the arc starts at 12 o'clock and fills clockwise (the familiar completeness-donut direction).
  const track = svgEl("circle", { class: "tm-pf-ring-track", cx: 50, cy: 50, r: RING_R });
  const arc = svgEl("circle", {
    class: "tm-pf-ring-arc",
    cx: 50, cy: 50, r: RING_R,
    "stroke-dasharray": RING_C,
    // Start fully offset (0% fill) so nothing paints before paintHub() lands the real strength — the
    // skeleton overlays it while loading, and the fill then animates from 0 to the percent.
    "stroke-dashoffset": RING_C,
  });
  const svg = svgEl("svg", { class: "tm-pf-ring-svg", viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" });
  svg.append(track, arc);

  // The centred percent — the visible label. Starts BLANK (TM-663: no misleading concrete "0%" before
  // /me resolves); paintHub() fills it once real strength lands.
  const pct = el("span", { class: "tm-pf-ring-pct", text: "" });

  const ring = el("div", {
    class: "tm-pf-ring",
    role: "progressbar",
    "aria-label": "Profile strength",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  }, [svg, pct]);
  return { ring, arc, pct };
}

/** A titled card matching the paper-profile card (border + offset shadow via tokens). */
function pfCard(title, children, extraClass = "") {
  return el("section", { class: `tm-pf-card ${extraClass}`.trim() }, [
    title ? el("h3", { class: "tm-pf-ctitle", text: title }) : null,
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

/** One paper-profile menu row: a label with a chevron. `to` = hash link; `onClick` = in-page action.
 *  `id` (optional) stamps a stable DOM id on the row — the sign-out row carries one (TM-906) so the
 *  e2e suite can drive the ONLY sign-out entry without coupling to label text. */
function menuRow(label, { to = null, onClick = null, muted = false, id = null } = {}) {
  const chev = el("span", { class: "tm-pf-chev", "aria-hidden": "true", text: "›" });
  const cls = `tm-pf-menu-row${muted ? " tm-pf-menu-muted" : ""}`;
  const props = id ? { class: cls, id } : { class: cls };
  if (to) return el("a", { ...props, href: to }, [el("span", { text: label }), chev]);
  return el("button", { ...props, type: "button", onClick }, [el("span", { text: label }), chev]);
}

/** Scroll a same-page element into view and focus it (Notifications / Privacy menu rows). */
function focusOnPage(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  if (typeof node.focus === "function") node.focus({ preventScroll: true });
}

/** Sign the user out — the hub menu's "Sign out" row is the ONLY sign-out entry in the app (TM-906;
 *  the old top-nav control is gone). Always confirm first via the styled ui.js confirmDialog (never
 *  native confirm()): cancel/Escape/backdrop = no-op, session intact; confirm calls auth signOut(),
 *  which fires onAuthChanged(null) → the TM-720 onSignedOut reset chain, untouched and unreordered. */
async function doSignOut() {
  const confirmed = await confirmDialog({
    title: "Sign out?",
    message: "You'll need your code to sign back in.",
    confirmLabel: "Sign out",
    danger: true,
  });
  if (!confirmed) return;
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
    // `country` is the phone field's TM-781 picker (undefined for every other field) — kept in the
    // shell so validateField/collectPatch/fillPhoneField can read the selected iso2.
    fields.set(field.key, { input: built.input, error: built.error, country: built.country });
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

  // TM-907 name-lock note: a visible explanation shown ABOVE the form actions when the account's name
  // is locked (event history). Hidden by default; applyNameLock() reveals it. role="status" so a
  // screen reader announces it when it appears — the lock is communicated as text, not by colour alone
  // (the read-only fields also carry aria-readonly + a disabled look).
  const nameLockNote = el(
    "p",
    {
      class: "tm-muted tm-namelock-note",
      id: "profile-namelock-note",
      role: "status",
      hidden: true,
      text: "Names are locked after your first event — contact support to correct.",
    },
  );

  const form = el("form", { class: "tm-profile-form", id: "profile-form", novalidate: true, onSubmit: save }, [
    avatar.wrapper,
    el("div", { class: "tm-form-grid" }, fieldNodes),
    nameLockNote,
    el("div", { class: "tm-form-actions" }, [saveBtn, reset]),
  ]);

  const status = el("div", { id: "profile-status" });

  // ── Identity header (paper-profile) ── avatar + name + "City · age". Painted by paintHub().
  // The name/meta start BLANK (not the "Your profile" placeholder) so the pre-load render never shows
  // a concrete, misleading empty-profile identity for an established user (TM-663) — the CSS skeleton
  // (.tm-pf-loading) fills the gap until paintHub() lands the real values from /me. The 🙂 glyph is the
  // genuine no-avatar fallback (not a wrong value), and it's hidden behind the skeleton while loading.
  // TM-846: the circle holds a glyph AND a photo <img> (mirroring buildAvatar's initial+image pair);
  // paintHub shows exactly one of them from the live photoURL, so this header is a real avatar surface
  // that the avatar-changed broadcast keeps fresh.
  const hubGlyph = el("span", { class: "tm-pf-avatar-glyph", "aria-hidden": "true", text: "🙂" });
  const hubPhoto = el("img", { class: "tm-pf-avatar-photo", alt: "", hidden: true });
  const hubAvatar = el("span", { class: "tm-pf-avatar", "aria-hidden": "true" }, [hubGlyph, hubPhoto]);
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
    hubAvatar,
    el("div", {}, [hubName, hubMeta, hubContact]),
  ]);

  // ── Profile strength (paper-profile) ── the restyled completeness prompt. Painted by paintHub().
  // TM-913: the completeness reads as a circular progress RING (SVG circle + stroke-dasharray/-dashoffset)
  // instead of a horizontal bar — the familiar fitness-ring/donut pattern, in the paper hand-drawn style.
  // `bar` (the ring's fill arc) + `barPct` (the centred percent) are STILL the paintHub() targets, so the
  // strength data source (profileStrength().percent) and the nudge/gap-link path are untouched.
  // The percentage starts BLANK (not "0%") so a loaded user never sees a misleading concrete 0% for a
  // heartbeat before /me resolves (TM-663) — the skeleton (.tm-pf-loading) overlays the ring until
  // paintHub() lands the real strength; the fill arc starts fully offset (0%) while loading.
  const { ring, arc: bar, pct: barPct } = strengthRing();
  const barNudge = el("span", { class: "tm-pf-barnudge", text: "" });
  // ── Next-day interests CTA (TM-777 / I5) ── a quiet, link-styled button under the strength label
  // (reuses the muted tm-pf-barnudge/tm-pf-go idiom — NOT a loud primary button). A real <button> so it's
  // keyboard-focusable; `hidden` by default and revealed by paintHub() only when the once-a-day nudge is
  // due. Clicking it smooth-scrolls to the interests card (focusOnPage), the same affordance the menu rows
  // use. Lives INSIDE the strength card so it reads as part of the completeness prompt, not a new section.
  const barInterestsCta = el("button", {
    class: "tm-pf-nudge-interests tm-pf-go",
    type: "button",
    hidden: true,
    onClick: () => focusOnPage("profile-interests"),
  });
  const strengthCard = pfCard("Profile strength", [
    ring,
    // The nudge/"all set" line keeps its own row BELOW the ring (TM-913 agreed default: ring only, the
    // percent lives in the ring centre; the "complete"/gap copy stays here). barPct is the ring's centre
    // label, so the label row now carries only the nudge (which still wraps on a narrow phone).
    el("div", { class: "tm-pf-barlbl" }, [barNudge]),
    barInterestsCta,
  ]);

  // ── Interests (paper-profile) ── the REAL card (TM-778, I6): it VIEWs the caller's saved interests
  // from MeResponse.interests and lets them ADD/REMOVE within the configured min/max, persisted via
  // PATCH /api/v1/me (the TM-775 user-selection API). The card body is an empty container that
  // paintInterests() fills once /me (and the best-effort config/catalogue) have loaded; until then the
  // hub skeleton (.tm-pf-loading) covers it. reconcile with TM-511 component library (chip component).
  // The body carries id="profile-interests" — the TM-777 (I5) deep-link target the strength-card nudge
  // CTA scrolls to via focusOnPage("profile-interests"), so that shared contract keeps working.
  const interestsBody = el("div", { class: "tm-pf-interests", id: "profile-interests" });
  const interestsCard = pfCard("Interests", [interestsBody]);

  // ── Membership (paper-profile) ── the tier row reflects the caller's REAL membership (TM-643): the
  // sub text is painted from GET /me/membership in load() via paintMembership() (through the pure
  // profileMembershipRow mapping) rather than a hardcoded "Pay as you go" — so a Monthly/Diamond
  // subscriber sees their actual tier. It starts on the free-base default and is corrected once the
  // membership resolves. "Manage" is a live link to the membership screen (#/membership) when the
  // membership feature flag is ON; while the flag is OFF that route is inert (router.js gates it), so
  // the row shows an unambiguous "Coming soon" badge instead (TM-882) — a muted link-styled "Manage →"
  // that did nothing read as a dead link. The pure profileManageAffordance() decides; this only paints
  // (the badge reuses the tier cards' coming-soon pill from membership-tier.css, loaded globally).
  const membershipSub = el("div", { class: "tm-pf-sub", text: profileMembershipRow(null).text });
  const manage = profileManageAffordance(membershipEnabled());
  const membershipManage =
    manage.kind === "link"
      ? el("a", { class: "tm-pf-go", href: manage.href, text: manage.label })
      : el("span", { class: "tm-tier-badge tm-tier-badge-soon", text: manage.label });
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
  // Sign out is a real action; Notifications / Privacy scroll to the relevant on-page control (no
  // fabricated routes). Public profile → the additive #/profile/public preview. (TM-1028: the old
  // "My events" row was removed — it just re-opened #/events, a plain duplicate of the Events tab.)
  const menuCard = pfCard(
    null,
    [
      el("nav", { class: "tm-pf-menu", "aria-label": "Profile menu" }, [
        menuRow("Notifications", { onClick: () => focusOnPage("profile-notificationPref") }),
        menuRow("Public profile", { to: PROFILE_PUBLIC_ROUTE }),
        menuRow("Privacy & my data", { onClick: () => focusOnPage("profile-settings") }),
        menuRow("Sign out", { onClick: doSignOut, muted: true, id: "profile-signout-row" }),
      ]),
    ],
    "tm-pf-menu-card",
  );

  // The screen mounts with `tm-pf-loading` so the identity + strength area renders as a skeleton
  // (CSS shimmer, no concrete text) until the first /me paint. paintHub() removes the class when real
  // data lands; renderStatus() also removes it on a load error so the skeleton never hangs (TM-663).
  const root = el("div", { class: "tm-pf tm-pf-loading" }, [
    el("header", { class: "tm-pf-topbar" }, [
      // The visible "Profile" word is redundant — the bottom Profile tab (active) labels the screen and
      // the identity header (avatar + name) right below self-identifies it (Basit, product call). So the
      // <h2> is kept in the DOM (visually-hidden / sr-only) as the screen's heading + landmark for screen
      // readers and heading navigation, but not rendered — the screen leads visually with the identity
      // header. The host-badge doodle (TM-215, decorative, sketchy-toggle-only) goes with it rather than
      // being left orphaned. NOTE: it stays inside .tm-pf-topbar so the corner-bell / .tm-pf-gear layout
      // (TM-910) is untouched — only its visibility changes.
      el("h2", { class: "tm-pf-title visually-hidden" }, [doodle("host", { class: "tm-doodle-header", title: "Your profile" }), "Profile"]),
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
    // TM-907: the visible name-lock explanation, revealed by applyNameLock() when me.nameLocked.
    nameLockNote,
    // TM-846: `glyph` + `photo` are the identity avatar's two mutually-exclusive faces (paintHub
    // shows whichever the live photoURL calls for) — replacing the old single `initial` glyph node.
    // TM-913: the strength ring — `ring` is the progressbar container (aria lives here), `ringArc` the
    // fill <circle> paintHub() dash-offsets to the percent, `barPct` the centred percent label.
    hub: { name: hubName, meta: hubMeta, glyph: hubGlyph, photo: hubPhoto, email: hubEmail, phone: hubPhone, ring, ringArc: bar, barPct, barNudge, barInterestsCta },
    // The membership row's sub text (TM-643) — repainted from GET /me/membership by paintMembership().
    membership: { sub: membershipSub },
    // The Interests card body (TM-778) — repainted by paintInterests() from MeResponse.interests.
    interestsBody,
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

  // Interests (TM-778): "how others see you" — a READ-ONLY view of the caller's saved interests (from
  // MeResponse.interests), no add/remove here (editing lives on the hub card). Painted by fillPublic().
  // reconcile with TM-511 component library (chip component)
  const chips = el("div", { class: "tm-pf-chips tm-pf-pub-chips" });

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

  publicShell = { avatar, name, meta, status, chips };
}

function fillPublic(profile) {
  if (!publicShell) return;
  // Interests (TM-778): render the saved interests as read-only chips; a friendly prompt when none.
  if (publicShell.chips) {
    clear(publicShell.chips);
    const labels = savedInterestLabels(profile?.interests);
    if (labels.length === 0) {
      publicShell.chips.append(el("span", { class: "tm-pf-chip tm-pf-chip-add", text: "No interests yet" }));
    } else {
      for (const label of labels) {
        publicShell.chips.append(el("span", { class: "tm-pf-chip tm-pf-chip-on", text: label }));
      }
    }
  }
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
