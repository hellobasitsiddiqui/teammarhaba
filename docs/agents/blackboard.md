# Agent Blackboard — shared operational notes

**Canonical seed** for the repo's `docs/agents/blackboard.md`. Append-only, broadcast to all agents (the *blackboard* / stigmergy pattern). **Read this on startup and after every claim**, before you start work — it carries cross-cutting operational knowledge so no agent rediscovers what another already learned.

**Rules**
- **Append, don't rewrite** (avoids clobbering other agents' notes). One entry per finding: `### YYYY-MM-DD HH:MM <agentId> — <title>`.
- This file is **per-run scratch** — it's deleted with the source on a replay. So anything that must survive (findings, sequence fixes) **also** goes in the relevant Jira ticket or `REPLAY.md`. See the redo keep-list.
- Ticket-specific coordination → **Jira comments**, not here. Here = environment, tooling, "main is red", reusable workarounds.
- Directed messages → `docs/agents/inbox/<agentId>.md` (optional mailboxes).

---

## Environment & toolchain (known state)

### 2026-06-20 — gcloud: installed + authed ✅ (but Homebrew cask is broken on this host)
- gcloud SDK **573.0.0** is installed and on PATH; `gcloud auth login` + `gcloud auth application-default login` are **done** (account `basit@10xai.co.uk`, ADC token verified). Only `gcloud config set project` remains, deferred until the project exists (TM-66).
- **Gotcha:** `brew install --cask google-cloud-sdk` extracts the SDK then fails its `virtualenv` postflight and rolls back. The SDK files survive and run fine. **Working installs:** symlink the survivors — `ln -sf /opt/homebrew/share/google-cloud-sdk/bin/{gcloud,gsutil,bq} /opt/homebrew/bin/` — or use Google's official tarball (no virtualenv postflight). Tracked on TM-81.

### 2026-06-20 — Docker: works ✅
- Docker is available on the host — TM-51 built and ran the nginx image fine (~41m incl. build). No Docker gap.

### 2026-06-20 — GCP billing: PENDING ⛔ (cloud tasks held)
- TM-66/63/67 are **held** (assigned to Basit, flagged Impediment) until billing is confirmed/linked (TM-84). Don't attempt cloud/paid-resource tasks until released. gcloud auth is done; billing is the last cloud prereq.

---

## Conventions reminders (full versions in the skills/docs)

### Board fields / time tracking — keep the board functional
- On **claim**: set **Start date** (`customfield_10015` = today).
- On **PR / In Review**: log a **worklog** of actual elapsed (`addWorklogToJiraIssue`, `timeSpent` + `started` = claim time) and set **Due date** (`duedate`) if unset.
- If **blocked/held**: set **Flagged = Impediment** (`customfield_10021` = `[{"value":"Impediment"}]`); clear when unblocked.
- Story points = the estimate (Original Estimate isn't on the Task screen — UI-admin toggle needed). See `jira-mcp-gotchas` → Time tracking.

### createIssueLink direction — VERIFY by read-back
- To express "X is blocked by Y": `type:"Blocks"`, `inwardIssue: X` (blocked), `outwardIssue: Y` (blocker). When you read an issue, **your blocker shows as `outwardIssue`**. An agent got this backwards once (TM-81→TM-66) — **always create one link and read it back** before trusting the direction.

### Hit a wall? Log it
- Comment the blocker on the ticket + a `[finding → future improvement]` note; raise a `human-in-the-loop` ticket for human-only steps. Never fail silently.
