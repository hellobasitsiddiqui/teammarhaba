# Hosted downloads (legacy path — see TM-331)

This directory is published to Firebase Hosting under `/downloads/` (TM-246).

> **TM-331 — the signed APK is no longer hosted here.** A Firebase Hosting deploy replaces the
> *whole* site, so a web-only `deploy.yml` run rebuilds `web/dist` from `web/src` (which has no
> binary) and **wiped** any `/downloads/teammarhaba.apk` the release job had placed in Hosting —
> leaving the SPA `index.html` served (and downloaded) under that path renamed `.apk`. The signed
> APK is now published as a **deploy-immune GitHub Release asset**, *outside* the Hosting site, so
> web deploys can never touch it:
>
> - Public URL: <https://github.com/hellobasitsiddiqui/teammarhaba/releases/latest/download/teammarhaba.apk>
>
> The `/download` landing page (`web/src/download/index.html`) points at that public URL. The
> upload is done by the `release` job in `.github/workflows/android-release.yml` (on a git tag or
> manual `workflow_dispatch`), using the built-in `GITHUB_TOKEN` — no bucket, no IAM, no org-policy
> exception. (A public GCS bucket was the first cut but its `allUsers` binding is rejected by the
> org policy `iam.allowedPolicyMemberDomains` — `HTTPError 412`.) See
> `infra/gcp/firebase-hosting.md` ("APK download host — GitHub Release asset (TM-331)"). The proper
> production host is tracked in **TM-336**.

> Note (TM-278): the Capacitor adoption replaced the hand-rolled TM-231 WebView shell with a
> Capacitor `BridgeActivity`. The in-app auto-update prompt that previously lived in
> `android/.../UpdateChecker.kt` was not ported in TM-278 (out of its ACs) and is tracked as an
> epic follow-up; the hosted APK path above is unchanged.

The APK itself is **never committed** — it's a build artifact produced from the keystore secrets
(stored by the human ticket **TM-245**) and uploaded straight to the GCS bucket by CI. This
directory is kept only so a plain web deploy still serves a real (if APK-less) `/downloads/` path;
the live APK no longer lives here.
