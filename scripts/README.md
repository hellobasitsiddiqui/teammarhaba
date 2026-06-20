# scripts

## `gen-dag.py` — live dependency DAG (TM-94)

Renders the TeamMarhaba (Jira project **TM**) dependency graph as a **Mermaid**
`graph TD`, coloured by status. Paste the output into
[mermaid.live](https://mermaid.live), any Markdown preview, or write it straight
into `docs/agents/DEPENDENCY-DAG.md`.

### Why a script (vs a Marketplace app)
Jira has no native node-graph view, and generic dependency-graph apps would draw
our arrows **backwards** — on this board the `Blocks` links are stored inverted,
so the real blocker of an issue is the link's `outwardIssue` (see the
`jira-mcp-gotchas` skill). This script encodes that fix.

### Usage

```bash
# Live — needs a Jira API token in the environment:
export JIRA_BASE_URL=https://10xai.atlassian.net
export JIRA_USER_EMAIL=you@10xai.co.uk
export JIRA_API_TOKEN=*****            # id.atlassian.com → API tokens

python3 scripts/gen-dag.py --scope sprint   # active sprint only (default)
python3 scripts/gen-dag.py --scope all      # whole TM project

# Offline — from a saved Jira search response (fields: summary,status,issuelinks):
python3 scripts/gen-dag.py --from-file dag.json

# Rewrite the ```mermaid``` block in docs/agents/DEPENDENCY-DAG.md:
python3 scripts/gen-dag.py --scope all --write
```

Stdlib only (Python 3) — no dependencies. The same `JIRA_*` secrets used by the
`jira-merge-to-done` Action (TM-86) work here.

### Status colours
To Do · In Progress · In Review · Done — each a Mermaid `classDef`.
