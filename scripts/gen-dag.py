#!/usr/bin/env python3
"""Render the live TeamMarhaba (Jira project TM) dependency graph as Mermaid.

Reads TM issues + their "Blocks" links from the Jira REST API (or a saved JSON
file) and emits a Mermaid `graph TD`, coloured by status.

IMPORTANT — inverted links: on this board the Blocks links are stored inverted
vs the true dependency direction. The *real* blocker of an issue is the
`outwardIssue` on its Blocks links (not the inwardIssue). See the
`jira-mcp-gotchas` skill. This script encodes that, so arrows come out
blocker -> blocked.

Usage:
    # Live (needs env: JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN)
    python3 scripts/gen-dag.py --scope sprint        # active sprint only
    python3 scripts/gen-dag.py --scope all           # whole project

    # Offline, from a saved Jira search response
    python3 scripts/gen-dag.py --from-file dag.json

    # Rewrite the ```mermaid``` block in docs/agents/DEPENDENCY-DAG.md
    python3 scripts/gen-dag.py --scope all --write
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.request
import urllib.parse

DEFAULT_DAG_DOC = "docs/agents/DEPENDENCY-DAG.md"

# Jira status name -> (mermaid class, label). statusCategory is the fallback.
STATUS_CLASS = {
    "To Do": "todo",
    "In Progress": "prog",
    "In Review": "review",
    "Done": "done",
}
CATEGORY_CLASS = {"new": "todo", "indeterminate": "prog", "done": "done"}

CLASSDEFS = [
    "classDef todo fill:#eceff1,stroke:#90a4ae,color:#263238;",
    "classDef prog fill:#fff8e1,stroke:#f9a825,color:#5d4037;",
    "classDef review fill:#e3f2fd,stroke:#1e88e5,color:#0d47a1;",
    "classDef done fill:#e8f5e9,stroke:#43a047,color:#1b5e20;",
]


def _req(url, token_b64):
    return urllib.request.Request(
        url,
        headers={"Authorization": f"Basic {token_b64}", "Accept": "application/json"},
    )


def fetch_live(scope):
    base = os.environ.get("JIRA_BASE_URL")
    email = os.environ.get("JIRA_USER_EMAIL")
    token = os.environ.get("JIRA_API_TOKEN")
    if not (base and email and token):
        sys.exit(
            "Missing env. Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN "
            "(or use --from-file)."
        )
    token_b64 = base64.b64encode(f"{email}:{token}".encode()).decode()
    jql = "project = TM AND issuetype = Task"
    if scope == "sprint":
        jql += " AND sprint in openSprints()"
    issues, start = [], 0
    while True:
        q = urllib.parse.urlencode(
            {
                "jql": jql,
                "startAt": start,
                "maxResults": 100,
                "fields": "summary,status,issuelinks",
            }
        )
        with urllib.request.urlopen(
            _req(f"{base.rstrip('/')}/rest/api/3/search?{q}", token_b64)
        ) as r:
            data = json.load(r)
        issues.extend(data.get("issues", []))
        if start + data.get("maxResults", 0) >= data.get("total", 0):
            break
        start += data.get("maxResults", 100)
    return issues


def _status_class(fields):
    st = fields.get("status", {}) or {}
    name = st.get("name", "")
    if name in STATUS_CLASS:
        return STATUS_CLASS[name]
    cat = (st.get("statusCategory", {}) or {}).get("key", "")
    return CATEGORY_CLASS.get(cat, "todo")


def _short(summary, n=42):
    summary = (summary or "").replace('"', "'").strip()
    return summary if len(summary) <= n else summary[: n - 1] + "…"


def build_mermaid(issues, title="TeamMarhaba dependency DAG (live from Jira)"):
    keys = {i["key"] for i in issues}
    nodes, edges = {}, set()
    for i in issues:
        f = i["fields"]
        nodes[i["key"]] = (_short(f.get("summary")), _status_class(f))
        for link in f.get("issuelinks", []) or []:
            if (link.get("type", {}) or {}).get("name") != "Blocks":
                continue
            # Inverted convention: the real blocker is the outwardIssue.
            blocker = link.get("outwardIssue")
            if not blocker:
                continue
            b = blocker["key"]
            if b in keys:  # keep the graph scoped to the fetched issue set
                edges.add((b, i["key"]))

    lines = [f"%% {title}", "graph TD"]
    lines += ["  " + c for c in CLASSDEFS]
    for key in sorted(nodes):
        label, cls = nodes[key]
        nid = key.replace("-", "_")
        lines.append(f'  {nid}["{key}<br/>{label}"]:::{cls}')
    for b, t in sorted(edges):
        lines.append(f"  {b.replace('-', '_')} --> {t.replace('-', '_')}")
    return "\n".join(lines)


def write_into_doc(mermaid, path):
    with open(path, "r", encoding="utf-8") as fh:
        doc = fh.read()
    block = f"```mermaid\n{mermaid}\n```"
    new, n = re.subn(r"```mermaid.*?```", block, doc, count=1, flags=re.DOTALL)
    if n == 0:
        sys.exit(f"No ```mermaid``` block found in {path}.")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new)
    print(f"Updated mermaid block in {path}")


def main():
    ap = argparse.ArgumentParser(description="Render the TM dependency DAG as Mermaid.")
    ap.add_argument("--scope", choices=["sprint", "all"], default="sprint")
    ap.add_argument("--from-file", help="Read a saved Jira search JSON instead of the API")
    ap.add_argument("--write", action="store_true", help=f"Rewrite the mermaid block in {DEFAULT_DAG_DOC}")
    ap.add_argument("--doc", default=DEFAULT_DAG_DOC)
    args = ap.parse_args()

    if args.from_file:
        with open(args.from_file, encoding="utf-8") as fh:
            issues = json.load(fh).get("issues", [])
    else:
        issues = fetch_live(args.scope)

    mermaid = build_mermaid(issues)
    if args.write:
        write_into_doc(mermaid, args.doc)
    else:
        print(mermaid)


if __name__ == "__main__":
    main()
