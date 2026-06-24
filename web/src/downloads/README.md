# Hosted downloads

This directory is published to Firebase Hosting under `/downloads/` (TM-246).

The signed Android release APK is published here as **`teammarhaba.apk`** by the
`android-release.yml` workflow (the signed-release job, on a git tag or manual
`workflow_dispatch`). The `/download` landing page (`web/src/download/index.html`) and the
in-app auto-update prompt (`android/.../UpdateChecker.kt`) both point at
`https://teammarhaba.web.app/downloads/teammarhaba.apk`.

The APK itself is **never committed** — it's a build artifact produced from the keystore secrets
(stored by the human ticket **TM-245**) and uploaded straight to Hosting by CI. This file only
keeps the directory present in the repo so a plain web deploy serves a real (if APK-less) path,
and the `/download` page's HEAD probe degrades gracefully until the first release lands.
