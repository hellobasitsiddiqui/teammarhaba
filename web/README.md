# web

The TeamMarhaba web front end (single-page app). Built and deployed as static
assets to Firebase Hosting, and also shipped as a self-contained nginx container
(the same bundle the WebView wrapper reuses).

## Layout

- `src/` — the static one-page app (`index.html` + `assets/`).
- `nginx.conf` — runtime server config: SPA fallback (`try_files … /index.html`)
  and caching headers.
- `Dockerfile` — multi-stage build: assembles `src/` into `/dist` (the documented
  build seam for a real bundler later), then serves it from `nginx:1.27-alpine`.

## Build & run

```bash
# from web/
docker build -t teammarhaba-web .
docker run --rm -p 8080:8080 teammarhaba-web
# open http://localhost:8080
```

The container listens on port **8080**. Deep links / hard refreshes on a
sub-path fall back to `index.html` (SPA routing).

## Deploy

Merges to `main` deploy this app to Firebase Hosting (live channel) via
`.github/workflows/deploy.yml`. See `infra/gcp/firebase-hosting.md` for the
build seam, keyless auth, and rollback.

## Out of scope (later tickets)

- The native WebView wrapper (surface epic)
- A real JS bundler / framework
