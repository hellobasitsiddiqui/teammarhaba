#!/usr/bin/env bash
# TM-340 — best-effort Jira evidence poster for the on-demand test-suite workflow (test-suite.yml).
#
# Attaches, to the ticket named by $TICKET:
#   1. a screenshot/report evidence zip built from the dirs passed as args, and
#   2. a summary.txt (suite / surface / pass-fail / run link),
# then posts a one-line pass/fail COMMENT via the Jira REST API (ADF).
#
# NEVER fails the calling job: any missing secret / ticket / evidence, or any HTTP error, is logged as
# a ::warning:: and the script still exits 0. (The suite's own pass/fail is the job's real result; this
# is only evidence plumbing.) Mirrors the curl pattern in .github/workflows/jira-sprint-admin.yml.
#
# Env in: JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, TICKET, SUITE, SURFACE, RESULT (job.status),
#         plus GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (for the run link).
# Args:   one or more evidence directories to zip (e.g. web/e2e/playwright-report web/e2e/test-results).
set -o pipefail

warn() { echo "::warning::$*"; }

if [ -z "${JIRA_BASE_URL:-}" ] || [ -z "${JIRA_USER_EMAIL:-}" ] || [ -z "${JIRA_API_TOKEN:-}" ]; then
  warn "Jira secrets not set — skipping evidence post for ${TICKET:-<none>}."; exit 0
fi
if [ -z "${TICKET:-}" ]; then
  warn "no Jira ticket given — skipping evidence post."; exit 0
fi

SUITE="${SUITE:-unknown}"
SURFACE="${SURFACE:-unknown}"
RESULT="${RESULT:-unknown}"      # GitHub job.status: success | failure | cancelled
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

# Pass/fail wording from the job status.
case "$RESULT" in
  success)   VERDICT="PASSED" ;;
  failure)   VERDICT="FAILED" ;;
  cancelled) VERDICT="CANCELLED" ;;
  *)         VERDICT="$(echo "$RESULT" | tr '[:lower:]' '[:upper:]')" ;;
esac

# 1. summary.txt
SUMMARY="/tmp/test-suite-summary-${GITHUB_RUN_ID:-local}.txt"
{
  echo "TeamMarhaba on-demand test suite"
  echo "  suite:   ${SUITE}"
  echo "  surface: ${SURFACE}"
  echo "  result:  ${VERDICT}"
  echo "  run:     ${RUN_URL}"
} > "$SUMMARY"

AUTH="${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}"

attach() {  # attach <file>
  local file="$1"
  [ -f "$file" ] || { warn "attachment missing: $file"; return 0; }
  local code
  code="$(curl -sS -o /tmp/jira-att.txt -w '%{http_code}' \
    -u "$AUTH" \
    -H "X-Atlassian-Token: no-check" \
    -F "file=@${file}" \
    "${JIRA_BASE_URL}/rest/api/3/issue/${TICKET}/attachments" || echo "000")"
  case "$code" in
    200|201) echo "Attached $(basename "$file") to ${TICKET}." ;;
    *) warn "could not attach $(basename "$file") to ${TICKET} (HTTP ${code}): $(cat /tmp/jira-att.txt 2>/dev/null)" ;;
  esac
}

# 2. evidence zip from whatever dirs exist (screenshots forced on via --screenshot=on in the workflow).
ZIP="/tmp/test-suite-evidence-${GITHUB_RUN_ID:-local}.zip"
have_evidence=0
for d in "$@"; do
  [ -d "$d" ] && have_evidence=1
done
if [ "$have_evidence" = "1" ]; then
  zip -qr "$ZIP" "$@" 2>/dev/null || true
  [ -f "$ZIP" ] && attach "$ZIP" || warn "failed to build evidence zip — skipping (no screenshots to attach)."
else
  warn "no evidence directories found (${*:-none}) — attaching the summary only."
fi

attach "$SUMMARY"

# 3. one-line pass/fail comment (ADF). If the ADF POST is rejected, fall back to no comment — the
#    summary.txt attachment already carries the verdict, so this stays best-effort.
COMMENT_TEXT="On-demand test suite '${SUITE}' on ${SURFACE}: ${VERDICT}. Evidence attached. Run: ${RUN_URL}"
# Build the ADF comment body with jq (already a runner dependency — see jira-sprint-admin.yml), so the
# comment text is safely JSON-escaped without needing python.
BODY="$(jq -n --arg t "$COMMENT_TEXT" \
  '{body:{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:$t}]}]}}')"
code="$(curl -sS -o /tmp/jira-comment.txt -w '%{http_code}' \
  -u "$AUTH" -X POST \
  -H 'Content-Type: application/json' \
  --data "$BODY" \
  "${JIRA_BASE_URL}/rest/api/3/issue/${TICKET}/comment" || echo "000")"
case "$code" in
  200|201) echo "Posted pass/fail comment to ${TICKET}." ;;
  *) warn "could not post comment to ${TICKET} (HTTP ${code}): $(cat /tmp/jira-comment.txt 2>/dev/null). Verdict is still in the attached summary.txt." ;;
esac

exit 0
