---
name: jira-mcp-gotchas
description: Quick reference for the Atlassian MCP connector on 10xai Jira (project TM) — markdown rendering limits, the inverted createIssueLink direction, missing delete/move/sprint tools (UI-only), and custom field ids. Use before any bulk Jira create/edit/link operation, or when a Jira MCP call behaves unexpectedly (literal &amp;, wrong link direction, can't convert a sub-task to a task, can't start a sprint).
---

# jira-mcp-gotchas

Hard-won quirks of the Atlassian MCP connector against 10xai Jira (project key **TM**, cloudId `643606a4-9782-44b5-8c0a-da960167a962`). Read this before any bulk operation.

## Content / markdown
- `createJiraIssue` / `editJiraIssue` / `addCommentToJiraIssue` accept **markdown** via `contentFormat: "markdown"` (the default).
- **Renders:** headings, **bold**, `inline code`, tables, bullet/numbered lists, fenced code blocks.
- **Does NOT render:** blockquotes (`>`) and task-list checkboxes (`- [ ]`) → they appear as literal `>` / `[ ]`. Use bold labels + plain bullets.
- **Never HTML-escape** `&` `<` `>` — pass them literally. Escaping renders as `&amp;` etc. (very visible in summaries).

## Issue links (`createIssueLink`) — direction is inverted vs the tool docs
- To express **"X is blocked by Y"** (Y blocks X): `type: "Blocks"`, `inwardIssue: X` (blocked), `outwardIssue: Y` (blocker).
- Rationale: the `Blocks` link type defines `inward = "is blocked by"`, `outward = "blocks"`. The **inward** issue is the blocked one.
- **Always create one link, then read it back** and confirm before bulk-creating 50.
- Identical duplicate links: usually deduped/harmless; a timed-out call may or may not have created the link — verify or accept a possible dup.

## Missing tools (UI-only operations)
- **No delete-issue tool.** Cleanup = the user bulk-deletes in the UI. Provide a JQL, e.g. `project = TM AND issuetype in (Sub-task, Story)`.
- **No move / convert-issue-type tool.** You **cannot** change a Sub-task into a Task in place (`editJiraIssue` rejects it: "The issue type selected is invalid"). To restructure: **recreate** as the new type + user deletes the old ones.
- **Adding issues to a sprint DOES work** — set `customfield_10020 = <sprintId>` (an integer) via `editJiraIssue`. You just need the sprint id, and there's no list-sprints tool: discover it by reading `customfield_10020` off an issue already in a sprint, or probe (a fresh instance's first sprint is usually id `1` — set it on one issue, then `getJiraIssue fields:["customfield_10020"]` returns `[{id, name, state}]` to confirm). On TM, "SCRUM Sprint 1" = **id 1**.
- **No create/start-sprint tool.** Creating a sprint and **starting** it (activating + dates) is UI-only. You can pre-fill a `future` sprint with issues via the field above, then the user clicks Start.

## Field ids (project TM)
- Story point estimate: **`customfield_10016`** (number).
- Sprint: **`customfield_10020`**.
- Set via `additional_fields` on create, or `fields` on edit. Labels via the `labels` array.

## Issue-type ids (project TM)
- Epic `10001`, Sub-task `10002`, Task `10003`, Story `10004`, Bug `10007`.
- Hierarchy: Epic (level 1) → Story/Task (level 0) → Sub-task (level −1). Only Epic + Story/Task show in the Backlog/Board. Parent linking: Story/Task → Epic via `parent`; Sub-task → Story/Task via `parent`.

## Operational
- Discover before acting: `getVisibleJiraProjects`, `getJiraIssueTypeMetaWithFields` for field ids.
- **Pilot then batch:** create one issue, check the rendered UI, fix formatting, then fan out.
- Comment responses echo the full body (large) — batch but expect verbose results.
- A bulk `editJiraIssue` to add a label must send the **full** labels array (it replaces), so include the existing labels too.
