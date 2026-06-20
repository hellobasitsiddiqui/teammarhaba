---
name: jira-ticket-writer
description: Write a well-structured TeamMarhaba Jira ticket — a Standard section (user story + testable acceptance criteria + a Field/Value table) and a Human section in the description, plus the Agent execution prompt as a pinned first comment. Use whenever creating or drafting a Jira ticket/issue for the TM project (10xai), writing an "agent-pickable" ticket, or when the user asks for a ticket in "the TeamMarhaba format". Covers markdown rendering limits, the story-point field id, and labels.
---

# jira-ticket-writer

Produce a TeamMarhaba Jira ticket that a human can read and an agent can execute. The ticket is a **Task** (level-0, so it is independently pickable from the backlog — never a Sub-task; see `jira-epic-breakdown`).

## Anatomy

1. **Description** (markdown) = two sections:
   - `## Standard` — a user story + testable ACs + a small metadata table.
   - `## Human` — plain-English context / why it matters.
2. **Pinned first comment** = `## AGENT EXECUTION PROMPT` — the machine-executable instructions, kept out of the description so the description stays human-readable.

## Description template

```
## Standard

**As a** <role>, **I want** <capability>, **so that** <outcome>.

### Acceptance criteria
- Given <state>, when <action>, then <observable result>.
- ... (each AC must be testable / observable)

| Field | Value |
|---|---|
| **Story points** | <1|2|3|5|8> |
| **Labels** | `foundation` `<category>` `group-1.x` |
| **Blocked by** | <1.x.y refs, or "none"> |

## Human

<1-3 sentences: why this exists, how it fits, what's deliberately out of scope.>

**Agent execution prompt:** see the pinned *AGENT PROMPT* comment.
```

## Pinned comment template

```
## AGENT EXECUTION PROMPT
*Machine-executable — do not edit.*

**Objective:** <one line>

**Files / scope**
- <exact paths to create/modify>

**Steps**
1. ...
2. ...

**Constraints**
- <must / must-not: secrets, style, pin SHAs, etc.>

**Verify**
- <commands + expected result>

**Out of scope:** <what NOT to touch — keeps the agent in its lane>
```

## Creating it via the Atlassian MCP

- `createJiraIssue` with `issueTypeName: "Task"`, `projectKey: "TM"`, `parent: "<epic key>"`, `contentFormat: "markdown"`, the description string, and `additional_fields: {"labels": [...], "customfield_10016": <points>}` (**`customfield_10016` = Story point estimate**).
- Then `addCommentToJiraIssue` (markdown) with the AGENT EXECUTION PROMPT as the first comment.

## Markdown rendering rules (this connector) — IMPORTANT

- Renders fine: headings, **bold**, `inline code`, tables, bullet/numbered lists, fenced code blocks.
- Does **NOT** render: blockquotes (`>`) and task-list checkboxes (`- [ ]`) — they print literally. Use **plain bullets** for ACs and **bold labels** instead of blockquotes.
- **Never HTML-escape** `&` `<` `>` — write them literally (escaping shows `&amp;`, especially in summaries).
- Use a *single asterisk* `*italic*` for the "do not edit" note (blockquotes don't render).

## Conventions

- **Story points:** Fibonacci (1/2/3/5/8) sized to effort.
- **Labels:** always `foundation`; plus a category (`backend`, `ci`, `cd`, `docker`, `gcp`, `security`, `auth`, `observability`, `database`, `docs`, `devex`, `testing`, `supply-chain`, `preview-env`, `repo`); plus an area `group-1.x`; plus a `wave-N` (added in the dependency pass).
- ACs must be **observable/testable** so QA/an agent can verify them.
- Keep "Out of scope" explicit — it prevents scope creep across tickets.
