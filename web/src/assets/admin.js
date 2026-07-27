// Admin users console (TM-133) — ADMIN-only. The first real consumer of RBAC (TM-110) and the
// admin endpoints (TM-111): user MANAGEMENT — lists accounts, with client-side search / role+status
// filter / sort / pagination and a stats bar, and per-user enable-disable + set-role behind a styled
// confirm + toast (with undo). Destructive actions on your own account are hidden (mirrors the backend
// self-protection in TM-111). Mounts into #admin-view; the router (TM-109) gates the route.
//
// TM-972 (admin hub IA — lift-and-shift): the push-broadcast compose (+ its recipient picker) and the
// Operations panel that used to live INSIDE this console were LIFTED OUT to their own admin-hub folds —
// "Send notification" (#/admin/notifications, admin-notifications.js) and "Developer tools"
// (#/admin/ops, admin-ops.js). This console is now user MANAGEMENT only: NO broadcast compose, NO ops.
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

import { apiFetch } from "./api.js";
import { currentUser } from "./auth.js";
import { clear, confirmDialog, el, modal, copyToClipboard, relativeTime, stackableTable, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { confirmSensitiveAction } from "./biometric-confirm.js";
import { renderAccountBadges } from "./account-badges.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";
// TM-847: the pure role→friendly-label mapping (TM-612), extracted so it's unit-testable.
import { roleLabel } from "./admin-role-label-core.js";
// TM-172: the admin user-detail PROFILE edit — pure field descriptors + validators + patch builder,
// reusing the SAME shared self-edit validation (profile-core.js) so the admin edit can't drift looser.
import { ADMIN_PROFILE_FIELDS, validateAdminField, validateAdminForm, buildAdminProfilePatch } from "./admin-profile-edit-core.js";
import {
  // TM-372: the display-identity fallback chain (displayName → email → masked auth phone →
  // uid-prefix → "User #id"), so phone-only accounts never render as blank, unfindable rows.
  contactCell,
  displayIdentifier,
  searchHaystack,
  // TM-370: the full-account-set page walk — loadUsers feeds it one-page fetches until the whole
  // list is in memory, so search/stats cover every account, not just the first 100.
  fetchAllUsers,
} from "./broadcast.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-list walk — matches TM-111's max page size
const PAGE_SIZES = [10, 25, 50];

const COLUMNS = [
  { key: "email", label: "Email", sortable: true },
  { key: "displayName", label: "Name", sortable: true },
  { key: "role", label: "Role", sortable: true },
  { key: "enabled", label: "Status", sortable: true },
  { key: "id", label: "ID", sortable: true },
];

const state = {
  users: [],
  // TM-370: the server-reported account total — the real total shown on the stats bar even if a partial
  // fetch loaded fewer. On the normal, complete fetch totalAccounts === users.length.
  totalAccounts: 0,
  loading: false,
  error: null,
  search: "",
  roleFilter: "ALL",
  statusFilter: "ALL",
  sortKey: "id",
  sortDir: "asc",
  page: 0,
  pageSize: 25,
};

let shell = null; // { stats, table, pager } persistent containers

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
    // search and the stats bar — covers the WHOLE account list, not just the first 100.
    // A page failing mid-walk keeps what loaded; only a failure with nothing loaded reaches the catch
    // below and errors the table.
    const { users, total } = await fetchAllUsers(fetchUsersPage, { pageSize: FETCH_SIZE });
    state.users = users;
    state.totalAccounts = total;
  } catch (err) {
    // 401 is already handled by api.js (token refresh + redirect); surface everything else.
    state.error = err instanceof ApiError ? err.message : "Could not load users.";
    state.users = [];
    state.totalAccounts = 0;
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
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
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

  const head = el("tr", {}, COLUMNS.map((c) => {
    const active = state.sortKey === c.key;
    const arrow = active ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
    return el("th", {
      class: c.sortable ? "tm-sortable" : null,
      scope: "col",
      "aria-sort": active ? (state.sortDir === "asc" ? "ascending" : "descending") : null,
      onClick: c.sortable ? () => toggleSort(c.key) : null,
    }, `${c.label}${arrow}`);
  }).concat(
    el("th", { scope: "col", text: "Actions" }),
  ));

  const body = el("tbody", {}, pageRows.map((u) => {
    // TM-372: no blank rows. The Email cell falls back to the masked auth phone (or, for a row with
    // no name either, the uid/id tail) via contactCell. The fallback renders on a muted SPAN — never a
    // `tm-muted` td, which is how the e2e specs find the ID cell (`td.tm-muted`).
    const contact = contactCell(u);
    return el("tr", { class: isSelf(u) ? "tm-row-self" : null }, [
      // TM-935: data-label on every body td feeds the CSS stacked-card layout at ≤30rem (the label is
      // shown via td::before so a row reads "Email: …" once the header row is hidden). The trailing
      // Actions cell carries no label — it's controls, not a labelled field.
      el("td", { "data-label": "Email" }, [el("span", { class: contact.fallback ? "tm-muted" : null, text: contact.text }), isSelf(u) ? el("span", { class: "tm-you", text: "you" }) : null]),
      el("td", { "data-label": "Name", text: u.displayName || "—" }),
      el("td", { "data-label": "Role" }, [roleBadge(u.role)]),
      el("td", { "data-label": "Status" }, [statusBadge(u.enabled)]),
      el("td", { "data-label": "ID", class: "tm-muted", text: String(u.id) }),
      el("td", { class: "tm-actions" }, rowActions(u)),
    ]);
  }));

  shell.table.append(stackableTable(el("thead", {}, head), body));
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

  shell = { stats, table, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      // A crowd doodle beside the heading (TM-215) — decorative; CSS gates it to the doodle theme.
      // No title so it renders aria-hidden — the heading text "Users" already announces it.
      el("h2", {}, [doodle("crowd", { class: "tm-doodle-header" }), "Users"]),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadUsers }, "Refresh"),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, roleSelect, statusSelect, sizeSelect]),
    table,
    pager,
  );
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
