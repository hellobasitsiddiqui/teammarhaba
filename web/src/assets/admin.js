// Admin users console (TM-133) — ADMIN-only. The first real consumer of RBAC (TM-110) and the
// admin endpoints (TM-111): lists accounts, with client-side search / role+status filter / sort /
// pagination and a stats bar, and per-user enable-disable + set-role behind a styled confirm +
// toast (with undo). Destructive actions on your own account are hidden (mirrors the backend
// self-protection in TM-111). Mounts into #admin-view; the router (TM-109) gates the route.
//
// Backend note: TM-111 supports page/size/sort but not yet search/role/status filters (TM-115),
// so we fetch the full set (size cap 100) once and filter/sort/paginate in the browser. Fine for
// the current small user base; >100 users needs server-side filtering (flagged on TM-133/TM-115).

import { apiFetch } from "./api.js";
import { currentUser } from "./auth.js";
import { clear, confirmDialog, el, modal, copyToClipboard, relativeTime, toast } from "./ui.js";
import { doodle } from "./doodles.js";

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

// ---- rendering ----------------------------------------------------------------------------

function roleBadge(role) {
  return el("span", { class: `tm-badge tm-badge-role-${role.toLowerCase()}`, text: role });
}

function statusBadge(enabled) {
  return el("span", { class: `tm-badge ${enabled ? "tm-badge-ok" : "tm-badge-off"}`, text: enabled ? "Enabled" : "Disabled" });
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
    shell.table.append(el("div", { class: "tm-empty" }, [
      doodle("crowd", { class: "tm-doodle-empty", title: message }),
      el("p", { class: "tm-muted", text: message }),
    ]));
    renderPager(0);
    return;
  }

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
  }).concat(el("th", { scope: "col", text: "Actions" })));

  const body = el("tbody", {}, pageRows.map((u) => el("tr", { class: isSelf(u) ? "tm-row-self" : null }, [
    el("td", {}, [el("span", { text: u.email || "—" }), isSelf(u) ? el("span", { class: "tm-you", text: "you" }) : null]),
    el("td", { text: u.displayName || "—" }),
    el("td", {}, [roleBadge(u.role)]),
    el("td", {}, [statusBadge(u.enabled)]),
    el("td", { class: "tm-muted", text: String(u.id) }),
    el("td", { class: "tm-actions" }, rowActions(u)),
  ])));

  shell.table.append(el("table", { class: "tm-table" }, [el("thead", {}, head), body]));
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

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      // A crowd doodle beside the heading (TM-215) — decorative; CSS gates it to the doodle theme.
      el("h2", {}, [doodle("crowd", { class: "tm-doodle-header", title: "Users" }), "Users"]),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadUsers }, "Refresh"),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, roleSelect, statusSelect, sizeSelect]),
    table,
    pager,
  );
  shell = { stats, table, pager };
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
