// Send notification — the push-broadcast compose + its recipient picker, lifted to its own screen
// (TM-972). Originally this lived BURIED inside the users console (admin.js, TM-365/TM-427); TM-972
// relocates it to its own admin-hub fold at #/admin/notifications ("Send notification"). Behaviour is
// unchanged — same API (POST /api/v1/admin/push/broadcast via adminBroadcastPush), same cap, same
// push-eligibility rules, same select-all.
//
// The critical coupling (why the recipient picker moved WITH the broadcast): the compose selects its
// recipients FROM a user list — it reads a `selection` of user ids checked in a table, and only
// push-eligible users are selectable (TM-427). So this screen carries its OWN user roster (the full
// account walk + checkboxes + push badges + search + select-all) — exactly as the users console did —
// while the users console it left behind keeps ONLY user MANAGEMENT (enable/disable/role/stats/search).
//
// Mounts into #admin-notifications-view; the router (TM-133) gates the route ADMIN-only, same as every
// other #/admin route. Heading-first (renders its own <h1>) per the chrome rules (TM-908/909/910).
//
// Identity note (TM-372): a phone-auth account may have NO email and NO display name, so every render/
// search of a user goes through the broadcast.js display-identity chain (displayName → email → masked
// auth phone → uid-prefix → "User #id"). The push-routes allow-list (TM-360) is the SHARED backend
// source (getPushRoutes) with the client KNOWN_ROUTES fallback — the same single source the in-app
// message compose (admin-messages.js) uses.

import { apiFetch, adminBroadcastPush, getPushRoutes, ApiError as ApiClientError } from "./api.js";
import { clear, el, stackableTable, toast, confirmDialog } from "./ui.js";
import { doodle } from "./doodles.js";
import { KNOWN_ROUTES } from "./push-deeplink.js";
import { clampPage } from "./admin-paging-core.js";
import {
  MAX_TITLE,
  MAX_BODY,
  MAX_RECIPIENTS,
  NO_ROUTE,
  validateBroadcast,
  composeErrorsToShow,
  routeOptionsFrom,
  humanizeRoute,
  summariseBroadcast,
  // TM-372: the display-identity fallback chain, so phone-only accounts never render as blank rows.
  contactCell,
  displayIdentifier,
  searchHaystack,
  // TM-370: the full-account-set page walk — one-page fetches until the whole list is in memory, so
  // select-all/search cover every account, not just the first 100.
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

const state = {
  users: [],
  // TM-370: the server-reported account total and whether the page walk covered the whole list.
  totalAccounts: 0,
  fetchComplete: true,
  loading: false,
  error: null,
  search: "",
  page: 0,
  pageSize: 25,
  // Broadcast compose (TM-365). `selection` persists picked user ids across paging/filtering (by id,
  // not by row), so a draft audience survives the roster churn. The compose panel is a stable node
  // built once (see buildCompose) and mutated in place — never rebuilt on a keystroke.
  selection: new Set(),
  // Cache of the deep-link options once fetched; the draft itself lives on the live inputs (draft()).
  // TM-976 (A8): which compose fields the admin has interacted with, so a pristine panel shows no
  // errors. title/body flip on input; recipients on any selection change; all reset after a send.
  broadcast: { routeOptions: null, touched: { title: false, body: false, recipients: false } },
};

let shell = null; // { roster, pager, compose, selectAll } persistent containers

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- data ---------------------------------------------------------------------------------

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

async function loadUsers() {
  // Re-entry guard (mirrors admin.js / TM-721): a second load while one is running would start a whole
  // second concurrent page walk, doubling the request volume and racing two result sets into state.
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    // TM-370: walk EVERY page of the endpoint (100 per request) so the in-memory set — and with it
    // search + select-all — covers the WHOLE account list, not just the first 100.
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
    state.fetchComplete = true; // nothing partial to warn about — the roster shows the error instead
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
    if (q) {
      // TM-372: match the whole identity chain (name, email, auth phone raw + masked, "User #id").
      if (!searchHaystack(u).includes(q)) return false;
    }
    return true;
  });
}

/** Roster order: by id ascending (stable, matches the fetch order) — the recipient picker doesn't need
 *  the management console's sortable columns, just a stable, predictable list to pick from. */
function sortUsers(list) {
  return [...list].sort((a, b) => {
    const av = a.id;
    const bv = b.id;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
}

// ---- selection (broadcast recipients, TM-365) ---------------------------------------------

/** The users currently matching the search (the set select-all operates over), stably ordered. */
function matchingUsers() {
  return sortUsers(filteredUsers());
}

/** The push-eligible subset of the currently-filtered set — the real target of select-all (TM-427),
 *  so a push-ineligible user can never be swept into the selection. */
function eligibleMatchingUsers() {
  return eligibleRecipients(matchingUsers());
}

/** After a (re)load, drop any selected user who is now push-ineligible in the fresh set (TM-427). Ids
 *  not present in the loaded set are left alone — there's nothing to re-evaluate them against. */
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
  // Only the compose panel + the header select-all state change — no need to rebuild the whole roster.
  refreshSelectionUi();
  syncSelectAll();
}

/**
 * Select-all over the CURRENTLY-FILTERED set (not just the visible page): add every matching eligible
 * user's id when not all are selected, otherwise clear them. Selections outside the current filter are
 * left untouched. Since TM-370 the fetched set is the WHOLE account list, so "matching" genuinely means
 * everyone matching.
 */
function toggleSelectAllMatching(on) {
  if (on) {
    // Only ever select users a push can actually reach (TM-427) — ineligible rows are left untouched.
    for (const u of eligibleMatchingUsers()) state.selection.add(u.id);
  } else {
    // Deselect clears the whole matching set (eligible or not), so no stray id survives a toggle-off.
    for (const u of matchingUsers()) state.selection.delete(u.id);
  }
  // Select-all can legitimately exceed the broadcast API's hard recipient cap. Selecting past it is
  // allowed (the admin may be about to narrow down) but say so IMMEDIATELY; the Send-gate stays closed
  // with the same rule (validateBroadcast) until the count is back under.
  const capMsg = on ? selectionCapMessage(state.selection.size) : "";
  if (capMsg) toast(capMsg, { type: "info", timeout: 8000 });
  state.broadcast.touched.recipients = true; // TM-976 (A8): select-all is a recipient interaction too.
  // The checkboxes on the visible page need repainting, so re-render the roster body here.
  renderRoster();
  refreshSelectionUi();
}

/** How many of the currently-filtered ELIGIBLE users are selected (TM-427) — drives the header
 *  select-all checked/indeterminate against the reachable set, since only those can be selected. */
function matchingSelectedCount() {
  let n = 0;
  for (const u of eligibleMatchingUsers()) if (state.selection.has(u.id)) n += 1;
  return n;
}

/** Reflect the current selection onto the header select-all checkbox (checked / indeterminate / off). */
function syncSelectAll() {
  const box = shell?.selectAll;
  if (!box) return;
  const eligible = eligibleMatchingUsers();
  const selected = matchingSelectedCount();
  box.checked = eligible.length > 0 && selected === eligible.length;
  box.indeterminate = selected > 0 && selected < eligible.length;
  box.disabled = eligible.length === 0;
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
 * Cheap and idempotent — it only mutates the stable compose nodes in place (never rebuilds them).
 */
function refreshSelectionUi() {
  const c = shell?.compose;
  if (!c) return;
  const n = state.selection.size;
  c.count.textContent = `${n} selected`;
  const { title, body, recipients, canSend } = validateBroadcast(draft());
  // Send is gated by canSend (the real validation) regardless — but the VISIBLE errors are gated by
  // what the admin has touched (TM-976 / A8), so a pristine, untouched panel doesn't shout "required"
  // before any intent. A field's error surfaces once it's touched; the empty-recipient hint once
  // they've engaged at all (see composeErrorsToShow).
  const show = composeErrorsToShow({ title, body, recipients }, state.broadcast.touched);
  setComposeError("title", show.title);
  setComposeError("body", show.body);
  c.recipientHint.textContent = show.recipients || "";
  c.recipientHint.hidden = !show.recipients;
  c.send.disabled = !canSend || c.sendingBusy;
  updatePreview();
}

/**
 * Coverage warning (TM-370). This fires only when a fetch came back PARTIAL (a later page failed
 * mid-walk, or the runaway page guard tripped), stating exactly how many accounts are loaded vs the
 * server total so select-all's real reach is never overstated. Hidden on a complete fetch (the normal
 * case), while loading, and on a full load error (the roster already shows that).
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
  // it as a caption so the admin knows where a tap lands, without pretending it's part of the push.
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
 * selected; this adds an explicit, dangerous confirm because a delivered push is irreversible — there
 * is deliberately NO undo toast. On success we toast an honest summary read from the response (sent /
 * delivered / skipped); on failure we surface the RFC-7807 message.
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
    renderRoster(); // repaint the row checkboxes now that the selection is empty
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
 * Build the broadcast compose panel ONCE (called from buildShell). It lives OUTSIDE the roster — which
 * renderRoster() clears on every keystroke/filter — so an in-progress draft survives roster churn.
 * Fields reuse the profile.js form markup. Returns the panel node; live references are stashed on
 * shell.compose for in-place updates.
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

  // Partial-coverage warning (TM-370): fires only when a load came back incomplete. Built hidden and
  // textless; refreshCeilingWarning() fills the live "Loaded X of Y accounts" copy after loadUsers().
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
      el("h2", { class: "tm-broadcast-title", text: "Compose" }),
      count,
    ]),
    el("p", { class: "tm-muted tm-broadcast-note", text: `Pick recipients in the table below — only users who can receive push (push enabled and a registered device) are selectable; select-all covers everyone eligible matching your search, across the whole account list. Compose your message, preview it, then send. A single broadcast can reach up to ${MAX_RECIPIENTS} recipients.` }),
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

// ---- recipient roster ---------------------------------------------------------------------

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

function renderRoster() {
  clear(shell.roster);
  // The header select-all lives inside the roster, which we've just cleared — drop the stale reference
  // so syncSelectAll() is a no-op until a real roster (with the checkbox) is rebuilt below.
  if (shell) shell.selectAll = null;

  if (state.loading) {
    shell.roster.append(el("p", { class: "tm-muted tm-table-loading", text: "Loading users…" }));
    return;
  }
  if (state.error) {
    shell.roster.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.error }),
      el("button", { class: "tm-btn", type: "button", onClick: loadUsers }, "Retry"),
    ]));
    return;
  }

  const rows = matchingUsers();
  if (!rows.length) {
    const filtered = state.users.length > 0;
    const message = filtered ? "No users match your search." : "No users yet.";
    shell.roster.append(el("div", { class: "tm-empty" }, [
      doodle("crowd", { class: "tm-doodle-empty" }),
      el("p", { class: "tm-muted", text: message }),
    ]));
    renderPager(0);
    return;
  }

  // Clamp a stale page index BEFORE slicing (a narrower search can shrink rows below the page start).
  state.page = clampPage(state.page, rows.length, state.pageSize);
  const start = state.page * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  // Leading select-all checkbox (TM-365): toggles the whole CURRENTLY-FILTERED set — not just the
  // visible page. Its checked/indeterminate state is synced after render.
  const selectAll = el("input", {
    type: "checkbox",
    class: "tm-check",
    id: "admin-select-all",
    "aria-label": "Select all users matching the current search",
    title: "Select all users matching the current search (across the whole list, not just this page)",
    onChange: (e) => toggleSelectAllMatching(e.target.checked),
  });
  shell.selectAll = selectAll;

  const head = el("tr", {}, [
    el("th", { scope: "col", class: "tm-check-cell" }, [selectAll]),
    el("th", { scope: "col", text: "Recipient" }),
    el("th", { scope: "col", text: "Push" }),
    el("th", { scope: "col", text: "ID" }),
  ]);

  const body = el("tbody", {}, pageRows.map((u) => {
    // TM-372: no blank rows. The Recipient cell falls back to the masked auth phone (or, for a row with
    // no name either, the uid/id tail) via contactCell; the checkbox label uses the full identity chain.
    const contact = contactCell(u);
    // TM-427: a push-ineligible user can't be a broadcast recipient — disable the row's checkbox (with
    // an explaining tooltip) and show a "No push" badge, so the admin can't pick someone a push would be
    // silently lost on. The ID cell keeps the `tm-muted` td class the e2e specs use to find it.
    const eligible = isPushEligible(u);
    return el("tr", {}, [
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
      el("td", { "data-label": "Recipient" }, [el("span", { class: contact.fallback ? "tm-muted" : null, text: contact.text })]),
      el("td", { "data-label": "Push" }, [pushBadge(u)]),
      el("td", { "data-label": "ID", class: "tm-muted", text: String(u.id) }),
    ]);
  }));

  shell.roster.append(stackableTable(el("thead", {}, head), body));
  syncSelectAll();
  renderPager(rows.length);
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
      el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: state.page <= 0, onClick: () => { state.page--; renderRoster(); } }, "Prev"),
      el("span", { class: "tm-muted", text: `Page ${state.page + 1} of ${pageCount}` }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: state.page >= pageCount - 1, onClick: () => { state.page++; renderRoster(); } }, "Next"),
    ]),
  );
}

function render() {
  if (!shell) return;
  renderRoster();
  refreshCeilingWarning();
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    type: "search",
    placeholder: "Search name, email, phone…",
    class: "tm-input",
    "aria-label": "Search recipients",
    onInput: (e) => { state.search = e.target.value; state.page = 0; renderRoster(); },
  });
  const sizeSelect = el("select", { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderRoster(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })));

  const roster = el("div", { class: "tm-table-wrap", id: "admin-notifications-roster" });
  const pager = el("div", { class: "tm-pager", id: "admin-notifications-pager" });

  // Init shell before buildCompose (it stashes references on shell.compose). The compose panel is built
  // ONCE here and mounted OUTSIDE the roster, so renderRoster()'s clear(shell.roster) never wipes a draft.
  shell = { roster, pager, compose: null, selectAll: null };
  const compose = buildCompose();

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      // A crowd doodle beside the heading (decorative; CSS gates it to the doodle theme).
      el("h1", {}, [doodle("crowd", { class: "tm-doodle-header" }), "Send notification"]),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadUsers }, "Refresh"),
    ]),
    compose,
    el("h2", { class: "tm-broadcast-recipients-title", text: "Recipients" }),
    el("div", { class: "tm-toolbar" }, [search, sizeSelect]),
    roster,
    pager,
  );

  // Populate the deep-link picker from the backend allow-list and paint the initial preview / count.
  loadPushRoutes();
  refreshSelectionUi();
}

/** Called by the router when the notification view becomes active. Builds the shell once, then loads. */
export function enterAdminNotifications() {
  const view = document.getElementById("admin-notifications-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadUsers();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminNotifications = { enterAdminNotifications, loadUsers };
}
