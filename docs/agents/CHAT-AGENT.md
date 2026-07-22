# CHAT-AGENT — lane playbook

The chat surface only: the `#/chat` list and `#/chat/{id}` event group-chat threads, the chat modules
(`chat.js` DOM + `chat-core.js`, `chat-mentions-core.js`, `chat-moderation-core.js`, `chat-search-core.js`,
`chat-linkpreview-core.js`, `chat-tab-badge(.js/-core.js)`), the chat routes in `router.js`, the
`event-chat-entry-core.js` deep-link resolver in `events.js`, the backend `chat/` service package, and the
`wave-chat-*` waves. Distilled from **wave-chat-1** (sprint 971, closed 2026-07-22) — the event-chat
depth/bug wave that fixed 8 tickets + a closure batch. NOT this lane: admin-messages/broadcast (Admin lane),
the notification-center bell TM-451 (cross-cutting — coordinate), payments, profile, login.

## Architecture contracts on the chat layer (post-TM-433 foundation + wave-chat-1)

- **DOM ↔ core split is the law.** `chat.js` (~2000 lines) is a thin DOM shell; ALL logic lives in pure,
  Node-testable `*-core.js` modules (`chat-core.js` is the big one). Every decision — draft validation,
  compose availability, post-error classification, reaction toggle maths, receipt derivation, mention
  parse, search match, admin-flag resolve — is a pure function in a core module with a `web/tools/*.test.mjs`
  unit test. When you add behaviour, put the decision in a core module (importable in plain Node) and keep
  `chat.js` as glue. `chat.js` itself CANNOT be imported in Node (a transitive `https:` Firebase import in
  the api/auth chain), so anything that must be unit-tested lives in a core module — or gets a **source-guard
  test** (readFileSync + regex on `chat.js`, e.g. `chat-composer-lock-core.test.mjs`).
- **Routes.** `CHAT = "#/chat"` (`router.js`); list is `#/chat`, a thread is `#/chat/{id}`, both matched by
  `isChatRoute()` and entered via `enterChat(chatThreadId(route))` which renders both into `#chat-view`. Chat
  is in the `PROTECTED` set (sign-in + onboarding + terms gated). Deep-link ids are `safeDecodeSegment`-guarded
  (TM-721) — a malformed `%`-escape must not crash the router.
- **Backend is authoritative; the client is additive.** No localStorage cache of messages. List =
  `GET /me/conversations`, thread = `GET /conversations/{id}/messages`, unread badge =
  `GET /me/conversations/unread-total` (returns `{ total }` — NOT `{ unread }`; mock it as `{ total }`).
  Near-live = **SSE** (`/conversations/{id}/stream`, TM-464) **+ 15s poll fallback**, de-duped by
  `threadSignature`. Nothing is delivered over one path only. Thread id = conversation id; one conversation
  per event group, lazily created on the first GOING RSVP (`EventChatLifecycleService`).
- **The 15s poll replaces a whole page without bumping `thread.rev`.** `thread.rev` only tracks live/SSE
  mutations (TM-721). So any "did this change under me?" guard that compares against `rev` will MISS a poll
  reconcile — use a **value comparison** instead (see `shouldRollbackReaction`, TM-854: compares the message's
  current reaction chips to the optimistic snapshot, not a rev).
- **`canCompose` gates every per-message affordance.** `buildComposer` sets `thread.canCompose`; `lockComposer`
  (muted/removed/closed thread) flips it false AND drops any in-progress reply. The per-message reply + react
  affordances read `thread.canCompose`, and the TM-940 tap-to-reveal action menu (`messageActionMenu`) returns
  `null` — no `⋯` trigger at all — when no item applies. Keep that invariant: a locked/un-actionable message
  shows no dead-end affordance. Guarded by `chat-composer-lock-core.test.mjs` (source-guard) — if you reshape
  the menu, migrate that test.
- **Admin-only announce toggle is cache-backed.** `createAdminFlagCache(getMe)` (`chat-core.js`) resolves
  `role === "ADMIN"` once; `chat.js` invalidates it on `onAuthChanged`. A transient `/me` failure returns false
  for that call but is NOT cached (TM-736), so a boot-time blip can't hide the toggle for the whole session.
- **The OpenAPI spec is committed in THREE places that must stay in lockstep** (see Gotchas — this cost real
  time): a backend annotation change (`@Size`, a new param, a new endpoint) regenerates `backend/openapi.json`
  AND requires copying it to `web/src/api-docs/openapi.json`. Two separate guards enforce it.
- **Message shape** (`ConversationMessageResponse`): `id, senderId, senderName, body, kind` (`ATTENDEE` |
  `ANNOUNCEMENT`), `system` (senderId==null admin broadcast), `createdAt/editedAt`, `reactions:[{emoji,count,mine}]`,
  `replyTo:{id,excerpt,available}`, `readReceipt:{count,readerIds}` (own messages only), `mine`. Receipt copy:
  0 readers → **"Sent"** (TM-940, was "Read by none"), else "Read by N" / "Read by everyone".

## Gotchas that cost us real time

- **The OpenAPI spec has TWO committed copies + a backend generator — one annotation cascaded into two red
  gates.** TM-957 added `@Size(max=32)` to the un-react `emoji` `@RequestParam`. That (1) drifted
  `backend/openapi.json` → `OpenApiDriftTest` red (backend suite), fixed by
  `./mvnw -Dtest=OpenApiDriftTest -Dopenapi.generate=true -Dspotless.check.skip=true -DargLine="-Dapi.version=1.44" test`;
  then (2) drifted `web/src/api-docs/openapi.json` → `api-docs-spec-drift.test.mjs` red (WEB suite), fixed by
  `cp backend/openapi.json web/src/api-docs/openapi.json`. Any backend API-surface change = regenerate the
  backend spec AND re-copy the web one, in the same PR.
- **Run the FULL suites, not the lane subset.** Two separate agents shipped "green" after running only the
  chat tests (`chat-core.test.mjs`) or only their own new backend test — and CI's full glob caught a real
  failure both times (a source-guard in `chat-composer-lock-core.test.mjs`; the OpenAPI drift). Always run
  `node --test web/tools/*.test.mjs` (Node 20) AND the relevant backend classes (or the whole backend suite)
  before calling a PR green. `gh pr checks` green ≠ e2e green — dispatch `e2e.yml --ref <branch>` and confirm
  `success` on the exact head SHA yourself.
- **Reshaping the message row = migrate its source-guard consumers.** TM-940 moved reply/edit/delete behind a
  `⋯` menu; the always-visible-reply source-guard (`chat-composer-lock-core.test.mjs`) pinned the OLD code
  *shape* (`if (!m.pending && m.id && thread.canCompose)`) and went red even though the invariant held. These
  guards assert on `chat.js` text, so any structural refactor of the row/menu/receipt must update them — grep
  `web/tools` for source-guards over `chat.js` (`chat-composer-lock-core`, `chat-reaction-rollback-guard`,
  `chat-action-menu-close-guard`).
- **First-page-only lookups are a recurring class here** (same as TM-582). The event-detail "Open chat"
  deep-link resolved conversations from an *unpaged* `listMyConversations()` (page 0 only), so a member with
  20+ threads lost the link (TM-853, fixed by `collectConversationsForEvent` paging). The same page-0 bug
  still lives in `chat.js` `resolveThreadUnread` (deferred as **TM-959**). When you resolve a conversation by
  id, page-walk or query by id — never trust page 0.
- **The tap-to-reveal action menu (TM-940) is DOM/closure-local and does NOT survive a repaint.** Any live
  repaint (SSE/poll/roster) rebuilds every row with the menu hidden + focus dropped. The inline editor solves
  the same problem by pausing the poll on `thread.editingId`; the menu has no equivalent yet (deferred as
  **TM-958**, with keyboard-a11y). If you touch the menu, mirror the `thread.editingId` guard.
- **`postAnnouncement` must assert `EVENT_GROUP`.** Without it an admin could inject a human-sender ANNOUNCEMENT
  into a user's system-only ADMIN_BROADCAST channel (TM-856). The three message services share one
  `ThreadOpenGate` (TM-857) — if you add a write path, route it through the gate; don't re-implement the
  close/membership checks.

## Testing this lane

- **Web unit/core**: `/opt/homebrew/opt/node@20/bin/node --test web/tools/*.test.mjs` (Node 20 required). Pure
  cores are fully unit-tested; `chat.js` behaviour is pinned by **source-guard** tests (readFileSync + regex).
  A behavioural fix ships a fail-before/pass-after test: run the new test against the pre-fix source (swap the
  file to `git show origin/main:<path>`), show red, restore, show green.
- **Backend**: `cd backend && TESTCONTAINERS_RYUK_DISABLED=true ./mvnw -DargLine="-Dapi.version=1.44" -Dtest=<Class> test`
  (the two flags are LOCAL-ONLY host workarounds — never commit; CI is fine without them). `./mvnw spotless:apply`
  before committing. Chat backend tests live in `backend/src/test/java/.../chat/` and `.../api/`. **A backend
  API change also runs `OpenApiDriftTest`** — regenerate + re-copy the spec (see Gotchas).
- **Before/after visual evidence** (any UI change, attached to the ticket at 390px): the mock-harness pattern
  is `web/e2e/capture-tm{853,939,940}.mjs` — boot the SPA via `serve.mjs`, `page.route`-mock the API, reveal
  the surface via a window seam (`window.tmChat.enterChat(id)` / `window.tmEvents.enterEvents(id)`), shoot at
  390×844. `before` = swap the changed source file(s) to `git show origin/main:...`; `after` = the branch.
  **A git worktree has no `web/e2e/node_modules`** — symlink it:
  `ln -sfn <main-repo>/web/e2e/node_modules <wt>/web/e2e/node_modules` (gitignored). **md5-check before≠after**
  (byte-identical = wrong frame). Attach via REST (the MCP connector has no attach tool):
  `curl -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" -H "X-Atlassian-Token: no-check" -F "file=@shot.png" "$JIRA_BASE_URL/rest/api/3/issue/TM-XX/attachments"`.
- **Don't over-exempt visual tickets.** Twice a "not really visual" exemption hid a genuinely visual defect
  (TM-853 the withheld button; TM-736 the toggle appearing after a transient failure). If a change alters what
  the user sees on ANY realistic path — even a contrived failure path — capture it via the mock harness rather
  than take the exemption.
- **e2e**: off the PR gate. Dispatch `gh workflow run e2e.yml --ref <branch>`; the orchestrator (main loop)
  watches it to `success` on the exact head SHA. Chat specs: `web/e2e/tests/chat-*.spec.mjs`,
  `tm939-composer-announce-row.spec.mjs`, `tm940-message-actions.spec.mjs`.

## Lane map (as of wave-chat-1 close, sprint 971 — 2026-07-22)

- **Shipped (wave-chat-1)**: TM-854 (#611, reaction rollback guard) · TM-855 (#615, deep-link unread badge) ·
  TM-856 (#609, postAnnouncement EVENT_GROUP assert) · TM-857 (#616, `ThreadOpenGate` + hygiene) · TM-853
  (#610, paged event-chat deep-link) · TM-736 (#620, admin-flag transient-failure fix) · TM-939 (#624, composer
  announce toggle on its own row **below** the input) · TM-940 (#628, industry-standard message row: aligned
  header, reaction pills, `⋯` tap-to-reveal actions, "Sent") · TM-957 (#630, closure-fix batch:
  close-menu-on-Reply, real long-press, un-react `@Size`, unread-total mock shape).
- **Foundation already Done pre-wave (TM-433 epic)**: data model, read/post APIs, push fan-out, reactions,
  read receipts, realtime transport (TM-464), typing, reply/quote (TM-466), edit/delete (TM-467), @mentions
  (TM-469), link previews (TM-470), mute/leave (TM-471), announcements (TM-710), sender avatars (TM-828),
  in-thread search (TM-690), admin-flag cache invalidation (TM-514).
- **Close-gates**: TM-942 (closure review, Fable — 10 minor/nit findings, 0 blockers) · TM-941 (human
  manual-test sign-off) · TM-943 (deploy — the sprint's real DoD).
- **Groomed follow-ups (Refinement, wave-chat-2)**: TM-958 (action-menu survives repaint + full keyboard a11y)
  · TM-959 (deep-link `resolveThreadUnread` page-walk + a source guard). Bigger open backlog: TM-468/658/659
  media, TM-691 entity detectors, TM-504/505 (**substantially superseded** — reply/edit/realtime already
  shipped; verify before building), TM-848 (moderation authz hardening — High/security, its own wave),
  TM-852/854/855/856/857 done; the rest of wave-bugs-1 cleared.
- **Related but NOT this lane**: admin-messages/broadcast (Admin) · notification-center bell TM-451
  (cross-cutting — ticket + coordinate, never claim) · the frontend admin **moderation UI** is a stub
  (`chat-moderation-core.js` is imported only by its own test; backend endpoints are live) — a real gap, but
  it's TM-449/admin-adjacent, so coordinate before claiming.
- **Lessons banked**: the OpenAPI three-copy lockstep + full-suite rule went into this doc's Gotchas; the Jira
  env-var snippet + never-merge/never-deploy into HANDOFF-CHAT.md.
