// Admin users console (TM-133) — ADMIN-only. The first real consumer of RBAC (TM-110) and the
// admin endpoints (TM-111): lists accounts, with client-side search / role+status filter / sort /
// pagination and a stats bar, and per-user enable-disable + set-role behind a styled confirm +
// toast (with undo). Destructive actions on your own account are hidden (mirrors the backend
// self-protection in TM-111). Mounts into #admin-view; the router (TM-109) gates the route.
//
// Backend note: TM-111 supports page/size/sort but not yet search/role/status filters (TM-115),
// so we fetch the full set (size cap 100) once and filter/sort/paginate in the browser. Fine for
// the current small user base; >100 users needs server-side filtering (flagged on TM-133/TM-115).

import { apiFetch, adminBroadcastPush, getPushRoutes, ApiError as ApiClientError } from "./api.js";
import { currentUser } from "./auth.js";
import { clear, confirmDialog, el, modal, copyToClipboard, relativeTime, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { confirmSensitiveAction } from "./biometric-confirm.js";
import { renderAccountBadges } from "./account-badges.js";
import { KNOWN_ROUTES } from "./push-deeplink.js";
import {
  MAX_TITLE,
  MAX_BODY,
  NO_ROUTE,
  validateBroadcast,
  routeOptionsFrom,
  summariseBroadcast,
} from "./broadcast.js";

const FETCH_SIZE = 100; // matches TM-111's max page size
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
  broadcast: { routeOptions: null },
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

export async function loadUsers() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await apiFetch(`/api/v1/admin/users?page=0&size=${FETCH_SIZE}&sort=id,asc`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 403) throw new ApiError(403, "You need an admin role to view this page.");
    if (!res.ok) throw new ApiError(res.status, `Could not load users (${res.status}).`);
    const body = await res.json();
    state.users = Array.isArray(body.items) ? body.items : [];
  } catch (err) {
    // 401 is already handled by api.js (token refresh + redirect); surface everything else.
    state.error = err instanceof ApiError ? err.message : "Could not load users.";
    state.users = [];
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
      const hay = `${u.email || ""} ${u.displayName || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
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

/** Toggle one user's membership in the broadcast selection (persisted by id across paging/filtering). */
function toggleSelected(user, on) {
  if (on) state.selection.add(user.id);
  else state.selection.delete(user.id);
  // Only the compose panel + the header select-all state change — no need to rebuild the whole table.
  refreshSelectionUi();
  syncSelectAll();
}

/**
 * Select-all over the CURRENTLY-FILTERED set (not just the visible page): add every matching user's id
 * when not all are selected, otherwise clear them. Selections outside the current filter are left
 * untouched, so narrowing the filter, selecting, then widening it keeps the earlier picks.
 */
function toggleSelectAllMatching(on) {
  const matching = matchingUsers();
  for (const u of matching) {
    if (on) state.selection.add(u.id);
    else state.selection.delete(u.id);
  }
  // The checkboxes on the visible page need repainting, so re-render the table body here.
  renderTable();
  refreshSelectionUi();
}

/** How many of the currently-filtered users are selected — drives the select-all checked/indeterminate. */
function matchingSelectedCount() {
  const matching = matchingUsers();
  let n = 0;
  for (const u of matching) if (state.selection.has(u.id)) n += 1;
  return n;
}

/** Reflect the current selection onto the header select-all checkbox (checked / indeterminate / off). */
function syncSelectAll() {
  const box = shell?.selectAll;
  if (!box) return;
  const matching = matchingUsers();
  const selected = matchingSelectedCount();
  box.checked = matching.length > 0 && selected === matching.length;
  box.indeterminate = selected > 0 && selected < matching.length;
  box.disabled = matching.length === 0;
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
    message: disabling
      ? `${user.email || "This user"} will be blocked on their next request until re-enabled.`
      : `${user.email || "This user"} will be able to sign in again.`,
    confirmLabel: disabling ? "Disable" : "Enable",
    danger: disabling,
  });
  if (!ok) return;
  await applyPatch(user, { enabled: !user.enabled }, {
    successMsg: disabling ? "Account disabled" : "Account enabled",
    undo: () => applyPatch(user, { enabled: user.enabled }, { successMsg: "Reverted" }),
  });
}

async function changeRole(user) {
  const next = user.role === "ADMIN" ? "USER" : "ADMIN";
  const promoting = next === "ADMIN";
  const ok = await confirmDialog({
    title: promoting ? "Make admin?" : "Remove admin?",
    message: promoting
      ? `${user.email || "This user"} will get full admin access (effective on their next sign-in/token refresh).`
      : `${user.email || "This user"} will lose admin access (effective on their next token refresh).`,
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
    toast("Role change cancelled — not verified", { type: "info" });
    return;
  }
  await applyPatch(user, { role: next }, {
    successMsg: `Role changed to ${next}`,
    undo: () => applyPatch(user, { role: user.role }, { successMsg: "Reverted" }),
  });
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
    el("h3", { class: "tm-detail-h", text: "Recent activity" }),
    el("p", { class: "tm-muted", id: "tm-activity" }, "Loading…"),
  ];
  const { close } = modal(`User · ${user.email || user.id}`, body);
  loadActivity(user);
  return close;
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
// the raw "#/home". Any route not in this map falls back to its raw value (still a valid, safe option),
// so a newly-added backend route shows up immediately — just without a pretty label until added here.
const ROUTE_LABELS = Object.freeze({
  "#/home": "Home",
  "#/profile": "Profile",
  "#/admin": "Admin console",
  "#/help": "Help",
  "#/onboarding": "Onboarding",
  "#/login": "Sign in",
});

function routeLabel(route) {
  return ROUTE_LABELS[route] || route;
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
  // Show the length errors as the user types; the empty-recipient hint shows only once they've started
  // composing (so a pristine, untouched panel isn't shouting "select a recipient" before any intent).
  setComposeError("title", title);
  setComposeError("body", body);
  c.recipientHint.textContent = recipients || "";
  c.recipientHint.hidden = !recipients;
  c.send.disabled = !canSend || c.sendingBusy;
  updatePreview();
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
    renderTable(); // repaint the row checkboxes now that the selection is empty
    refreshSelectionUi();
  } catch (err) {
    const msg = err instanceof ApiClientError ? err.message : "Could not send the broadcast.";
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

  // Live inline errors clear as the user types (mirrors profile.js's live-clear).
  title.addEventListener("input", () => refreshSelectionUi());
  body.addEventListener("input", () => refreshSelectionUi());

  const recipientHint = el("p", { id: "admin-broadcast-recipients", class: "tm-field-error", role: "alert", hidden: true });

  // The faithful preview — title as the headline, body beneath, exactly as they'd read on the native
  // shade. The route is invisible metadata on a real push, so it's shown only as a caption below.
  const previewTitle = el("p", { class: "tm-push-preview-title tm-push-preview-placeholder", text: "Notification title" });
  const previewBody = el("p", { class: "tm-push-preview-body tm-push-preview-placeholder", text: "Your message will appear here." });
  const previewCaption = el("p", { class: "tm-push-preview-caption", text: "Tapping opens: the app" });
  const preview = el("div", { class: "tm-push-preview", id: "admin-broadcast-preview", "aria-hidden": "true" }, [
    el("div", { class: "tm-push-preview-app" }, [
      doodle("chat", { class: "tm-push-preview-icon" }),
      el("span", { class: "tm-push-preview-appname", text: "TeamMarhaba · now" }),
    ]),
    previewTitle,
    previewBody,
    previewCaption,
  ]);

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
    el("p", { class: "tm-muted tm-broadcast-note", text: "Pick recipients in the table below (select-all covers everyone matching your current filter), compose your message, preview it, then send." }),
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
    count, recipientHint,
    previewTitle, previewBody, previewCaption,
    errors: { title: titleError, body: bodyError },
    sendingBusy: false,
  };
  return panel;
}

// ---- rendering ----------------------------------------------------------------------------

function roleBadge(role) {
  return el("span", { class: `tm-badge tm-badge-role-${role.toLowerCase()}`, text: role });
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
  const total = state.users.length;
  const admins = state.users.filter((u) => u.role === "ADMIN").length;
  const enabled = state.users.filter((u) => u.enabled).length;
  const cards = [
    ["Total", total],
    ["Admins", admins],
    ["Enabled", enabled],
    ["Disabled", total - enabled],
  ];
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
    shell.table.append(el("p", { class: "tm-muted", text: "Loading users…" }));
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

  const start = state.page * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  // Leading select-all checkbox (TM-365): toggles the whole CURRENTLY-FILTERED set — not just the
  // visible page — so it's labelled accordingly. Its checked/indeterminate state is synced after render.
  const selectAll = el("input", {
    type: "checkbox",
    class: "tm-check",
    id: "admin-select-all",
    "aria-label": "Select all users matching the current filter",
    title: "Select all matching the filter (not just this page)",
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

  const body = el("tbody", {}, pageRows.map((u) => el("tr", { class: isSelf(u) ? "tm-row-self" : null }, [
    el("td", { class: "tm-check-cell" }, [
      el("input", {
        type: "checkbox",
        class: "tm-check",
        checked: state.selection.has(u.id),
        "aria-label": `Select ${u.email || `user ${u.id}`}`,
        onChange: (e) => toggleSelected(u, e.target.checked),
      }),
    ]),
    el("td", {}, [el("span", { text: u.email || "—" }), isSelf(u) ? el("span", { class: "tm-you", text: "you" }) : null]),
    el("td", { text: u.displayName || "—" }),
    el("td", {}, [roleBadge(u.role)]),
    el("td", {}, [statusBadge(u.enabled)]),
    el("td", { class: "tm-muted", text: String(u.id) }),
    el("td", { class: "tm-actions" }, rowActions(u)),
  ])));

  shell.table.append(el("table", { class: "tm-table" }, [el("thead", {}, head), body]));
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
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    type: "search",
    placeholder: "Search email or name…",
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
