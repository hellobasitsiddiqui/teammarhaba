// Admin message compose — the DOM half (TM-443, epic TM-432, group-admin-messaging).
//
// The full-page compose screen an admin uses to write and send an in-app message to a targeted
// audience. It opens on its OWN admin route (#/admin/messages/new, admin-message-route.js) — NOT a
// modal — mirroring the event-form page decision (TM-426), so the form scrolls and the audience picker
// + Send button stay reachable on any viewport. router.js gates the route ADMIN-only (same gate as
// #/admin) and mounts this into #admin-message-form-view; the backend (TM-441) is the real authority.
//
// All the load-bearing logic — validation, the exactly-one-target-type payload build, the
// ~50-recipient confirmation, the success summary — lives in the pure, unit-tested admin-messages-core.js
// (the broadcast.js / event-form.js split), because THIS module transitively imports the Firebase SDK
// (via api.js → auth.js) and so can't run under the Node test runner. This file is the wiring: build
// the controls, load the picker data, keep the live draft, confirm, POST, and route back.
//
// AUDIENCE (the product rule, TM-441 + the pinned clarification): one send targets exactly ONE type —
//   • a single user   (a searchable user picker),
//   • a city          (a city input with suggestions), or
//   • one or more events (an event multi-select).
// A target-type toggle is the single source of truth for which dimension is live; switching it shows
// that picker and hides the others, so "not combined (no AND/OR)" is structural, not a runtime check.
//
// Unlike the push broadcast (admin.js / broadcast.js), the audience here is NOT filtered by
// push-eligibility: an admin message is delivered durably to EVERY active recipient's in-app inbox
// regardless of their push preference (the backend writes the inbox row pref-independently and only the
// best-effort push on top respects opt-out). So the user picker offers all accounts, not just push-able
// ones — a deliberate difference from the broadcast compose panel.

import { apiFetch, sendAdminMessage, recallAdminMessage, getPushRoutes, ApiError } from "./api.js";
import { clear, el, confirmDialog, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { KNOWN_ROUTES } from "./push-deeplink.js";
// The sent-history list route (TM-444) — where compose returns to on send / cancel now that the list exists.
import { ADMIN_MESSAGES_ROUTE } from "./admin-message-route.js";
// Reused from the broadcast module (all pure, browser-safe): the full-account page walk, the
// display-identity fallback chain (so a phone-only account is never a blank, unfindable row — TM-372),
// the search haystack, and the deep-link option normaliser (the single source of truth for the picker).
import { fetchAllUsers, displayIdentifier, searchHaystack, routeOptionsFrom, humanizeRoute } from "./broadcast.js";
// Reused from the events form module (pure): render an event's start instant in its own timezone.
import { formatEventWhen } from "./event-form.js";
import {
  MAX_TITLE,
  MAX_BODY,
  NO_ROUTE,
  TARGET_TYPES,
  validateAdminMessage,
  buildAdminMessagePayload,
  confirmCopy,
  summariseSend,
} from "./admin-messages-core.js";
// Recall control — pure confirm/label/summary logic (TM-473), shared with TM-444's sent-history rows.
import {
  RECALL_LABEL,
  RECALLED_LABEL,
  recallConfirmCopy,
  summariseRecall,
} from "./admin-message-recall-core.js";

// Where compose returns to on success / cancel: the sent-history LIST at ADMIN_MESSAGES_ROUTE
// (#/admin/messages), now that TM-444 has landed it — the AC's "returns to the messages list /
// sent-history". (Before the list existed, TM-443 returned to the admin console as a stand-in; this is
// that loose end wired up.) A just-sent campaign shows at the top of the list, which reloads on entry.
const RETURN_ROUTE = ADMIN_MESSAGES_ROUTE;

const FETCH_SIZE = 100; // page size per request for the account + event walks (matches the admin caps)
const MAX_EVENT_PAGES = 50; // runaway guard for the event walk (mirrors admin-events.js)
const USER_RESULTS_LIMIT = 8; // how many search matches the user picker shows at once (a focused list)

// Human labels for the deep-link routes in the picker, so the admin reads "Home" not "#/home" (mirrors
// admin.js ROUTE_LABELS). An unmapped-but-valid route falls back to a humanised label (TM-617) —
// "Event detail", not a raw "#/event-detail" token — via the shared humanizeRoute helper.
const ROUTE_LABELS = Object.freeze({
  "#/home": "Home",
  "#/profile": "Profile",
  "#/events": "Events",
  "#/chat": "Chat",
  "#/notifications": "Notifications",
  "#/admin": "Admin console",
  "#/help": "Help",
});

function routeLabel(route) {
  return ROUTE_LABELS[route] || humanizeRoute(route);
}

// ---- state --------------------------------------------------------------------------------

const state = {
  // Picker data, lazily loaded the first time its dimension is shown. `null` = not loaded yet.
  users: null,
  usersLoading: false,
  usersError: null,
  events: null,
  eventsLoading: false,
  eventsError: null,
  routeOptions: null,

  // The live draft's audience selections (the message text lives on the inputs — see draft()).
  targetType: "user",
  selectedUser: null, // a single UserResponse, or null
  city: "",
  selectedEventIds: new Set(),
  userSearch: "",

  sending: false,
};

// Persistent references to the controls that are mutated in place (never rebuilt on a keystroke), so an
// in-progress draft survives the picker re-renders beside it. Set once in buildPage().
let ui = null;

// ---- data loading -------------------------------------------------------------------------

/** One page of the admin account list for {@link fetchAllUsers}. Sorted by id so the walk is stable. */
async function fetchUsersPage(page, size) {
  const res = await apiFetch(`/api/v1/admin/users?page=${page}&size=${size}&sort=id,asc`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to load recipients.");
  if (!res.ok) throw new ApiError(res.status, `Could not load recipients (${res.status}).`);
  return res.json();
}

/** Load the WHOLE account list once (the TM-370 page walk) so the user picker can search everyone. */
async function loadUsers() {
  if (state.users || state.usersLoading) return;
  state.usersLoading = true;
  state.usersError = null;
  renderUserPicker();
  try {
    const { users } = await fetchAllUsers(fetchUsersPage, { pageSize: FETCH_SIZE });
    state.users = users;
  } catch (err) {
    state.usersError = err instanceof ApiError ? err.message : "Could not load recipients.";
  } finally {
    state.usersLoading = false;
    renderUserPicker();
  }
}

/** Walk the admin events inventory once (newest first), so the event multi-select + city suggestions
 *  have data. Mirrors admin-events.js loadEvents: hold the (small) inventory in memory and filter here. */
async function loadEvents() {
  if (state.events || state.eventsLoading) return;
  state.eventsLoading = true;
  state.eventsError = null;
  renderEventPicker();
  renderCityPicker(); // the city suggestions come from event cities, so refresh that too
  try {
    const all = [];
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const res = await apiFetch(`/api/v1/admin/events?page=${page}&size=${FETCH_SIZE}&sort=startAt,desc`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new ApiError(res.status, `Could not load events (${res.status}).`);
      const envelope = await res.json();
      const items = Array.isArray(envelope?.items) ? envelope.items : [];
      all.push(...items);
      const totalPages = Number(envelope?.totalPages);
      const lastByServer = Number.isFinite(totalPages) && page + 1 >= totalPages;
      if (lastByServer || items.length < FETCH_SIZE) break;
    }
    state.events = all;
  } catch (err) {
    state.eventsError = err instanceof ApiError ? err.message : "Could not load events.";
  } finally {
    state.eventsLoading = false;
    renderEventPicker();
    renderCityPicker();
  }
}

/**
 * Populate the deep-link picker from the backend allow-list (GET …/push-routes, TM-360) — the single
 * source of truth, so the admin can only pick a route the send path will accept. Best-effort: on any
 * failure it falls back to the client KNOWN_ROUTES so the picker is never empty. Mirrors admin.js.
 */
async function loadRoutes() {
  if (!ui) return;
  let routes;
  try {
    routes = routeOptionsFrom(await getPushRoutes(), KNOWN_ROUTES);
  } catch {
    routes = routeOptionsFrom(null, KNOWN_ROUTES);
  }
  state.routeOptions = routes;
  const current = ui.route.value;
  clear(ui.route).append(
    el("option", { value: NO_ROUTE, text: "No deep-link" }),
    ...routes.map((r) => el("option", { value: r, text: routeLabel(r) })),
  );
  ui.route.value = current && routes.includes(current) ? current : NO_ROUTE;
}

// ---- the live draft + validation ----------------------------------------------------------

/** The current compose draft, read straight off the live inputs + the selection state. */
function draft() {
  return {
    title: ui ? ui.title.value : "",
    body: ui ? ui.body.value : "",
    deepLink: ui ? ui.route.value : NO_ROUTE,
    targetType: state.targetType,
    userIds: state.selectedUser ? [state.selectedUser.id] : [],
    city: state.city,
    eventIds: [...state.selectedEventIds],
  };
}

/** Paint (or clear) a field's inline error, mirroring the profile.js / admin.js a11y wiring. */
function setFieldError(input, errorNode, message) {
  if (errorNode) {
    errorNode.textContent = message || "";
    errorNode.hidden = !message;
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
 * Re-derive everything that depends on the draft: the per-field errors and the Send-enabled state.
 * Cheap + idempotent — only mutates the stable controls in place, so it's safe to call on every
 * keystroke / selection change. The audience error shows beneath the picker area.
 */
function refresh() {
  if (!ui) return;
  const { title, body, audience, canSend } = validateAdminMessage(draft());
  setFieldError(ui.title, ui.titleError, title);
  setFieldError(ui.body, ui.bodyError, body);
  // The audience error mirrors the live validation as the admin composes (consistent with the broadcast
  // compose panel's live field errors, admin.js), so the Send button's disabled state always has a
  // visible reason beside the picker rather than being silently greyed out.
  ui.audienceError.textContent = audience || "";
  ui.audienceError.hidden = !audience;
  ui.send.disabled = !canSend || state.sending;
}

// ---- target-type toggle -------------------------------------------------------------------

const TYPE_LABELS = Object.freeze({ user: "A person", city: "A city", event: "Event attendees" });

/** Switch the live audience dimension: show its picker, hide the others, and load its data on demand. */
function selectTargetType(type) {
  if (!TARGET_TYPES.includes(type)) return;
  state.targetType = type;
  // Reflect the choice onto the radio group + show only the active picker.
  for (const t of TARGET_TYPES) {
    if (ui.typeRadios[t]) ui.typeRadios[t].checked = t === type;
    if (ui.pickers[t]) ui.pickers[t].hidden = t !== type;
  }
  // Lazily load the data the chosen picker needs (idempotent — a second show is a no-op once loaded).
  if (type === "user") loadUsers();
  if (type === "event") loadEvents();
  if (type === "city") loadEvents(); // city SUGGESTIONS come from event cities (best-effort)
  refresh();
}

// ---- user picker (searchable, single user) ------------------------------------------------

/** Filter the loaded accounts by the search box using the shared identity haystack (TM-372). */
function matchingUsers() {
  const q = state.userSearch.trim().toLowerCase();
  const all = state.users || [];
  if (q === "") return all.slice(0, USER_RESULTS_LIMIT);
  return all.filter((u) => searchHaystack(u).includes(q)).slice(0, USER_RESULTS_LIMIT);
}

/** (Re)render the user picker body: the selected chip, or the search box + result rows / states. */
function renderUserPicker() {
  if (!ui || !ui.userBody) return;
  const body = clear(ui.userBody);

  if (state.selectedUser) {
    // A recipient is chosen — show them as a removable chip; no need for the search list until removed.
    body.append(
      el("div", { class: "tm-msg-chip" }, [
        el("span", { class: "tm-msg-chip-label", text: displayIdentifier(state.selectedUser) }),
        el("button", {
          class: "tm-btn tm-btn-sm",
          type: "button",
          "aria-label": "Change recipient",
          onClick: () => { state.selectedUser = null; renderUserPicker(); refresh(); },
        }, "Change"),
      ]),
    );
    return;
  }

  if (state.usersLoading) {
    body.append(el("p", { class: "tm-muted", text: "Loading people…" }));
    return;
  }
  if (state.usersError) {
    body.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.usersError }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => { state.usersError = null; loadUsers(); } }, "Retry"),
    ]));
    return;
  }

  const search = el("input", {
    type: "search",
    class: "tm-input",
    placeholder: "Search name, email, phone…",
    "aria-label": "Search for a person to message",
    value: state.userSearch,
    onInput: (e) => { state.userSearch = e.target.value; renderUserResults(); },
  });
  const results = el("ul", { class: "tm-msg-results", id: "admin-msg-user-results" });
  body.append(search, results);
  renderUserResults();
}

/** Just the result rows of the user picker (re-rendered on each keystroke, not the whole picker). */
function renderUserResults() {
  const results = document.getElementById("admin-msg-user-results");
  if (!results) return;
  clear(results);
  const rows = matchingUsers();
  if (!rows.length) {
    results.append(el("li", { class: "tm-muted tm-msg-results-empty", text: (state.users || []).length ? "No people match your search." : "No accounts yet." }));
    return;
  }
  for (const u of rows) {
    results.append(el("li", {}, [
      el("button", {
        class: "tm-btn tm-btn-sm tm-msg-result",
        type: "button",
        onClick: () => { state.selectedUser = u; renderUserPicker(); refresh(); },
      }, displayIdentifier(u)),
    ]));
  }
}

// ---- city picker (input + suggestions from event cities) ----------------------------------

/** Distinct, sorted non-blank cities gathered from the loaded events — best-effort suggestions only.
 *  There is no cities endpoint and the admin account projection carries no city, so event cities are
 *  the closest available hint; the field stays free text because the backend matches the profile city
 *  (case-insensitive, trimmed), which may differ from any event's city. */
function citySuggestions() {
  const seen = new Set();
  for (const e of state.events || []) {
    const c = typeof e.city === "string" ? e.city.trim() : "";
    if (c) seen.add(c);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** (Re)render the city suggestions datalist (the input itself is stable — see buildPage). */
function renderCityPicker() {
  if (!ui || !ui.cityList) return;
  clear(ui.cityList).append(...citySuggestions().map((c) => el("option", { value: c })));
}

// ---- event picker (multi-select) ----------------------------------------------------------

/** (Re)render the event multi-select: a checkbox row per event, or the loading / error / empty state. */
function renderEventPicker() {
  if (!ui || !ui.eventBody) return;
  const body = clear(ui.eventBody);

  if (state.eventsLoading) {
    body.append(el("p", { class: "tm-muted", text: "Loading events…" }));
    return;
  }
  if (state.eventsError) {
    body.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.eventsError }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => { state.eventsError = null; loadEvents(); } }, "Retry"),
    ]));
    return;
  }
  const events = state.events || [];
  if (!events.length) {
    body.append(el("p", { class: "tm-muted", text: "No events to target yet." }));
    return;
  }

  const list = el("ul", { class: "tm-msg-events" }, events.map((ev) => {
    const id = ev.id;
    const when = formatEventWhen(ev.startAt, ev.timezone);
    return el("li", { class: "tm-msg-event" }, [
      el("label", { class: "tm-msg-event-label" }, [
        el("input", {
          type: "checkbox",
          class: "tm-check",
          checked: state.selectedEventIds.has(id),
          "aria-label": `Target attendees of ${ev.heading || `event ${id}`}`,
          onChange: (e) => {
            if (e.target.checked) state.selectedEventIds.add(id);
            else state.selectedEventIds.delete(id);
            updateEventCount();
            refresh();
          },
        }),
        el("span", { class: "tm-msg-event-head", text: ev.heading || `Event ${id}` }),
        el("span", { class: "tm-muted tm-msg-event-when", text: when }),
      ]),
    ]);
  }));
  body.append(list);
  updateEventCount();
}

/** Update the "N events selected" count beside the event picker heading. */
function updateEventCount() {
  if (ui && ui.eventCount) {
    const n = state.selectedEventIds.size;
    ui.eventCount.textContent = n ? `${n} selected` : "";
  }
}

// ---- send ---------------------------------------------------------------------------------

/**
 * Confirm-then-send. Send is already gated (disabled) until title + body are valid and the chosen
 * audience has a selection; this adds an explicit confirm because a delivered message is irreversible
 * (there is deliberately no un-send). The confirm copy surfaces the count for a large KNOWN audience,
 * and warns that a city / event audience is resolved (and could be large) at send time — the AC's
 * "confirmation step when the resolved audience exceeds ~50 recipients (shows the count before send)".
 */
async function sendMessage() {
  if (!ui) return;
  const d = draft();
  const { canSend } = validateAdminMessage(d);
  if (!canSend) {
    refresh();
    return;
  }

  const userLabel = state.selectedUser ? displayIdentifier(state.selectedUser) : "";
  const ok = await confirmDialog({
    title: "Send this message?",
    message: confirmCopy(d, { userLabel, cityLabel: state.city }),
    confirmLabel: "Send now",
    danger: true,
  });
  if (!ok) return;

  state.sending = true;
  ui.send.disabled = true;
  const original = ui.send.textContent;
  ui.send.textContent = "Sending…";
  try {
    const result = await sendAdminMessage(buildAdminMessagePayload(d));
    toast(summariseSend(result), { type: "success", timeout: 8000 });
    // Delivered. Show the sent-success panel with a RECALL control (TM-473), carrying the campaign id
    // (result.id) so an admin who realises the audience was wrong can immediately pull the message back.
    // Its "Done" / "← Admin" go to RETURN_ROUTE — now TM-444's sent-history list (#/admin/messages),
    // where the just-sent campaign shows at the top and the same recall control renders per row.
    renderSentSuccess(result, {});
  } catch (err) {
    // RFC-7807 from the backend: a 400 may carry per-field errors (title/body over cap, off-list
    // deep-link, or "exactly one target type"). Attach the ones we can, toast the rest.
    if (err instanceof ApiError && err.fieldErrors?.length) {
      const leftover = [];
      for (const fe of err.fieldErrors) {
        if (fe.field === "title") setFieldError(ui.title, ui.titleError, fe.message);
        else if (fe.field === "body") setFieldError(ui.body, ui.bodyError, fe.message);
        else leftover.push(fe.message);
      }
      toast(leftover.length ? leftover.join(" ") : "Please fix the highlighted fields.", { type: "error" });
    } else {
      toast(err instanceof ApiError ? err.message : "Could not send the message.", { type: "error" });
    }
  } finally {
    state.sending = false;
    ui.send.textContent = original;
    refresh();
  }
}

// ---- sent-success panel + recall (TM-473) -------------------------------------------------

/**
 * After a successful send, replace the compose form with a "sent" confirmation panel that shows the
 * delivery summary AND a self-contained RECALL control (TM-473). This is the branch's mount point for
 * the recall affordance — "wherever a sent message is shown". The panel carries the campaign id
 * (`result.id`), so recall targets the exact message just sent. Re-rendered in the recalled state after
 * a successful recall so the admin sees it worked. TM-444's sent-history list mounts the SAME control
 * (via the shared recall-core) per row; here it's the single just-sent message.
 *
 * @param {{id: number|string, recipientCount?: number, pushDelivered?: number, pushSkipped?: number}} result
 * @param {{recalled?: boolean}} [opts]
 */
function renderSentSuccess(result, { recalled = false } = {}) {
  const view = document.getElementById("admin-message-form-view");
  if (!view) return;

  // The delivery summary of what was sent (unchanged by a later recall — it's the record of the send).
  const summary = el("p", { class: "tm-msg-sent-summary", text: summariseSend(result) });

  // The honesty note: recall clears the in-app inbox + bell, but an already-delivered push can't be
  // un-sent (mirrors recallConfirmCopy()'s limit, shown here as standing context).
  const note = el("p", { class: "tm-msg-sent-note tm-muted" }, recalled
    ? "This message was recalled — removed from recipients' in-app inbox and notification bell. "
        + "A push already delivered to a phone can't be un-sent, so it may still show in their tray."
    : "Sent to the wrong audience? You can recall it — this removes it from recipients' in-app inbox "
        + "and notification bell. A push already delivered to a phone can't be un-sent.");

  // The action: a live message offers RECALL (danger); a recalled one shows a disabled "Recalled" state.
  const actions = recalled
    ? [el("button", { class: "tm-btn", type: "button", disabled: true }, RECALLED_LABEL)]
    : [el("button", {
        class: "tm-btn tm-btn-danger",
        id: "admin-msg-recall",
        type: "button",
        onClick: () => recall(result),
      }, RECALL_LABEL)];
  actions.push(el("a", { class: "tm-btn tm-btn-primary", id: "admin-msg-done", href: RETURN_ROUTE }, "Done"));

  clear(view).append(
    el("div", { class: "tm-admin-head tm-msg-head" }, [
      el("h2", {}, [doodle("chat", { class: "tm-doodle-header" }), recalled ? "Message recalled" : "Message sent"]),
      el("a", { class: "tm-btn tm-btn-sm", href: RETURN_ROUTE }, "← Admin"),
    ]),
    el("div", { class: "tm-msg-sent" }, [
      summary,
      note,
      el("div", { class: "tm-form-actions" }, actions),
    ]),
  );
}

/**
 * Confirm-then-recall the just-sent message (TM-473). Recall is consequential + irreversible, so it is
 * always confirmed via the shared recall-core copy (which surfaces the best-effort-push limit). On
 * success the panel re-renders in the recalled state; on failure it toasts and leaves the button
 * ready to retry. The api.js call is admin-gated + scoped to the sender server-side.
 *
 * @param {{id: number|string}} result the sent-message result carrying the campaign id.
 */
async function recall(result) {
  const ok = await confirmDialog({
    title: "Recall message?",
    message: recallConfirmCopy(),
    confirmLabel: RECALL_LABEL,
    danger: true,
  });
  if (!ok) return;

  const btn = document.getElementById("admin-msg-recall");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Recalling…";
  }
  try {
    const recallResult = await recallAdminMessage(result.id);
    toast(summariseRecall(recallResult), { type: "success", timeout: 8000 });
    renderSentSuccess(result, { recalled: true });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Could not recall the message.", { type: "error" });
    if (btn) {
      btn.disabled = false;
      btn.textContent = RECALL_LABEL;
    }
  }
}

// ---- build + mount ------------------------------------------------------------------------

/** A labelled form field wrapper (label + control + optional hint/error), reusing the profile form CSS. */
function field(labelText, control, { hint, error, forId } = {}) {
  return el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", for: forId, text: labelText }),
    control,
    hint ? el("p", { class: "tm-muted tm-field-hint", text: hint }) : null,
    error || null,
  ]);
}

/** Build the compose page once and stash live references on `ui`. Mounted into #admin-message-form-view. */
function buildPage(view) {
  // --- message fields ---
  const title = el("input", {
    id: "admin-msg-title",
    class: "tm-input",
    type: "text",
    maxLength: MAX_TITLE,
    autocomplete: "off",
    "aria-describedby": "admin-msg-title-error",
    onInput: () => refresh(),
  });
  const titleError = el("p", { id: "admin-msg-title-error", class: "tm-field-error", role: "alert", hidden: true });

  const body = el("textarea", {
    id: "admin-msg-body",
    class: "tm-input tm-textarea",
    rows: "5",
    maxLength: MAX_BODY,
    "aria-describedby": "admin-msg-body-error",
    onInput: () => refresh(),
  });
  const bodyError = el("p", { id: "admin-msg-body-error", class: "tm-field-error", role: "alert", hidden: true });

  const route = el("select", {
    id: "admin-msg-route",
    class: "tm-input",
    "aria-describedby": "admin-msg-route-hint",
  }, [el("option", { value: NO_ROUTE, text: "No deep-link" })]);

  // --- audience: the target-type toggle ---
  const typeRadios = {};
  const typeChoices = el("div", { class: "tm-msg-typechoice", role: "radiogroup", "aria-label": "Who to send to" },
    TARGET_TYPES.map((t) => {
      const radio = el("input", {
        type: "radio",
        name: "admin-msg-target",
        class: "tm-check",
        value: t,
        checked: t === state.targetType,
        onChange: () => selectTargetType(t),
      });
      typeRadios[t] = radio;
      return el("label", { class: "tm-msg-typeopt" }, [radio, el("span", { text: TYPE_LABELS[t] })]);
    }),
  );

  // --- audience: the three pickers (only the active one shown) ---
  const userBody = el("div", { class: "tm-msg-picker-body", id: "admin-msg-user-body" });
  const userPicker = el("div", { class: "tm-msg-picker", id: "admin-msg-picker-user" }, [userBody]);

  const cityList = el("datalist", { id: "admin-msg-city-list" });
  const cityInput = el("input", {
    id: "admin-msg-city",
    class: "tm-input",
    type: "text",
    list: "admin-msg-city-list",
    autocomplete: "off",
    placeholder: "e.g. London",
    "aria-label": "City to send to",
    value: state.city,
    onInput: (e) => { state.city = e.target.value; refresh(); },
  });
  const cityPicker = el("div", { class: "tm-msg-picker", id: "admin-msg-picker-city", hidden: true }, [
    cityInput,
    cityList,
    el("p", { class: "tm-muted tm-field-hint", text: "Everyone whose profile city matches (case-insensitive). Suggestions come from your events." }),
  ]);

  const eventCount = el("span", { class: "tm-badge tm-msg-event-count", id: "admin-msg-event-count", text: "" });
  const eventBody = el("div", { class: "tm-msg-picker-body", id: "admin-msg-event-body" });
  const eventPicker = el("div", { class: "tm-msg-picker", id: "admin-msg-picker-event", hidden: true }, [
    el("div", { class: "tm-msg-picker-head" }, [
      el("span", { class: "tm-field-label", text: "Choose events" }),
      eventCount,
    ]),
    eventBody,
  ]);

  const audienceError = el("p", { id: "admin-msg-audience-error", class: "tm-field-error", role: "alert", hidden: true });

  const pickers = { user: userPicker, city: cityPicker, event: eventPicker };

  // --- send ---
  const send = el("button", {
    class: "tm-btn tm-btn-primary",
    id: "admin-msg-send",
    type: "button",
    disabled: true,
    onClick: () => sendMessage(),
  }, "Send message");

  const form = el("form", { class: "tm-msg-form", novalidate: true }, [
    el("h3", { class: "tm-msg-section-title", text: "Message" }),
    field("Title", title, { forId: "admin-msg-title", error: titleError, hint: `Up to ${MAX_TITLE} characters.` }),
    field("Message", body, { forId: "admin-msg-body", error: bodyError, hint: `Up to ${MAX_BODY} characters.` }),
    field("Deep-link (optional)", route, { forId: "admin-msg-route", hint: "Where a tap on the notification takes the reader." }),

    el("h3", { class: "tm-msg-section-title", text: "Audience" }),
    el("p", { class: "tm-muted", text: "A message goes to one audience type — a person, a city, or the attendees of one or more events. Not a combination." }),
    typeChoices,
    userPicker,
    cityPicker,
    eventPicker,
    audienceError,

    el("div", { class: "tm-form-actions" }, [
      el("a", { class: "tm-btn", href: RETURN_ROUTE }, "Cancel"),
      send,
    ]),
  ]);

  // The form's native submit (Enter) routes through the same guarded send().
  form.addEventListener("submit", (e) => { e.preventDefault(); if (!send.disabled) sendMessage(); });

  ui = {
    title, titleError, body, bodyError, route,
    typeRadios, pickers,
    userBody, cityInput, cityList, eventBody, eventCount,
    audienceError, send,
  };

  clear(view).append(
    el("div", { class: "tm-admin-head tm-msg-head" }, [
      el("h2", {}, [doodle("chat", { class: "tm-doodle-header" }), "New message"]),
      el("a", { class: "tm-btn tm-btn-sm", id: "admin-msg-back", href: RETURN_ROUTE }, "← Sent messages"),
    ]),
    form,
  );
}

/**
 * Router entry (TM-443): mount the compose page fresh each entry (a compose form has no persistent
 * server state to preserve — a new visit is a new draft), then start the initial picker + routes load.
 * The router gates the ADMIN-only #/admin/messages/new route before calling this.
 */
export function enterAdminMessageCompose() {
  const view = document.getElementById("admin-message-form-view");
  if (!view) return;
  // Reset the per-visit selection state so a previous draft doesn't bleed into a new compose.
  state.targetType = "user";
  state.selectedUser = null;
  state.city = "";
  state.selectedEventIds = new Set();
  state.userSearch = "";
  state.sending = false;

  buildPage(view);
  loadRoutes();
  // Show the default (user) picker + load its data; renders the initial pristine state.
  selectTargetType("user");
  renderUserPicker();
  renderCityPicker();
  renderEventPicker();
  refresh();
  ui.title.focus();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminMessages = { enterAdminMessageCompose };
}
