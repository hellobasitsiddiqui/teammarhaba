# Manual UI walkthroughs

Hand-run test scripts for verifying each epic in a real browser — for review sign-off and
exploratory testing. One section per epic, plus a reusable template at the end.

## Why manual, when we have Playwright?

The Playwright browser-e2e harness (`web/e2e/`, TM-134) is the **automated regression guard for the
critical happy path** — it runs hermetically against the Firebase Auth emulator on `main` only.
Manual walkthroughs are **complementary**; they cover what the automated harness deliberately can't:

| Manual catches | Why the Playwright harness can't (as built) |
|---|---|
| Real Firebase / Google sign-in, password-reset & verification emails | The e2e uses the **Auth emulator** — real OAuth popups, email delivery, and real provider config are never exercised |
| The **deployed** environment (Firebase Hosting + Cloud Run, CORS, injected `apiBaseUrl`, public access, real ADC) | The e2e runs against a **local hermetic stack**, so it can't see deploy/config drift |
| Visual / UX correctness — layout, dark/light theme, responsive, toast styling, keyboard/focus a11y | Playwright asserts element **state/presence**, not "does it look and feel right" |
| Not-yet-wired features (audit activity panel, 409 concurrency UI, soft-delete UI) | There's no UI affordance to drive yet |
| Broad / exploratory coverage for sign-off | e2e is intentionally **one** happy-path walkthrough; automating every path is expensive to maintain |

As features get wired and the harness grows, paths migrate from **manual → Playwright**. The goal is
that anything stable and core eventually has an automated walkthrough; manual stays for real-auth,
deployed-env, visual, and exploratory checks.

## How to use this doc

1. Pick an **environment** (see each epic's preconditions): the **deployed** app, or **local** via
   `make up`.
2. For local authenticated flows you also need: `gcloud auth application-default login` on the host
   (so the backend can verify Firebase tokens — TM-130) and the Firebase Auth providers enabled
   (email/password + Google — TM-121).
3. Walk the numbered steps; each has a ✅ **expected result**. Note anything that diverges.
4. Items marked **⚠️ not UI-visible** can't be confirmed in the browser yet — verify them the noted
   way (DB query, automated test) until the UI/endpoint lands.

---

## Epic 1 — Foundation (SKELETON)

Mostly infrastructure (CI/CD, deploy, security, error model), so this is largely a **smoke check**;
most of Epic 1 is verified by automated CI rather than the UI. `curl` is used where there's no UI.

**Preconditions:** stack up (`make up`) or the deployed URLs.

1. **Web skeleton loads.** Open the web app → the page renders ("TeamMarhaba — walking skeleton")
   with a status line. ✅ No console errors; the page is served (nginx locally, Firebase Hosting
   deployed).
2. **Health probe.** Visit `…:8080/health` (local) or the backend URL `/health`. ✅ Returns
   `{"status":"UP"}` as **JSON** in a browser, not XML (TM-126).
3. **Versioned API.** `curl …/api/v1/ping` and `…/api/v1/meta`. ✅ 200 JSON; unversioned infra
   paths (`/health`, `/actuator/*`) stay outside `/api/v1`.
4. **Error model (RFC 7807).** Hit an unknown route, e.g. `curl -i …/api/v1/nope`. ✅
   `application/problem+json` body with `type/title/status` — never a stack trace.
5. **Actuator.** `…/actuator/health` ✅ `UP`; component/liveness/readiness detail per TM-74.
6. **Security headers.** `curl -I …/` (web) ✅ shows the configured headers (e.g.
   `X-Content-Type-Options`, `X-Frame-Options`, CSP) — TM-78/79.
7. **Default-deny auth.** `curl -i …/api/v1/me` with no token ✅ `401` problem+json (TM-79).
8. **Clean-clone bring-up.** From a fresh clone, `make up` ✅ brings web (`:8081`) + backend
   (`:8080/health`) up with no manual `.env` step (TM-127).
9. **Deployed smoke (if applicable).** Open the deployed web URL ✅ loads and reaches the backend
   (the deploy injects the real `apiBaseUrl`; backend is publicly reachable — TM-96/128).

**⚠️ Not UI-visible:** the CI/CD pipeline, SBOM, coverage gate, image build/push — verified in
GitHub Actions, not the browser.

---

## Epic 2 — SPINE (login + accounts + RBAC + admin console)

The first real user-facing flows. Automated coverage: the Playwright admin walkthrough (TM-134).

**Preconditions:** an environment where auth works (deployed, or local with ADC + Firebase providers
enabled), and **one ADMIN account** — sign in once with it, promote it (first-admin bootstrap via
`ADMIN_BOOTSTRAP_EMAIL`, or set the `role=ADMIN` custom claim), then sign out/in so the claim is on
the token.

### 2.1 Sign-up / sign-in / social / sign-out (TM-105/106/109)
1. Open the app → you land on **`#/login`** with the sign-in card (Email, Password, **Sign in**,
   **Sign up**, **Continue with Google**).
2. **Sign up** with a new email/password → signed in, lands on the authenticated home.
3. **Sign out** → back to the login card; the "Sign in" nav link returns.
4. Sign back in with the same credentials → authenticated again.
5. (If Google enabled) **Continue with Google** → popup → signed in.
- ✅ Invalid credentials show an inline error; the nav flips between "Sign in" (signed out) and
  "Sign out" (signed in).

### 2.2 Authenticated home + backend-verified identity (TM-107/108/112)
1. Signed in, the home card shows **"Signed in as &lt;email&gt;"** and a line like
   **`API /me: <email> · role USER`**.
- ✅ That line comes from `GET /api/v1/me` with your Bearer token — proves the backend verified you
  and provisioned your `users` row (JIT).

### 2.3 Protected routes / auth guard (TM-109)
1. Sign out, then manually visit **`#/home`** → redirected to **`#/login`** (and returned to
   `#/home` after signing in).
2. As a non-admin USER, the **Admin** nav link is hidden; visiting **`#/admin`** directly
   redirects/guards you away.
- ✅ No protected content is visible while signed out or under-privileged.

### 2.4 RBAC + admin users console (TM-110/111/133/115)
Sign in as the **ADMIN** account:
1. The **Admin** nav link (and "Open admin console →") appear → open **`#/admin`**.
2. **Stats bar**: Total / Admins / Enabled / Disabled.
3. **Table** (Email, Name, Role, Status, ID, Actions): try **search**, the **Role** + **Status**
   filters, click a **sortable** column header, change **rows/page**, use **Prev/Next** (TM-115).
4. On another user's row → **Disable** → a **styled confirm dialog** → confirm → **success toast**
   (with **Undo**) and the Status badge flips to **Disabled**. Click **Undo** → reverts.
5. **Make admin** / **Remove admin** → confirm → role badge changes (effective on that user's next
   token refresh).
6. On **your own** row, the Disable/role buttons are **hidden** (self-protection; backend returns
   422 if forced).
7. **View** on a user → detail modal (profile + "Recent activity").

### 2.5 Negative-path RBAC
1. As a USER, hit an admin route → backend returns **403** problem+json; the UI handles it
   gracefully (no broken page).

**⚠️ Not UI-visible (yet):**
- **Audit log** — admin actions aren't wired to the audit log and there's no read endpoint yet
  (the detail modal shows "Activity log isn't available yet" — **TM-137**). Verify writes by
  querying the `audit_events` table.
- **Optimistic concurrency (409)** — no concurrent-edit affordance in the UI; covered by the TM-114
  integration tests (two stale writes → 409).
- **Soft-delete hidden/restorable** — the console's **Disable** toggles the `enabled` flag (account
  stays listed as *Disabled*); soft-delete (`deleted_at`) is a service-layer mechanism (TM-114),
  verified by tests + "reactivate on next sign-in", not a console button.

---

## Epic 3 — FLESH (the first real product feature)

_Not built yet._ When it lands, add a section using the template below.

---

## Template for a new epic

```markdown
## Epic N — <name> (<theme>)

<one-line summary; note automated coverage, e.g. a Playwright spec>

**Preconditions:** <environment + any seeded data / roles needed>

### N.1 <flow name> (TM-xxx)
1. <step>
2. <step>
- ✅ <expected result>

### N.2 <flow name> (TM-xxx)
...

**⚠️ Not UI-visible (yet):** <items + how to verify them otherwise, with a follow-up ticket link>
```

> Keep each step concrete and clickable, every flow ending in a ✅ expected result. When a flow gets
> a stable automated Playwright walkthrough, note it here and trim the manual steps to the bits
> automation can't cover (real auth, deployed env, visuals).
