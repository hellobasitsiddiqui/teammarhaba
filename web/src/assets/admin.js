// Admin users console (TM-133) — ADMIN-only. The first real consumer of RBAC (TM-110) and the
// admin endpoints (TM-111): lists accounts, with client-side search / role+status filter / sort /
// pagination and a stats bar, and per-user enable-disable + set-role behind a styled confirm +
// toast (with undo). Destructive actions on your own account are hidden (mirrors the backend
// self-protection in TM-111). Mounts into #admin-view; the router (TM-109) gates the route.
//
// Backend note: TM-111 supports page/size/sort but not yet search/role/status filters (TM-115),
// so we fetch the FULL set — walking every page of the endpoint, 100 per request (TM-370) — and
// filter/sort/paginate in the browser. Fine for the current scale (hundreds); when the base
// outgrows fetch-all, a server-side "select all matching" replaces the walk at loadUsers' single
// call into fetchAllUsers (the deliberate seam — see broadcast.js), per TM-133/TM-115.
//
// Identity note (TM-372): a phone-auth account may have NO email and NO display name, so every
// render/search of a user goes through the broadcast.js display-identity chain (displayName →
// email → masked auth phone → uid-prefix → "User #id"). The auth phone arrives on the admin list
// payload as `phoneNumber` (read live from Firebase by the backend; null when unavailable).

import { apiFetch, adminBroadcastPush, getPushRoutes, ApiError as ApiClientError } from "./api.js";
import { currentUser, getIdToken } from "./auth.js";
import { clear, confirmDialog, el, modal, copyToClipboard, relativeTime, stackableTable, toast } from "./ui.js";
// TM-183: the pure URL/model builders for the Operations panel (App endpoints / Diagnostics / Consoles).
// The rendering + the authenticated diagnostics fetch stay here; the resolvable logic is unit-tested.
import { appLinks, consoleLinks, DIAGNOSTICS, diagnosticsUrl } from "./admin-ops-core.js";
import { doodle } from "./doodles.js";
import { confirmSensitiveAction } from "./biometric-confirm.js";
import { renderAccountBadges } from "./account-badges.js";
import { KNOWN_ROUTES } from "./push-deeplink.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";
// TM-847: the pure role→friendly-label mapping (TM-612), extracted so it's unit-testable.
import { roleLabel } from "./admin-role-label-core.js";
// TM-172: the admin user-detail PROFILE edit — pure field descriptors + validators + patch builder,
// reusing the SAME shared self-edit validation (profile-core.js) so the admin edit can't drift looser.
import { ADMIN_PROFILE_FIELDS, validateAdminField, validateAdminForm, buildAdminProfilePatch } from "./admin-profile-edit-core.js";
import {
  MAX_TITLE,
  MAX_BODY,
  MAX_RECIPIENTS,
  NO_ROUTE,
  validateBroadcast,
  // TM-976 (QA-roam A8): gates which validateBroadcast errors are DISPLAYED so a pristine, untouched
  // compose panel doesn't paint a screenful of "required" red before the admin types anything.
  composeErrorsToShow,
  routeOptionsFrom,
  // TM-617: the shared friendly fallback for a route with no curated label below, so an unmapped
  // route reads as "Event detail" rather than a raw "#/event-detail" token in the picker.
  humanizeRoute,
  summariseBroadcast,
  // TM-372: the display-identity fallback chain (displayName → email → masked auth phone →
  // uid-prefix → "User #id"), so phone-only accounts never render as blank, unfindable rows.
  contactCell,
  displayIdentifier,
  searchHaystack,
  // TM-370: the full-account-set page walk — loadUsers feeds it one-page fetches until the whole
  // list is in memory, so select-all/search/stats cover every account, not just the first 100.
  fetchAllUsers,
  selectionCapMessage,
  coverageNote,
  // TM-427: push-eligibility guard — surface each user's push status and stop an admin selecting or
  // sending push to someone who can't receive it (push not enabled, or no registered device).
  isPushEligible,
  pushStatusLabel,
  eligibleRecipients,
  PUSH_INELIGIBLE_HINT,
} from "./broadcast.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-list walk — matches TM-111's max page size
const PAGE_SIZES = [10, 25, 50];

const COLUMNS = [
  { key: "email", label: "Email", sortable: true },
  { key: "displayName", label: "Name", sortable: true },
  { key: "role", label: "Role", sortable: true },
  { key: "enabled", label: "Status", sortable: true },
  // TM-427: per-user push-eligibility, so an admin sees at a glance who a broadcast can actually reach.
  // Not sortable — it's a derived reachability flag, not an account attribute to order the table by.
  { key: "pushEligible", label: "Push", sortable: false },
  { key: "id", label: "ID", sortable: true },
];

const state = {
  users: [],
  // TM-370: the server-reported account total and whether the page walk covered the whole list.
  // On the normal, complete fetch totalAccounts === users.length; they diverge only when a later
  // page failed mid-walk (partial coverage — the compose panel then warns with the exact numbers).
  totalAccounts: 0,
  fetchComplete: true,
  loading: false,
  error: null,
  search: "",
  roleFilter: "ALL",
  statusFilter: "ALL",
  sortKey: "id",
  sortDir: "asc",
  page: 0,
  pageSize: 25,
  // Broadcast compose (TM-365). `selection` persists picked user ids across paging/filtering (by id,
  // not by row), so a draft audience survives the renderTable() churn. The compose panel itself is a
  // stable node built once (see buildCompose) and mutated in place — never rebuilt on a keystroke.
  selection: new Set(),
  // Cache of the deep-link options once fetched (the draft itself lives on the live inputs, which are
  // the single source of truth — see draft()); kept only so a re-entry doesn't need to refetch.
  // TM-976 (A8): which compose fields the admin has interacted with, so a pristine panel shows no
  // errors. title/body flip on input; recipients on any selection change; all reset after a send.
  broadcast: { routeOptions: null, touched: { title: false, body: false, recipients: false } },
};

let shell = null; // { stats, table, pager, compose } persistent containers

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Is `user` the signed-in admin? Matched by email (UserResponse carries no uid); the backend is
 *  the real guard — this only hides own-account actions in the UI. */
function isSelf(user) {
  const myEmail = currentUser()?.email;
  return Boolean(myEmail && user.email && myEmail.toLowerCase() === user.email.toLowerCase());
}

// ---- data ---------------------------------------------------------------------------------

async function patchUser(id, body) {
  const res = await apiFetch(`/api/v1/admin/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`);
  }
  return res.json();
}

/**
 * TM-172: edit another user's admin-editable PROFILE fields via PATCH /admin/users/{id}/profile. The
 * body is the minimal changed-fields patch (buildAdminProfilePatch); the server reuses the same
 * validation as the user's own PATCH /me and audits the edit. Returns the enriched updated user
 * (same UserResponse shape as the list/role PATCH), so the caller can swap the row in place.
 */
async function patchUserProfile(id, body) {
  const res = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`);
  }
  return res.json();
}

/** One page of the admin list for {@link fetchAllUsers}. Sorted by id so page boundaries stay stable
 *  while the walk runs (new sign-ups get higher ids and land on the end, not mid-list). */
async function fetchUsersPage(page, size) {
  const res = await apiFetch(`/api/v1/admin/users?page=${page}&size=${size}&sort=id,asc`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to view this page.");
  if (!res.ok) throw new ApiError(res.status, `Could not load users (${res.status}).`);
  return res.json();
}

export async function loadUsers() {
  // TM-721 re-entry guard: a second Refresh while a load is already running would start a whole second
  // concurrent page walk (fetchAllUsers walks EVERY page), doubling the request volume and racing two
  // result sets into state.users. Bail if one's in flight — mirrors the guarded sibling in
  // admin-messages.js (which gates on state.usersLoading).
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    // TM-370: walk EVERY page of the endpoint (100 per request) so the in-memory set — and with it
    // search, the stats bar and select-all — covers the WHOLE account list, not just the first 100.
    // A page failing mid-walk keeps what loaded and flags the fetch partial (coverage warning);
    // only a failure with nothing loaded reaches the catch below and errors the table.
    const { users, total, complete } = await fetchAllUsers(fetchUsersPage, { pageSize: FETCH_SIZE });
    state.users = users;
    state.totalAccounts = total;
    state.fetchComplete = complete;
    // TM-427: a user selected before this refresh may no longer be push-eligible — drop them so the
    // broadcast can't carry an unreachable recipient.
    pruneIneligibleSelection();
  } catch (err) {
    // 401 is already handled by api.js (token refresh + redirect); surface everything else.
    state.error = err instanceof ApiError ? err.message : "Could not load users.";
    state.users = [];
    state.totalAccounts = 0;
    state.fetchComplete = true; // nothing partial to warn about — the table shows the error instead
  } finally {
    state.loading = false;
    state.page = 0;
    render();
  }
}

// ---- derived view -------------------------------------------------------------------------

function filteredUsers() {
  const q = state.search.trim().toLowerCase();
  return state.users.filter((u) => {
    if (state.roleFilter !== "ALL" && u.role !== state.roleFilter) return false;
    if (state.statusFilter === "ENABLED" && !u.enabled) return false;
    if (state.statusFilter === "DISABLED" && u.enabled) return false;
    if (q) {
      // TM-372: match the whole identity chain (name, email, auth phone raw + masked, "User #id"),
      // not just email/name — so a phone-only account is findable by its number (or its id).
      if (!searchHaystack(u).includes(q)) return false;
    }
    return true;
  });
}

function sortUsers(list) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

// ---- selection (broadcast recipients, TM-365) ---------------------------------------------

/** The users currently matching the filter (the set select-all operates over), sorted for stability. */
function matchingUsers() {
  return sortUsers(filteredUsers());
}

/** The push-eligible subset of the currently-filtered set — the real target of select-all (TM-427),
 *  so a push-ineligible user can never be swept into the selection. */
function eligibleMatchingUsers() {
  return eligibleRecipients(matchingUsers());
}

/** After a (re)load, drop any selected user who is now push-ineligible in the fresh set (TM-427), so a
 *  stale selection can't carry an unreachable recipient across a Refresh. Ids not present in the loaded
 *  set are left alone — there's nothing to re-evaluate them against. */
function pruneIneligibleSelection() {
  if (state.selection.size === 0) return;
  const byId = new Map(state.users.map((u) => [u.id, u]));
  for (const id of [...state.selection]) {
    const u = byId.get(id);
    if (u && !isPushEligible(u)) state.selection.delete(id);
  }
}

/** Toggle one user's membership in the broadcast selection (persisted by id across paging/filtering). */
function toggleSelected(user, on) {
  // Guard (TM-427): never let a push-ineligible user into the selection. The row checkbox is disabled,
  // so this is belt-and-braces — no code path can add a recipient a push can't reach.
  if (on && !isPushEligible(user)) return;
  if (on) state.selection.add(user.id);
  else state.selection.delete(user.id);
  state.broadcast.touched.recipients = true; // TM-976 (A8): they've engaged the recipient list.
  // Only the compose panel + the header select-all state change — no need to rebuild the whole table.
  refreshSelectionUi();
  syncSelectAll();
}

/**
 * Select-all over the CURRENTLY-FILTERED set (not just the visible page): add every matching user's id
 * when not all are selected, otherwise clear them. Selections outside the current filter are left
 * untouched, so narrowing the filter, selecting, then widening it keeps the earlier picks. Since
 * TM-370 the fetched set is the WHOLE account list, so "matching" genuinely means everyone matching.
 */
function toggleSelectAllMatching(on) {
  if (on) {
    // Only ever select users a push can actually reach (TM-427) — ineligible rows are left untouched.
    for (const u of eligibleMatchingUsers()) state.selection.add(u.id);
  } else {
    // Deselect clears the whole matching set (eligible or not), so no stray id survives a toggle-off.
    for (const u of matchingUsers()) state.selection.delete(u.id);
  }
  // With the full list selectable, select-all can now legitimately exceed the broadcast API's hard
  // recipient cap (@Size max MAX_RECIPIENTS userIds). Selecting past it is allowed — the admin may be
  // about to narrow down — but say so IMMEDIATELY (the compose panel may be scrolled out of view);
  // the Send-gate stays closed with the same rule (validateBroadcast) until the count is back under.
  const capMsg = on ? selectionCapMessage(state.selection.size) : "";
  if (capMsg) toast(capMsg, { type: "info", timeout: 8000 });
  state.broadcast.touched.recipients = true; // TM-976 (A8): select-all is a recipient interaction too.
  // The checkboxes on the visible page need repainting, so re-render the table body here.
  renderTable();
  refreshSelectionUi();
}

/** How many of the currently-filtered ELIGIBLE users are selected (TM-427) — drives the header
 *  select-all checked/indeterminate against the reachable set, since only those can be selected. */
function matchingSelectedCount() {
  let n = 0;
  for (const u of eligibleMatchingUsers()) if (state.selection.has(u.id)) n += 1;
  return n;
}

/** Reflect the current selection onto the header select-all checkbox (checked / indeterminate / off).
 *  "All" means all push-eligible matching users (TM-427); a filter that matches only ineligible users
 *  leaves nothing to select, so the box is disabled. */
function syncSelectAll() {
  const box = shell?.selectAll;
  if (!box) return;
  const eligible = eligibleMatchingUsers();
  const selected = matchingSelectedCount();
  box.checked = eligible.length > 0 && selected === eligible.length;
  box.indeterminate = selected > 0 && selected < eligible.length;
  box.disabled = eligible.length === 0;
}

// ---- actions ------------------------------------------------------------------------------

async function applyPatch(user, body, { successMsg, undo }) {
  try {
    const updated = await patchUser(user.id, body);
    const idx = state.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) state.users[idx] = updated;
    render();
    toast(successMsg, { type: "success", action: undo ? { label: "Undo", onClick: undo } : null });
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : "Something went wrong.";
    toast(msg, { type: "error" });
  }
}

async function toggleEnabled(user) {
  const disabling = user.enabled;
  const ok = await confirmDialog({
    title: disabling ? "Disable account?" : "Enable account?",
    // TM-372: displayIdentifier never comes back blank, so the dialog always names who's affected
    // (masked phone / "User #id" for accounts with no email or name).
    message: disabling
      ? `${displayIdentifier(user)} will be blocked on their next request until re-enabled.`
      : `${displayIdentifier(user)} will be able to sign in again.`,
    confirmLabel: disabling ? "Disable" : "Enable",
    danger: disabling,
  });
  if (!ok) return;
  await applyPatch(user, { enabled: !user.enabled }, {
    successMsg: disabling ? "Account disabled." : "Account enabled.",
    undo: () => applyPatch(user, { enabled: user.enabled }, { successMsg: "Reverted." }),
  });
}

async function changeRole(user) {
  const next = user.role === "ADMIN" ? "USER" : "ADMIN";
  const promoting = next === "ADMIN";
  const ok = await confirmDialog({
    title: promoting ? "Make admin?" : "Remove admin?",
    message: promoting
      ? `${displayIdentifier(user)} will get full admin access (effective on their next sign-in/token refresh).`
      : `${displayIdentifier(user)} will lose admin access (effective on their next token refresh).`,
    confirmLabel: promoting ? "Make admin" : "Remove admin",
    danger: !promoting,
  });
  if (!ok) return;
  // Sensitive action (TM-282): on a native device with the biometric gate available, require a
  // fingerprint/PIN confirm before changing a role. No-op on the web build (passes straight through).
  const verified = await confirmSensitiveAction({
    reason: promoting ? "Confirm: make this user an admin" : "Confirm: remove admin access",
    title: "Confirm role change",
  });
  if (!verified) {
    toast("Role change cancelled — not verified.", { type: "info" });
    return;
  }
  await applyPatch(user, { role: next }, {
    successMsg: `Role changed to ${next}.`,
    undo: () => applyPatch(user, { role: user.role }, { successMsg: "Reverted." }),
  });
}

/**
 * Is the membership feature flag ON? Reads `window.TEAMMARHABA_CONFIG.flags.membership` (owned by TM-480,
 * shipped OFF) — the SAME single flag every other membership surface gates on (membership-tier.js et al).
 * Used to keep the admin user-detail Subscription panel (TM-620) inert while the epic is OFF (TM-624), so
 * the epic's "all membership UI ships behind the OFF flag" invariant holds in the admin console too.
 */
function membershipEnabled() {
  const cfg = opsConfig();
  return Boolean(cfg.flags && cfg.flags.membership);
}

function openDetail(user) {
  const body = [
    el("dl", { class: "tm-detail" }, [
      el("dt", { text: "Email" }),
      el("dd", {}, [
        el("span", { text: user.email || "—" }),
        user.email
          ? el("button", { class: "tm-copy", type: "button", title: "Copy email", onClick: () => copyToClipboard(user.email) }, "Copy")
          : null,
      ]),
      el("dt", { text: "Name" }),
      el("dd", { text: user.displayName || "—" }),
      // TM-372: the verified auth phone (from Firebase, via the admin list payload) — the identity
      // of a phone-auth account. Shown in FULL here (the deliberate single-account view, same as
      // email above); the table shows it masked. "—" when the account has no phone identity.
      el("dt", { text: "Phone (auth)" }),
      el("dd", {}, [
        el("span", { text: user.phoneNumber || "—" }),
        user.phoneNumber
          ? el("button", { class: "tm-copy", type: "button", title: "Copy phone number", onClick: () => copyToClipboard(user.phoneNumber) }, "Copy")
          : null,
      ]),
      el("dt", { text: "Role" }),
      el("dd", {}, [roleBadge(user.role)]),
      el("dt", { text: "Status" }),
      el("dd", {}, [statusBadge(user.enabled)]),
      // Account-state badges (TM-168): email-verified / age-verified / MFA, reusing the same shared
      // primitive as the profile page. Renders only the flags the admin user projection actually
      // carries (TM-111's UserResponse) — `includeUnknown:false` so absent flags show nothing rather
      // than a row of "unknown" pills; lights up automatically if the projection later exposes them.
      ...accountStateRow(user),
      el("dt", { text: "ID" }),
      el("dd", { text: String(user.id) }),
    ]),
    // Editable profile fields (TM-172): the TM-162 profile set (names/city/age/phone/notification/
    // timezone/locale) with an admin edit form that reuses the SAME client-side validation the user's
    // own profile edit uses (admin-profile-edit-core → profile-core). Identity/role/enabled above are
    // unchanged — the profile edit is a separate, scoped surface. Returns its own section nodes.
    ...profileSection(user),
    // Subscription state + billing history (TM-620): what the account pays for and every charge
    // attempt, straight off GET /admin/users/{id}/subscription. Loaded lazily like the activity log.
    // GATED behind config.flags.membership (TM-624): the whole membership epic ships inert behind the
    // OFF flag, so while it's off the admin modal shows NO Subscription section and fires no extra
    // GET .../subscription request per open — the panel (and its loadSubscription() call below) only
    // appears once the flag flips, exactly like every other membership surface.
    ...(membershipEnabled()
      ? [
          el("h3", { class: "tm-detail-h", text: "Subscription" }),
          el("p", { class: "tm-muted", id: "tm-subscription" }, "Loading…"),
        ]
      : []),
    el("h3", { class: "tm-detail-h", text: "Recent activity" }),
    el("p", { class: "tm-muted", id: "tm-activity" }, "Loading…"),
  ];
  const { close } = modal(`User · ${displayIdentifier(user)}`, body);
  // Only fetch the subscription when the panel is actually shown (flag ON) — no leaked request while OFF.
  if (membershipEnabled()) loadSubscription(user);
  loadActivity(user);
  return close;
}

// ---- admin profile edit (TM-172) --------------------------------------------------------------

/** Human-readable current value of a profile field for the read-only display ("—" when empty). */
function profileDisplayValue(user, key) {
  const v = user[key];
  if (v == null || v === "") return "—";
  return String(v);
}

/**
 * The editable-profile section of the user-detail modal (TM-172): a read-only summary of the current
 * profile fields plus an "Edit profile" form that PATCHes /admin/users/{id}/profile. Validation and
 * the changed-fields patch come from admin-profile-edit-core (which reuses the shared self-edit rules),
 * so the admin edit matches what the server accepts and can't drift looser. On success it swaps the
 * updated user into state + the list row, re-renders the summary + form in place, and toasts; on error
 * it surfaces the server/validation message (inline per-field for a 400-shaped body, else a toast).
 * Returns the section nodes (spread into the modal body).
 */
function profileSection(user) {
  // Mutable "current" view of the target used for display + the off-list-city / grandfathered-age
  // allowances; updated in place after a successful save so a second edit sees the new saved values.
  let current = { ...user };

  const summary = el("dl", { class: "tm-detail tm-admin-profile-summary" });
  const form = el("form", { class: "tm-admin-profile-form", hidden: true, novalidate: true });
  const editBtn = el("button", { class: "tm-btn tm-btn-sm", type: "button" }, "Edit profile");

  function renderSummary() {
    clear(summary);
    for (const field of ADMIN_PROFILE_FIELDS) {
      summary.append(
        el("dt", { text: field.label }),
        el("dd", { text: profileDisplayValue(current, field.key) }),
      );
    }
  }

  // Field controls, so validation + patch-building can read their live values by key.
  const controls = new Map(); // key -> { input, error }

  function buildForm() {
    clear(form);
    controls.clear();
    for (const field of ADMIN_PROFILE_FIELDS) {
      const fieldId = `admin-profile-${field.key}-${current.id}`;
      const errorId = `${fieldId}-error`;
      // Describe the control by BOTH hint and error (like buildField in profile.js) so a screen
      // reader hears the constraint hint, not just the error after a failed submit.
      const hintId = field.hint ? `${fieldId}-hint` : null;
      const describedBy = [hintId, errorId].filter(Boolean).join(" ");
      let input;
      if (field.type === "select") {
        // Keep an already-saved OFF-LIST city selectable (TM-877 allowance) so editing another field
        // never silently drops it — mirrors the self-edit's fillForm injected-option behaviour.
        const options = field.options.map(([value, label]) => [value, label]);
        if (field.key === "city" && current.city && !options.some(([v]) => v === current.city)) {
          options.push([current.city, current.city]);
        }
        input = el(
          "select",
          { id: fieldId, class: "tm-input", "aria-describedby": describedBy },
          options.map(([value, label]) =>
            el("option", { value, selected: String(current[field.key] ?? "") === String(value) }, label)),
        );
      } else {
        input = el("input", {
          id: fieldId,
          class: "tm-input",
          type: field.type === "number" ? "number" : field.type === "tel" ? "tel" : "text",
          value: current[field.key] == null ? "" : String(current[field.key]),
          maxlength: field.maxLength || null,
          min: field.min ?? null,
          max: field.max ?? null,
          "aria-describedby": describedBy,
        });
      }
      const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
      // Live per-field validation on input, exactly like the self-edit form, using the SHARED rules.
      input.addEventListener("input", () => setControlError(field.key, validateAdminField(field, input.value, current)));
      input.addEventListener("change", () => setControlError(field.key, validateAdminField(field, input.value, current)));
      controls.set(field.key, { input, error });
      // Reuse the SHARED self-edit markup (.tm-form-field / .tm-field-label / .tm-field-hint /
      // .tm-field-error) so the admin form inherits the exact same column stack + spacing + the
      // min-width:0 clip guard (TM-665). A bare ".tm-field" has no CSS rule and falls back to inline flow.
      form.append(
        el("div", { class: "tm-form-field" }, [
          el("label", { class: "tm-field-label", for: fieldId, text: field.label }),
          input,
          field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null,
          error,
        ]),
      );
    }
    const saveBtn = el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", type: "submit" }, "Save profile");
    const cancelBtn = el("button", { class: "tm-btn tm-btn-sm", type: "button" }, "Cancel");
    cancelBtn.addEventListener("click", () => showForm(false));
    form.append(el("div", { class: "tm-form-actions" }, [saveBtn, cancelBtn]));
  }

  function setControlError(key, message) {
    const c = controls.get(key);
    if (!c) return;
    c.error.textContent = message || "";
    c.error.hidden = !message;
    // aria-invalid for AT + the tm-field-invalid ring for sighted users — mirror setControlInvalid
    // in profile.js so an off-band/off-list value flags the input itself, not just the error text.
    if (message) c.input.setAttribute("aria-invalid", "true");
    else c.input.removeAttribute("aria-invalid");
    c.input.classList.toggle("tm-field-invalid", !!message);
  }

  function showForm(on) {
    if (on) buildForm();
    form.hidden = !on;
    editBtn.hidden = on;
    summary.hidden = on;
    // Keep keyboard/AT focus inside this in-modal disclosure: on reveal the just-clicked editBtn
    // becomes hidden (out of tab order), so move focus into the first field; on hide, return it to
    // the now-visible editBtn. The shared modal() has no focus trap, so without this focus falls to <body>.
    if (on) {
      const first = controls.get(ADMIN_PROFILE_FIELDS[0].key);
      first?.input?.focus();
    } else {
      editBtn.focus();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    for (const [key, c] of controls) values[key] = c.input.value;

    // Validate the whole form with the SHARED rules before sending (fail fast in the browser).
    const errors = validateAdminForm(values, current);
    for (const field of ADMIN_PROFILE_FIELDS) setControlError(field.key, errors[field.key] || "");
    if (Object.keys(errors).length > 0) {
      toast("Fix the highlighted fields.", { type: "error" });
      return;
    }

    const patch = buildAdminProfilePatch(values, current);
    if (Object.keys(patch).length === 0) {
      toast("No changes to save.", { type: "info" });
      showForm(false);
      return;
    }

    try {
      const updated = await patchUserProfile(current.id, patch);
      current = { ...current, ...updated };
      // Keep the in-memory list row + any open list render in sync (mirrors applyPatch).
      const idx = state.users.findIndex((u) => u.id === updated.id);
      if (idx >= 0) state.users[idx] = { ...state.users[idx], ...updated };
      render();
      renderSummary();
      showForm(false);
      toast("Profile updated.", { type: "success" });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not update the profile.";
      toast(msg, { type: "error" });
    }
  });

  editBtn.addEventListener("click", () => showForm(true));

  renderSummary();
  return [
    el("h3", { class: "tm-detail-h", text: "Profile" }),
    summary,
    form,
    el("div", { class: "tm-form-actions" }, [editBtn]),
  ];
}

/** "£9.99" from pence — local to keep admin.js free of the membership modules (mirrors formatPrice). */
function formatPence(pence) {
  const n = Number(pence);
  const safe = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const pounds = safe / 100;
  return `£${safe % 100 === 0 ? String(pounds) : pounds.toFixed(2)}`;
}

/**
 * Load one account's subscription state + charge history into the detail dialog (TM-620). Degrades to
 * a clear note when the endpoint errors (e.g. an older backend) rather than breaking the modal.
 */
async function loadSubscription(user) {
  const target = document.getElementById("tm-subscription");
  if (!target) return;
  try {
    const res = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}/subscription`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const sub = body && body.subscription ? body.subscription : { subscribed: false };
    const charges = Array.isArray(body?.charges) ? body.charges : [];

    if (!sub.subscribed && charges.length === 0) {
      target.textContent = "No subscription — pay-per-event account.";
      return;
    }

    const parts = [];
    if (sub.subscribed) {
      const renewLine = sub.currentPeriodEnd
        ? `${sub.renewing ? "renews" : "ends"} ${relativeTime(sub.currentPeriodEnd).text}`
        : "";
      parts.push(
        el("p", { class: "tm-admin-subscription-state" }, [
          el("strong", { text: `${sub.tier || "?"} · ${sub.status || "?"}` }),
          el("span", {
            class: "tm-muted",
            text: ` — ${formatPence(sub.amountPence)}/month${renewLine ? ` · ${renewLine}` : ""}`,
          }),
        ]),
      );
    } else {
      parts.push(el("p", { class: "tm-muted", text: "No current subscription (history below)." }));
    }
    if (charges.length) {
      parts.push(
        el(
          "ul",
          { class: "tm-activity" },
          charges.slice(0, 10).map((c) => {
            const when = relativeTime(c.createdAt);
            return el("li", {}, [
              el("span", {
                class: "tm-activity-action",
                text: `${c.kind || "?"} ${formatPence(c.amountPence)} · ${c.status || "?"}`,
              }),
              el("time", { class: "tm-muted", title: when.title, text: ` · ${when.text}` }),
            ]);
          }),
        ),
      );
    }
    target.replaceWith(el("div", { id: "tm-subscription" }, parts));
  } catch {
    target.textContent = "Subscription data isn't available.";
  }
}

// Forward-compatible: try the audit read endpoint; it doesn't exist yet (TM-113 is write-only by
// design), so this degrades to a clear note rather than a broken modal. Flagged as a finding.
async function loadActivity(user) {
  const target = document.getElementById("tm-activity");
  if (!target) return;
  try {
    const res = await apiFetch(`/api/v1/audit?targetType=user&targetId=${encodeURIComponent(user.id)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const events = Array.isArray(body.items) ? body.items : Array.isArray(body) ? body : [];
    if (!events.length) {
      target.textContent = "No recent activity.";
      return;
    }
    const list = el("ul", { class: "tm-activity" }, events.slice(0, 20).map((e) => {
      const when = relativeTime(e.timestamp || e.createdAt);
      return el("li", {}, [
        el("span", { class: "tm-activity-action", text: e.action || "event" }),
        el("time", { class: "tm-muted", title: when.title, text: ` · ${when.text}` }),
      ]);
    }));
    target.replaceWith(list);
  } catch {
    target.textContent = "Activity log isn't available yet (the audit read endpoint lands with TM-113).";
  }
}

// ---- broadcast compose (TM-365) -----------------------------------------------------------

// Human-readable labels for the deep-link routes in the picker, so the admin sees "Home" rather than
// the raw "#/home". A newly-added backend route with no entry here still shows up immediately, but now
// as a humanised label (TM-617) — "Event detail", not a raw "#/event-detail" token.
const ROUTE_LABELS = Object.freeze({
  "#/home": "Home",
  "#/profile": "Profile",
  "#/admin": "Admin hub",
  "#/help": "Help",
  "#/onboarding": "Onboarding",
  "#/login": "Sign in",
});

function routeLabel(route) {
  return ROUTE_LABELS[route] || humanizeRoute(route);
}

/** The current compose draft, read straight off the live inputs (the inputs are the source of truth). */
function draft() {
  const c = shell?.compose;
  return {
    title: c ? c.title.value : "",
    body: c ? c.body.value : "",
    route: c ? c.route.value : NO_ROUTE,
    selectionSize: state.selection.size,
  };
}

/** Paint (or clear) a compose field's inline error, mirroring profile.js's setFieldError a11y wiring. */
function setComposeError(key, message) {
  const c = shell?.compose;
  if (!c) return;
  const input = c[key];
  const error = c.errors[key];
  if (error) {
    error.textContent = message || "";
    error.hidden = !message;
  }
  if (!input) return;
  if (message) {
    input.setAttribute("aria-invalid", "true");
    input.classList.add("tm-field-invalid");
  } else {
    input.removeAttribute("aria-invalid");
    input.classList.remove("tm-field-invalid");
  }
}

/**
 * Re-derive everything that depends on the draft or the selection: the live 'N selected' count, the
 * Send-enabled state, and the preview. Called on every keystroke, route change, and selection change.
 * Cheap and idempotent — it only mutates the stable compose nodes in place (never rebuilds them), so an
 * in-progress draft is never disturbed by a table re-render happening beside it.
 */
function refreshSelectionUi() {
  const c = shell?.compose;
  if (!c) return;
  const n = state.selection.size;
  c.count.textContent = `${n} selected`;
  const { title, body, recipients, canSend } = validateBroadcast(draft());
  // Send is gated by canSend (the real validation) regardless — but the VISIBLE errors are gated by
  // what the admin has touched (TM-976 / A8), so a pristine, untouched panel doesn't shout "required"
  // before any intent. A field's error surfaces once it's touched; the empty-recipient hint once they've
  // engaged at all (see composeErrorsToShow). The code always meant to do this — the guard was missing.
  const show = composeErrorsToShow({ title, body, recipients }, state.broadcast.touched);
  setComposeError("title", show.title);
  setComposeError("body", show.body);
  c.recipientHint.textContent = show.recipients || "";
  c.recipientHint.hidden = !show.recipients;
  c.send.disabled = !canSend || c.sendingBusy;
  updatePreview();
}

/**
 * Coverage warning (TM-370). The console now walks the WHOLE account list, so the old "first 100"
 * ceiling is gone — this fires only when a fetch came back PARTIAL (a later page failed mid-walk, or
 * the runaway page guard tripped), stating exactly how many accounts are loaded vs the server total
 * so select-all's real reach is never overstated. Hidden on a complete fetch (the normal case),
 * while loading, and on a full load error (the table already shows that). Idempotent per render.
 */
function refreshCeilingWarning() {
  const c = shell?.compose;
  if (!c || !c.ceilingWarning) return;
  const partial = !state.fetchComplete && !state.loading && !state.error;
  if (partial) c.ceilingWarning.textContent = coverageNote(state.users.length, state.totalAccounts);
  c.ceilingWarning.hidden = !partial;
}

/** Repaint the faithful preview card from the current draft (title headline + body + tap caption). */
function updatePreview() {
  const c = shell?.compose;
  if (!c) return;
  const { title, body } = draft();
  const route = draft().route;
  c.previewTitle.textContent = title.trim() || "Notification title";
  c.previewTitle.classList.toggle("tm-push-preview-placeholder", title.trim() === "");
  c.previewBody.textContent = body.trim() || "Your message will appear here.";
  c.previewBody.classList.toggle("tm-push-preview-placeholder", body.trim() === "");
  // The route is invisible metadata on a real push (only title/body render on the shade) — we surface
  // it as a caption so the admin knows where a tap lands, without pretending it's part of the visible push.
  c.previewCaption.textContent = route ? `Tapping opens: ${routeLabel(route)}` : "Tapping opens: the app";
}

/**
 * Populate the deep-link picker from the backend allow-list (GET …/push-routes, TM-360) — the single
 * source of truth, so the admin can only pick a route the send path will accept. Best-effort: on any
 * failure it falls back to the client KNOWN_ROUTES (kept in lock-step with the backend) so the picker is
 * never empty, and notes the degrade. The leading "No deep-link" option is always present.
 */
async function loadPushRoutes() {
  const c = shell?.compose;
  if (!c) return;
  let routes;
  try {
    routes = routeOptionsFrom(await getPushRoutes(), KNOWN_ROUTES);
  } catch {
    // Non-fatal: fall back to the client allow-list so composing still works offline / on a 403 blip.
    routes = routeOptionsFrom(null, KNOWN_ROUTES);
    toast("Using the built-in route list (couldn't reach the server list).", { type: "info" });
  }
  state.broadcast.routeOptions = routes;
  const current = c.route.value;
  clear(c.route).append(
    el("option", { value: NO_ROUTE, text: "No deep-link" }),
    ...routes.map((r) => el("option", { value: r, text: routeLabel(r) })),
  );
  // Preserve the admin's pick if it's still valid; otherwise reset to "No deep-link".
  c.route.value = current && routes.includes(current) ? current : NO_ROUTE;
  updatePreview();
}

/**
 * Confirm-then-send. Send is already gated (disabled) until title+body are valid and ≥1 recipient is
 * selected; this adds an explicit, dangerous confirm because a delivered push is irreversible — there is
 * deliberately NO undo toast (unlike the enable/role actions). On success we toast an honest summary read
 * from the response (sent / delivered / skipped); on failure we surface the RFC-7807 message.
 */
async function sendBroadcast() {
  const c = shell?.compose;
  if (!c) return;
  const d = draft();
  const { canSend } = validateBroadcast(d);
  if (!canSend) {
    refreshSelectionUi();
    return;
  }

  const n = state.selection.size;
  const routeNote = d.route ? ` They'll deep-link to ${routeLabel(d.route)} on tap.` : "";
  const ok = await confirmDialog({
    title: `Send to ${n} ${n === 1 ? "user" : "users"}?`,
    message: `“${d.title.trim()}” will be delivered to their devices now.${routeNote} This can't be undone.`,
    confirmLabel: "Send now",
    danger: true,
  });
  if (!ok) return;

  c.sendingBusy = true;
  c.send.disabled = true;
  const original = c.send.textContent;
  c.send.textContent = "Sending…";
  try {
    const result = await adminBroadcastPush({
      title: d.title.trim(),
      body: d.body.trim(),
      route: d.route || null,
      userIds: [...state.selection],
    });
    toast(summariseBroadcast(result), { type: "success", timeout: 8000 });
    // A delivered broadcast is done — clear the draft + selection so the panel resets for the next one.
    state.selection.clear();
    c.title.value = "";
    c.body.value = "";
    c.route.value = NO_ROUTE;
    // TM-976 (A8): the reset panel is pristine again, so the next compose starts quiet (no shout).
    state.broadcast.touched = { title: false, body: false, recipients: false };
    renderTable(); // repaint the row checkboxes now that the selection is empty
    refreshSelectionUi();
  } catch (err) {
    const msg = err instanceof ApiClientError ? err.message : "Couldn't send the broadcast.";
    toast(msg, { type: "error" });
  } finally {
    c.sendingBusy = false;
    c.send.textContent = original;
    refreshSelectionUi(); // re-derive the disabled state now that we're no longer sending
  }
}

/**
 * Build the broadcast compose panel ONCE (called from buildShell). It lives OUTSIDE shell.table — which
 * renderTable() clears on every keystroke/filter — so an in-progress draft survives table churn. Fields
 * reuse the profile.js form markup (.tm-form-field / .tm-field-label / .tm-field-hint / .tm-field-error).
 * Returns the panel node; live references are stashed on shell.compose for in-place updates.
 */
function buildCompose() {
  const count = el("span", { class: "tm-badge tm-broadcast-count", id: "admin-selected-count", text: "0 selected" });

  const title = el("input", {
    id: "admin-broadcast-title",
    class: "tm-input",
    type: "text",
    maxLength: MAX_TITLE,
    autocomplete: "off",
    "aria-describedby": "admin-broadcast-title-hint admin-broadcast-title-error",
  });
  const titleError = el("p", { id: "admin-broadcast-title-error", class: "tm-field-error", role: "alert", hidden: true });
  const titleHint = el("p", { id: "admin-broadcast-title-hint", class: "tm-muted tm-field-hint", text: `Up to ${MAX_TITLE} characters.` });

  const body = el("textarea", {
    id: "admin-broadcast-body",
    class: "tm-input tm-textarea",
    rows: "3",
    maxLength: MAX_BODY,
    "aria-describedby": "admin-broadcast-body-hint admin-broadcast-body-error",
  });
  const bodyError = el("p", { id: "admin-broadcast-body-error", class: "tm-field-error", role: "alert", hidden: true });
  const bodyHint = el("p", { id: "admin-broadcast-body-hint", class: "tm-muted tm-field-hint", text: `Up to ${MAX_BODY} characters.` });

  // Deep-link picker: seeded with just "No deep-link"; loadPushRoutes() fills the rest from the backend
  // allow-list. Never free text — the value is always "" or one of the server's known routes.
  const route = el("select", {
    id: "admin-broadcast-route",
    class: "tm-input",
    "aria-describedby": "admin-broadcast-route-hint",
    onChange: () => updatePreview(),
  }, [el("option", { value: NO_ROUTE, text: "No deep-link" })]);
  const routeHint = el("p", { id: "admin-broadcast-route-hint", class: "tm-muted tm-field-hint", text: "Where a tap on the notification takes the user." });

  // Live inline errors clear as the user types (mirrors profile.js's live-clear). Typing also marks the
  // field touched (TM-976 / A8) so its error can surface — a pristine, untouched field stays quiet.
  title.addEventListener("input", () => { state.broadcast.touched.title = true; refreshSelectionUi(); });
  body.addEventListener("input", () => { state.broadcast.touched.body = true; refreshSelectionUi(); });

  const recipientHint = el("p", { id: "admin-broadcast-recipients", class: "tm-field-error", role: "alert", hidden: true });

  // The faithful preview — title as the headline, body beneath, exactly as they'd read on the native
  // shade. The route is invisible metadata on a real push, so it's shown only as a caption below.
  const previewTitle = el("p", { class: "tm-push-preview-title tm-push-preview-placeholder", text: "Notification title" });
  const previewBody = el("p", { class: "tm-push-preview-body tm-push-preview-placeholder", text: "Your message will appear here." });
  const previewCaption = el("p", { class: "tm-push-preview-caption", text: "Tapping opens: the app" });
  const preview = el("div", { class: "tm-push-preview", id: "admin-broadcast-preview", "aria-hidden": "true" }, [
    el("div", { class: "tm-push-preview-app" }, [
      doodle("chat", { class: "tm-push-preview-icon" }),
      el("span", { class: "tm-push-preview-appname", text: "Circle · now" }),
    ]),
    previewTitle,
    previewBody,
    previewCaption,
  ]);

  // Partial-coverage warning (TM-370, ex the TM-365 M2 "first 100" caveat): the console now fetches
  // EVERY page, so this only appears when a load came back incomplete (a page failed mid-walk / the
  // runaway guard tripped). Built hidden and textless; refreshCeilingWarning() fills the live
  // "Loaded X of Y accounts" copy after loadUsers(). role="status" (not "alert") — an informational
  // caveat, not an error.
  const ceilingWarning = el("p", {
    class: "tm-muted tm-broadcast-ceiling",
    id: "admin-broadcast-ceiling",
    role: "status",
    hidden: true,
  });

  const send = el("button", {
    class: "tm-btn tm-btn-primary",
    id: "admin-broadcast-send",
    type: "button",
    disabled: true,
    onClick: () => sendBroadcast(),
  }, "Send broadcast");

  const panel = el("section", { class: "tm-broadcast", id: "admin-broadcast", "aria-label": "Compose broadcast" }, [
    el("div", { class: "tm-broadcast-head" }, [
      el("h3", { class: "tm-broadcast-title", text: "Send a notification" }),
      count,
    ]),
    el("p", { class: "tm-muted tm-broadcast-note", text: `Pick recipients in the table below — only users who can receive push (push enabled and a registered device) are selectable; select-all covers everyone eligible matching your filter, across the whole account list. Compose your message, preview it, then send. A single broadcast can reach up to ${MAX_RECIPIENTS} recipients.` }),
    // Shown only when a load came back PARTIAL (a page failed mid-walk): says exactly how many accounts
    // are loaded vs the server total, so select-all's reach is never overstated (TM-370). Hidden by
    // default; filled + toggled in refreshCeilingWarning() once users load.
    ceilingWarning,
    el("div", { class: "tm-broadcast-grid" }, [
      el("div", { class: "tm-broadcast-form" }, [
        el("div", { class: "tm-form-field" }, [
          el("label", { class: "tm-field-label", for: "admin-broadcast-title", text: "Title" }),
          title,
          titleHint,
          titleError,
        ]),
        el("div", { class: "tm-form-field" }, [
          el("label", { class: "tm-field-label", for: "admin-broadcast-body", text: "Message" }),
          body,
          bodyHint,
          bodyError,
        ]),
        el("div", { class: "tm-form-field" }, [
          el("label", { class: "tm-field-label", for: "admin-broadcast-route", text: "Deep-link (optional)" }),
          route,
          routeHint,
        ]),
      ]),
      el("div", { class: "tm-broadcast-preview-wrap" }, [
        el("span", { class: "tm-field-label", text: "Preview" }),
        preview,
      ]),
    ]),
    el("div", { class: "tm-broadcast-actions" }, [send, recipientHint]),
  ]);

  shell.compose = {
    panel, title, body, route, send,
    count, recipientHint, ceilingWarning,
    previewTitle, previewBody, previewCaption,
    errors: { title: titleError, body: bodyError },
    sendingBusy: false,
  };
  return panel;
}

// ---- rendering ----------------------------------------------------------------------------

function roleBadge(role) {
  // TM-612: render a human-friendly label ("Admin"/"User") rather than the raw enum token
  // ("ADMIN"/"USER"). This matches statusBadge ("Enabled"/"Disabled") and the role filter's
  // friendly options ("Users"/"Admins") just below, so the console reads consistently. The raw
  // role still drives the CSS class (`tm-badge-role-admin`/`-user`), so styling is unchanged.
  // TM-847: the label mapping is now the unit-tested roleLabel() in admin-role-label-core.js.
  const label = roleLabel(role);
  return el("span", { class: `tm-badge tm-badge-role-${role.toLowerCase()}`, text: label });
}

function statusBadge(enabled) {
  return el("span", { class: `tm-badge ${enabled ? "tm-badge-ok" : "tm-badge-off"}`, text: enabled ? "Enabled" : "Disabled" });
}

/** The push-eligibility badge for a user row (TM-427): a green "Push" when a broadcast can reach them,
 *  a grey "No push" (with an explaining tooltip) when it can't. Mirrors the disabled row checkbox. */
function pushBadge(user) {
  const eligible = isPushEligible(user);
  return el("span", {
    class: `tm-badge ${eligible ? "tm-badge-ok" : "tm-badge-off"}`,
    title: eligible ? null : PUSH_INELIGIBLE_HINT,
    text: pushStatusLabel(user),
  });
}

// A `<dt>/<dd>` pair carrying the account-state badges (TM-168) for the detail dialog — but only
// when the user object actually carries at least one of the flags, so a projection without them
// (today's admin UserResponse) adds no empty row. Returns [] (spread away) when nothing to show.
function accountStateRow(user) {
  const group = renderAccountBadges(user, { includeUnknown: false });
  if (!group) return [];
  return [el("dt", { text: "Verification" }), el("dd", {}, [group])];
}

function renderStats() {
  // "Total" is the SERVER's count (TM-370) — the real account total even if a partial fetch loaded
  // fewer (the coverage warning explains any gap). The role/status splits are counted over the
  // loaded rows (identical on the normal, complete fetch).
  const total = Math.max(state.totalAccounts, state.users.length);
  const admins = state.users.filter((u) => u.role === "ADMIN").length;
  const enabled = state.users.filter((u) => u.enabled).length;
  // TM-756: loadUsers() renders BEFORE the account walk resolves, so these derive from EMPTY state
  // and would paint "Total 0 / Admins 0 / …" on a populated system as if that were data. Route the
  // cards through the pure loading mask (admin-stats-core.js) — while loading every value shows "—"
  // (labels/markup unchanged, so the grid keeps its shape and the tour's ".tm-stats" target still
  // matches); once loaded the cards pass through untouched. Mirrors the table's state.loading gate.
  const cards = statsCards([
    ["Total", total],
    ["Admins", admins],
    ["Enabled", enabled],
    ["Disabled", state.users.length - enabled],
  ], state.loading);
  clear(shell.stats).append(...cards.map(([label, value]) =>
    el("div", { class: "tm-stat" }, [
      el("span", { class: "tm-stat-value", text: String(value) }),
      el("span", { class: "tm-stat-label", text: label }),
    ])));
}

function renderTable() {
  clear(shell.table);
  // The header select-all lives inside the table, which we've just cleared — drop the stale reference
  // so syncSelectAll() is a no-op until a real table (with the checkbox) is rebuilt below.
  if (shell) shell.selectAll = null;

  if (state.loading) {
    // TM-550: a themed loading block (centred token-inked spinner + label) rather than a bare line of
    // muted text, so the console's loading state matches the refreshed look. Styling only — the state
    // machine (state.loading gate) is unchanged.
    shell.table.append(el("p", { class: "tm-muted tm-table-loading", text: "Loading users…" }));
    return;
  }
  if (state.error) {
    shell.table.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.error }),
      el("button", { class: "tm-btn", type: "button", onClick: loadUsers }, "Retry"),
    ]));
    return;
  }

  const rows = sortUsers(filteredUsers());
  if (!rows.length) {
    const filtered = state.users.length > 0;
    const message = filtered ? "No users match your filters." : "No users yet.";
    // A crowd doodle over the empty-state line (TM-215); CSS gates the doodle to the doodle theme.
    // Decorative: no title so it renders aria-hidden — the adjacent line already announces `message`.
    shell.table.append(el("div", { class: "tm-empty" }, [
      doodle("crowd", { class: "tm-doodle-empty" }),
      el("p", { class: "tm-muted", text: message }),
    ]));
    renderPager(0);
    return;
  }

  // TM-721: clamp a stale page index BEFORE slicing. A mutation (disable/role-change filtering a row out,
  // or a narrower search) can shrink `rows` below the current page's start; without this the slice is
  // empty and we'd paint a blank table while renderPager (which clamps too late) shows "Page 1 of 1".
  state.page = clampPage(state.page, rows.length, state.pageSize);
  const start = state.page * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  // Leading select-all checkbox (TM-365): toggles the whole CURRENTLY-FILTERED set — not just the
  // visible page — so it's labelled accordingly. Its checked/indeterminate state is synced after render.
  const selectAll = el("input", {
    type: "checkbox",
    class: "tm-check",
    id: "admin-select-all",
    // Since TM-370 the console holds the FULL account list (loadUsers walks every page), so this
    // label finally means what it says: everyone matching the filter, full stop. If a load came back
    // partial, the compose panel's coverage warning states the real reach — the label needn't hedge.
    "aria-label": "Select all users matching the current filter",
    title: "Select all users matching the current filter (across the whole list, not just this table page)",
    onChange: (e) => toggleSelectAllMatching(e.target.checked),
  });
  shell.selectAll = selectAll;

  const head = el("tr", {}, [el("th", { scope: "col", class: "tm-check-cell" }, [selectAll])].concat(
    COLUMNS.map((c) => {
      const active = state.sortKey === c.key;
      const arrow = active ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
      return el("th", {
        class: c.sortable ? "tm-sortable" : null,
        scope: "col",
        "aria-sort": active ? (state.sortDir === "asc" ? "ascending" : "descending") : null,
        onClick: c.sortable ? () => toggleSort(c.key) : null,
      }, `${c.label}${arrow}`);
    }),
    el("th", { scope: "col", text: "Actions" }),
  ));

  const body = el("tbody", {}, pageRows.map((u) => {
    // TM-372: no blank rows. The Email cell falls back to the masked auth phone (or, for a row with
    // no name either, the uid/id tail) via contactCell; the checkbox label uses the full identity
    // chain so a phone-only account is announced and selectable, not "Select " + nothing. The
    // fallback renders on a muted SPAN — never a `tm-muted` td, which is how the e2e specs find the
    // ID cell (`td.tm-muted`).
    const contact = contactCell(u);
    // TM-427: a push-ineligible user (push not enabled, or no registered device) can't be a broadcast
    // recipient — disable the row's checkbox (with an explaining tooltip) and show a "No push" badge, so
    // the admin can't pick someone a push would be silently lost on. The Push cell must NOT be a
    // `tm-muted` td — that selector is how the e2e specs find the ID cell (see the TM-372 note above).
    const eligible = isPushEligible(u);
    return el("tr", { class: isSelf(u) ? "tm-row-self" : null }, [
      el("td", { class: "tm-check-cell" }, [
        el("input", {
          type: "checkbox",
          class: "tm-check",
          checked: state.selection.has(u.id),
          disabled: !eligible,
          title: eligible ? null : PUSH_INELIGIBLE_HINT,
          "aria-label": eligible ? `Select ${displayIdentifier(u)}` : `${displayIdentifier(u)} can't receive push`,
          onChange: (e) => toggleSelected(u, e.target.checked),
        }),
      ]),
      // TM-935: data-label on every body td feeds the CSS stacked-card layout at ≤30rem (the label is
      // shown via td::before so a row reads "Email: …" once the header row is hidden). The leading
      // checkbox + trailing Actions cells carry no label — they're controls, not a labelled field.
      el("td", { "data-label": "Email" }, [el("span", { class: contact.fallback ? "tm-muted" : null, text: contact.text }), isSelf(u) ? el("span", { class: "tm-you", text: "you" }) : null]),
      el("td", { "data-label": "Name", text: u.displayName || "—" }),
      el("td", { "data-label": "Role" }, [roleBadge(u.role)]),
      el("td", { "data-label": "Status" }, [statusBadge(u.enabled)]),
      el("td", { "data-label": "Push" }, [pushBadge(u)]),
      el("td", { "data-label": "ID", class: "tm-muted", text: String(u.id) }),
      el("td", { class: "tm-actions" }, rowActions(u)),
    ]);
  }));

  shell.table.append(stackableTable(el("thead", {}, head), body));
  syncSelectAll();
  renderPager(rows.length);
}

function rowActions(user) {
  const view = el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => openDetail(user) }, "View");
  if (isSelf(user)) {
    // Self-protection: no disable / role-change on your own account (mirrors TM-111's backend rule).
    return [view];
  }
  return [
    view,
    el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => toggleEnabled(user) }, user.enabled ? "Disable" : "Enable"),
    el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => changeRole(user) }, user.role === "ADMIN" ? "Remove admin" : "Make admin"),
  ];
}

function renderPager(totalRows) {
  clear(shell.pager);
  const pageCount = Math.max(1, Math.ceil(totalRows / state.pageSize));
  if (state.page >= pageCount) state.page = pageCount - 1;
  const from = totalRows === 0 ? 0 : state.page * state.pageSize + 1;
  const to = Math.min(totalRows, (state.page + 1) * state.pageSize);

  shell.pager.append(
    el("span", { class: "tm-muted", text: `${from}–${to} of ${totalRows}` }),
    el("div", { class: "tm-pager-controls" }, [
      el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: state.page <= 0, onClick: () => { state.page--; renderTable(); } }, "Prev"),
      el("span", { class: "tm-muted", text: `Page ${state.page + 1} of ${pageCount}` }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: state.page >= pageCount - 1, onClick: () => { state.page++; renderTable(); } }, "Next"),
    ]),
  );
}

function toggleSort(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDir = "asc";
  }
  state.page = 0;
  renderTable();
}

function render() {
  if (!shell) return;
  renderStats();
  renderTable();
  refreshCeilingWarning();
}

// ---- operations panel (TM-183) ------------------------------------------------------------
//
// A panel of operational links on the admin landing page — health, diagnostics, API docs, and the
// cloud/dev consoles — so an admin can jump to them without hunting for URLs. Admin-only by virtue of
// living in the (router-gated, ADMIN-only) #/admin view; the backend stays the real gate. Built entirely
// with the XSS-safe `el()` helper (no innerHTML), and entirely ADDITIVE — nothing here touches the users
// table / broadcast state above (this file is shared with TM-133/TM-172).

/** The runtime config (`window.TEAMMARHABA_CONFIG`) — the injected API base + the `ops*` console ids. */
function opsConfig() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
}

/**
 * Fetch one protected diagnostics endpoint WITH the admin's bearer token and render its JSON into `out`.
 *
 * These endpoints (`/actuator/info`, `/actuator/metrics`) require a Firebase token, so a plain <a href>
 * would 401 (no Authorization header) — hence they're fetched here, not linked. The token comes from
 * auth.js `getIdToken()` (the app's single token source). We deliberately do NOT route through api.js's
 * `apiFetch`: its 401 path force-refreshes and then REDIRECTS to the login screen, whereas a diagnostics
 * widget should degrade to a friendly inline note (per the AC), never bounce the admin out of the console.
 */
async function loadDiagnostic(item, out) {
  const url = diagnosticsUrl(opsConfig(), item.path);
  if (!url) {
    out.textContent = "No API base is configured, so diagnostics can't be reached.";
    return;
  }
  out.textContent = "Loading…";
  let token = null;
  try {
    token = await getIdToken();
  } catch {
    token = null;
  }
  if (!token) {
    // Signed out / no token: a plain link would 401 here. Say so plainly rather than firing a request.
    out.textContent = "Sign in as an admin to view this diagnostic.";
    return;
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      out.textContent = "Not available — the backend rejected the token. Sign in again as an admin.";
      return;
    }
    if (!res.ok) {
      out.textContent = `Request failed (${res.status}).`;
      return;
    }
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch {
    out.textContent = "Couldn't reach the backend.";
  }
}

/** A <ul> of anchor links (App endpoints / Consoles): each row is a new-tab anchor + a one-line note.
 *  `rel="noopener noreferrer"` on every external anchor (no reverse tab-nabbing, no referrer leak). */
function opsLinkList(links) {
  return el("ul", { class: "tm-ops-list" }, links.map((l) =>
    el("li", { class: "tm-ops-item" }, [
      el("a", { class: "tm-ops-link", href: l.href, target: "_blank", rel: "noopener noreferrer" }, l.label),
      el("span", { class: "tm-muted tm-ops-desc", text: l.desc }),
    ])));
}

/** The Diagnostics group: one collapsible <details> per protected endpoint. Fetched LAZILY on first
 *  expand (an admin who never opens it makes no request), with a Refresh button to re-fetch on demand. */
function opsDiagnostics() {
  return el("ul", { class: "tm-ops-list" }, DIAGNOSTICS.map((item) => {
    const out = el("pre", { class: "tm-ops-json", tabindex: "0", "aria-label": `${item.label} response` }, "Not loaded yet.");
    const refresh = el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => loadDiagnostic(item, out) }, "Refresh");
    let loadedOnce = false;
    const details = el("details", { class: "tm-ops-diag" }, [
      el("summary", { class: "tm-ops-diag-summary" }, [
        el("span", { class: "tm-ops-link", text: item.label }),
        el("span", { class: "tm-muted tm-ops-desc", text: item.desc }),
      ]),
      el("div", { class: "tm-ops-diag-body" }, [refresh, out]),
    ]);
    details.addEventListener("toggle", () => {
      if (details.open && !loadedOnce) {
        loadedOnce = true;
        loadDiagnostic(item, out);
      }
    });
    return el("li", { class: "tm-ops-item" }, [details]);
  }));
}

/** Build the whole Operations panel (called once from buildShell). One <section> holding the three
 *  grouped kinds; every URL comes from injected config via admin-ops-core.js — nothing hardcoded here. */
function buildOps() {
  const cfg = opsConfig();
  const app = appLinks(cfg);
  const consoles = consoleLinks(cfg);

  const group = (title, intro, content) =>
    el("div", { class: "tm-ops-group" }, [
      el("h3", { class: "tm-ops-group-title", text: title }),
      el("p", { class: "tm-muted tm-ops-group-intro", text: intro }),
      content,
    ]);

  return el("section", { class: "tm-ops", id: "admin-ops", "aria-label": "Operations" }, [
    el("div", { class: "tm-ops-head" }, [el("h2", { text: "Operations" })]),
    el("p", { class: "tm-muted tm-ops-note", text: "Quick links to health, diagnostics, API docs, and the cloud/dev consoles." }),
    group(
      "App endpoints",
      "Public backend endpoints — open in a new tab.",
      app.length ? opsLinkList(app) : el("p", { class: "tm-muted", text: "No API base is configured." }),
    ),
    group(
      "Diagnostics",
      "Protected actuator endpoints — fetched with your admin token (a plain link would return 401). Expand to load.",
      opsDiagnostics(),
    ),
    group(
      "Consoles",
      "External cloud and developer consoles for this deployment.",
      consoles.length ? opsLinkList(consoles) : el("p", { class: "tm-muted", text: "No console config has been injected." }),
    ),
  ]);
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    type: "search",
    placeholder: "Search name, email, phone…",
    class: "tm-input",
    "aria-label": "Search users",
    onInput: (e) => { state.search = e.target.value; state.page = 0; renderTable(); },
  });
  const roleSelect = el("select", { class: "tm-input", "aria-label": "Filter by role", onChange: (e) => { state.roleFilter = e.target.value; state.page = 0; renderTable(); } }, [
    el("option", { value: "ALL", text: "All roles" }),
    el("option", { value: "USER", text: "Users" }),
    el("option", { value: "ADMIN", text: "Admins" }),
  ]);
  const statusSelect = el("select", { class: "tm-input", "aria-label": "Filter by status", onChange: (e) => { state.statusFilter = e.target.value; state.page = 0; renderTable(); } }, [
    el("option", { value: "ALL", text: "All statuses" }),
    el("option", { value: "ENABLED", text: "Enabled" }),
    el("option", { value: "DISABLED", text: "Disabled" }),
  ]);
  const sizeSelect = el("select", { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderTable(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })));

  const stats = el("div", { class: "tm-stats", id: "admin-stats" });
  const table = el("div", { class: "tm-table-wrap", id: "admin-table" });
  const pager = el("div", { class: "tm-pager", id: "admin-pager" });

  // Init shell before buildCompose (it stashes references on shell.compose) — the compose panel is
  // built ONCE here and mounted OUTSIDE `table`, so renderTable()'s clear(shell.table) never wipes a draft.
  shell = { stats, table, pager, compose: null, selectAll: null };
  const compose = buildCompose();

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      // A crowd doodle beside the heading (TM-215) — decorative; CSS gates it to the doodle theme.
      // No title so it renders aria-hidden — the heading text "Users" already announces it.
      el("h2", {}, [doodle("crowd", { class: "tm-doodle-header" }), "Users"]),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadUsers }, "Refresh"),
    ]),
    stats,
    compose,
    el("div", { class: "tm-toolbar" }, [search, roleSelect, statusSelect, sizeSelect]),
    table,
    pager,
    // TM-183: the Operations panel of links (health / diagnostics / API docs / consoles). Built once,
    // self-contained (no shell state), mounted at the foot of the admin view — purely additive.
    buildOps(),
  );

  // Populate the deep-link picker from the backend allow-list and paint the initial preview / count.
  loadPushRoutes();
  refreshSelectionUi();
}

/** Called by the router when the admin view becomes active. Builds the shell once, then loads. */
export function enterAdmin() {
  const view = document.getElementById("admin-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadUsers();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdmin = { enterAdmin, loadUsers };
}
