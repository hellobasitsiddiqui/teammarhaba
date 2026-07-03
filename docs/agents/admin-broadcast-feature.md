# Admin broadcast — feature reference + operational limits (epic TM-358)

The authoritative reference for the **admin broadcast / compose** feature: what it does, how an admin
uses it, the endpoint contract, and — most importantly — the **operational limits and opt-out
semantics** that make it behave the way it does. Written *after* the endpoint (TM-363), UI (TM-365),
safety rails (TM-364), deep-link (TM-360) and migration (TM-359) all landed on `main`, so the shapes
and behaviour below match what shipped, not the design sketch.

| Piece | Ticket / PR | Lives in |
|---|---|---|
| Append-only log (V10) + `BROADCAST_SENT` audit action | TM-359 (#271) | `db/migration/V10__create_notification_broadcasts.sql`, `AuditAction.java`, `NotificationBroadcast.java` |
| Deep-link route allow-list exposed to the admin UI | TM-360 (#272) | `PushRoutes.java`, `GET /api/v1/admin/users/push-routes` |
| Broadcast endpoint (custom push fan-out + per-recipient result) | TM-363 (#277) | `PushAdminController.java`, `BroadcastPushRequest/Response.java`, `BroadcastService.java` |
| Safety rails (opt-out / skip disabled+deleted / dedupe / cooldown) | TM-364 (#280) | `BroadcastService.java`, `BroadcastCooldownException.java` |
| Compose UI (multi-select → compose → preview → confirm → send) | TM-365 (#279) | `web/src/assets/admin.js`, `web/src/assets/broadcast.js` |

## What it does

An **ADMIN** can send a one-off custom push notification — a title + body, with an optional in-app
deep-link — to a chosen set of accounts, from the admin users console. The backend fans the message
out to each recipient's registered devices over FCM, applies the opt-in / safety gates below, and
returns an aggregate + per-recipient breakdown. Every send appends one immutable audit row.

It is deliberately a **base broadcast**: no saved segments, no scheduling, no templates. Pick people,
type a message, preview, confirm, send now.

## How an admin uses it (the flow)

The compose panel lives at the top of the **Users** console (`#admin-view`), above the users table.
The flow is **multi-select → compose → preview → confirm → send-now** (`web/src/assets/admin.js`):

1. **Select recipients** — tick users in the table. The selection is held **by user id**, so it
   survives paging, filtering and sorting (a draft audience isn't lost when the table re-renders).
   The header **select-all** checkbox selects **everyone matching the filter across the whole account
   list** — the console walks *every* page of the admin endpoint on load (100/request,
   `fetchAllUsers` in `broadcast.js`, TM-370), so filtering client-side now runs over the full set,
   not just the first 100. If a load ever comes back **partial** (a page failed mid-walk), the
   compose panel shows a "Loaded X of Y accounts" caveat so select-all's real reach is never
   overstated. A selection that grows past the **500-recipient send cap** (the server DTO's `@Size`)
   raises an immediate toast and keeps the Send-gate closed until it's back under.
2. **Compose** — a **Title** and **Message**, plus an optional **Deep-link** picker. The deep-link
   options come from the backend allow-list (`GET …/push-routes`, TM-360) — never free text — so the
   admin can only pick a route the send path will accept. The picker falls back to the client
   `KNOWN_ROUTES` if the server list can't be fetched, so composing still works.
3. **Preview** — a faithful notification-shade preview updates live: title as the headline, body
   beneath, and a caption ("Tapping opens: …") for the deep-link (the route is invisible metadata on a
   real push, so it's shown as a caption, not pretended to be part of the visible push).
4. **Confirm** — **Send** is disabled until title + body are non-blank and within their caps **and**
   at least one recipient is selected. Pressing it opens an explicit **danger confirm** ("Send to N
   users? … This can't be undone.") — a delivered push is irreversible, so there is deliberately **no
   undo toast** (unlike the enable/role admin actions).
5. **Send now** — on confirm, the UI POSTs the broadcast and shows an honest one-line summary toast
   read from the response ("Sent to 12 users · 18 devices delivered · 5 skipped (2 opted out, 3 no
   device)"). The skip breakdown reads the response's `skippedOptedOut` / `skippedDisabled` /
   `skippedNotFound` rails (post-TM-364) and derives "no device" as the residual, showing only the
   non-zero reasons. Then it clears the draft + selection.

Client-side validation (`web/src/assets/broadcast.js`) mirrors the backend caps 1:1, so the browser
fails fast with the *same* limits the server enforces and only ever POSTs something the server will
accept.

## The endpoint

```
POST /api/v1/admin/push/broadcast
```

**ADMIN-only.** The whole `PushAdminController` is gated by
`@PreAuthorize("hasRole('ADMIN')")`, so a non-admin gets a uniform `403` and an anonymous caller is
stopped with `401` by the security chain (same shape as the admin user-management endpoints).

### Request — `BroadcastPushRequest`

| Field | Type | Rule |
|---|---|---|
| `userIds` | `long[]` | non-empty, each non-null, **capped at 500** (`MAX_RECIPIENTS`) |
| `title` | string | required, non-blank, **≤ 200** (`MAX_TITLE_LENGTH`) |
| `body` | string | required, non-blank, **≤ 1000** (`MAX_BODY_LENGTH`) |
| `route` | string \| null | optional deep-link; `null` = no deep-link; a non-null value is validated against the `PushRoutes` allow-list in the service |

Bean Validation makes any malformed body a uniform RFC-7807 `400` (with per-field `errors[]`), never a
`500`. An **off-list `route`** is a clean `400` from the service (validated up-front, before any send).
An **empty id list** is a `400` (belt-and-braces alongside `@NotEmpty`).

> Note: the `notification_broadcasts` columns are slightly wider than the DTO caps (`title
> VARCHAR(255)`, `body VARCHAR(2000)`) — the **DTO `@Size` caps (200 / 1000) are the enforced
> contract**; the columns just have headroom.

### Response — `BroadcastPushResponse` (`200`)

A well-formed, non-rate-limited request returns `200` with the aggregate counters **plus** a
per-recipient breakdown. Partial failure is **not** total failure — a skipped recipient is *reported*,
never thrown, and transient per-token FCM failures are absorbed inside the send.

| Field | Meaning |
|---|---|
| `requested` | how many user ids the request asked for |
| `sent` | recipients that had at least one device targeted |
| `skipped` | recipients not delivered to (no device, opted out, disabled, or not found) |
| `targeted` | total distinct devices attempted across all recipients (post-dedupe) |
| `delivered` | tokens FCM accepted |
| `pruned` | tokens removed because FCM reported them unregistered/invalid |
| `failed` | tokens that hit a transient/other error and were kept |
| `skippedOptedOut` | recipients whose `notificationPref` is not `PUSH`/`BOTH` |
| `skippedDisabled` | recipients skipped because the account is suspended |
| `skippedNotFound` | recipients skipped because no active account resolved (absent / soft-deleted) |
| `dedupedTokens` | device tokens collapsed because a shared device resolved under >1 recipient |
| `recipients[]` | per-recipient `{ userId, outcome, fanout }`, in request order |

`outcome` is one of `SENT | NO_DEVICES | SKIPPED_OPTED_OUT | SKIPPED_DISABLED | SKIPPED_NOT_FOUND`.
**No device tokens are ever in this payload** (a token is a sender-usable credential — the whole notify
stack keeps tokens out of responses, logs and audit).

The only hard errors are: `400` (malformed body, empty id list, off-list route) and `429` (the send
cooldown, below).

## Reuses the existing push plumbing — does not rebuild it

The broadcast is a thin fan-out **on top of** the TM-277 push stack; delivery is not reimplemented:

| Reused piece | Ticket | How the broadcast uses it |
|---|---|---|
| FCM transport (`FcmPushSender` / `PushSender` seam) | TM-284 | actual send goes through `PushNotificationService.sendToTokens` — FCM, `UNREGISTERED`-token pruning and the TM-292 outcome classification all stay inside the notify package |
| Device-token store (`device_tokens`, V9) | TM-283 | recipients' tokens are read from the store (via `User`, see below) |
| Web deep-link routing (`push-deeplink.js` `KNOWN_ROUTES`) | TM-285 | the picker's routes + the on-tap navigation |
| Push message + deep-link route (`PushMessage`, `PushRoutes`) | TM-290 | the message envelope + the route allow-list |
| Route allow-list exposed to admin UI (`…/push-routes`) | TM-360 | the single source of truth for the deep-link picker |

The dumb single-user `PushNotificationService.sendToUser` (used by the re-enable and test-push paths)
is left **completely untouched** — the broadcast rails live in `BroadcastService`, not in the shared
send path.

## Opt-out semantics (the important part)

**A broadcast only ever reaches accounts that have opted into push.** Each requested id is resolved and
gated *before* anything is sent (`BroadcastService`):

- **Opt-out is respected.** A recipient whose `notificationPref` is **not** `PUSH` or `BOTH` is skipped
  (`SKIPPED_OPTED_OUT`). This is the **first send path in the app to honour `notificationPref`**.
- **`EMAIL` is the default for every account — and email-only IS the push opt-out.** There is no
  separate `OFF` value: `notificationPref` defaults to `EMAIL` for all existing accounts, and `EMAIL`
  (i.e. *not* `PUSH`/`BOTH`) is treated as "opted out of push". So **a broadcast reaches essentially
  nobody until users actively opt into push** — the reachable audience is small by design.

  This is **correct, opt-in-respecting behaviour**, not a bug. "Reaches nobody" today is the honest
  reading of "respect opt-out" when the default is email-only. It self-corrects as users opt in.

Two more gates round out "a blast only reaches accounts that can receive it":

- **Skip disabled.** A suspended account (`enabled == false`) is skipped (`SKIPPED_DISABLED`) —
  `sendToUser` doesn't check `enabled`, so this gate is explicit here.
- **Skip soft-deleted / absent.** Recipients are resolved **through `UserRepository`** (whose entity's
  `@SQLRestriction("deleted_at is null")` auto-excludes tombstoned rows), so a soft-deleted or unknown
  id is `SKIPPED_NOT_FOUND` and never pushed. Soft-deleted users *retain* `device_tokens` rows, so
  resolving via tokens directly would be a **leak** — we always go through `User`, then read that
  user's tokens.

## iOS honesty — Android delivers now, real iOS push is parked

- **Android delivers end-to-end via FCM now.** The whole flow above works for Android devices today.
- **Real iOS push is a separate, human-gated task — TM-362, deferred.** It needs an **APNs `.p8`
  auth key + a Firebase iOS app registration + a physical iOS device**. The iOS **Simulator cannot
  receive real remote push** — it registers no `aps-environment` entitlement and has no real device
  token, so only local `xcrun simctl push` payloads work there (see the
  [ADR-0005 addendum](../decisions/ADR-0005-mobile-capacitor-hybrid.md) and `ios/README.md`). Until
  TM-362 lands, treat iOS delivery as **not proven** — do not read "iOS runs in the Simulator" as
  "iOS receives broadcasts".

## Audit model

Every send that completes writes **two** durable records, both inside the send transaction, so a
broadcast is never silently un-recorded:

1. **One header row** in `notification_broadcasts` (V10, TM-359) — an **append-only** table (mirrors
   `audit_events`: the entity has no mutators, the repository declares no update/delete, and
   `created_at` is DB-authoritative `default now()`). It records *who* (`actor_uid`) sent *what*
   (`title` / `body` / `route`) to *how many* (`recipient_count`) with what aggregate outcome
   (`targeted` / `delivered` / `pruned` / `failed` / `skipped`), and *when*.
2. **One summary row** in the audit log — `AuditAction.BROADCAST_SENT` (TM-359) — carrying the counts
   (including the skipped-by-rail + deduped breakdown), title and route.

The dual pattern (own header table + one summary audit row) is deliberate: `audit_events` is
single-target (one action, one target), but a broadcast fans out to many recipients, so it gets its own
header table **plus** the summary row — the same pattern `device_tokens` uses. **Metadata carries
counts / title / route only — never device tokens.**

## v1 limitations + future work

Known and intentional for v1 — captured so future work builds on accurate assumptions:

| Limit | Detail | Future |
|---|---|---|
| **Real iOS push parked** | Android only today; iOS needs APNs `.p8` + Firebase iOS app + physical device | TM-362 (human-gated) |
| **`>100`-user select ceiling** | **fixed (TM-370)**: the console now walks *every* page of the admin list on load (100/request, `fetchAllUsers`), so select-all covers the **full account set**; a partial load (mid-walk failure / runaway-guard trip) shows a "Loaded X of Y accounts" warning instead of overstating reach. A single send is still capped at **500 recipients** (server `@Size`) — exceeding it toasts immediately and blocks Send | server-side "select all matching the filter" once the base outgrows fetch-all (thousands) — the injected page-fetcher in `fetchAllUsers` is the seam (flagged on TM-133/TM-115) |
| **Per-admin send cooldown** | a **30s** per-admin-uid cooldown rejects a second broadcast inside the window with `429` — the accidental-double-send guard | it is **process-local** (fine for one Cloud Run instance); a shared store (Redis) for a cluster-wide guard is the noted future improvement, consistent with TM-247 |
| **`notificationPref` not in the admin projection** | the admin `UserResponse` doesn't expose `notificationPref`, so the UI **can't show who is opt-out** *before* sending (only *after*, from the result). The pre-send reachable/opt-out counts still aren't shown up front | add `notificationPref` to the admin projection so the console can show reachable/opt-out counts before send |
| **Skip-reason breakdown in the result toast** | the summary toast now reports the real skip breakdown from the response rails — `skipped (A opted out, B no device, C disabled, D not found)`, showing only the non-zero reasons, with "no device" derived as the residual (TM-365 review M1). Earlier it folded everything into one `(no device)` count | — (done) |
| **No saved segments / scheduling / templates** | pick-and-send only; no reusable audiences, no send-later | segments + scheduling epic |
| **No per-recipient receipt beyond FCM-accept** | `delivered` = tokens FCM *accepted*, not devices that displayed the push | delivery receipts if a use-case needs them |
| **No `sendEachForMulticast` batching** | the fan-out sends per token rather than one batched multicast call | batch the send as a throughput optimisation (noted in TM-363) |
| **Per-recipient child table deferred** | v1 stores aggregate counters + a `skipped` count on the header only | `notification_broadcast_recipients` child table for per-recipient history |

## See also

- [`COMMON-FEATURES.md`](project/COMMON-FEATURES.md) — the base-product feature tracker (push / admin rows).
- [`AGENTIC-LESSONS.md`](conventions/AGENTIC-LESSONS.md) — the fleet lessons this feature contributed
  ("first send path to honour `notificationPref`"; "compose panel must live outside the re-rendered table").
- [`webview-auth-contract.md`](webview-auth-contract.md) — the WebView side of the mobile push surface.
- [ADR-0005](decisions/ADR-0005-mobile-capacitor-hybrid.md) — mobile Capacitor-hybrid strategy + the iOS-Simulator ceiling.
