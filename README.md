# TeamMarhaba

A multi-surface application: a one-page **web** app, a **WebView** wrapper, a native **Android** app, and a shared **backend**.

**Stack:** Java 21 / Spring Boot, Cloud SQL (Postgres), Firebase Auth, Cloud Run + Firebase Hosting.

## Directory map

| Path | Purpose |
| --- | --- |
| `/backend` | Java 21 / Spring Boot API service (Cloud Run) |
| `/web` | Web single-page front end (Firebase Hosting) |
| `/webview` | Shared WebView assets/wrapper for the native shells |
| `/android` | Native Android app |
| `/infra` | Infrastructure & deployment config (GCP, CI/CD) |

Each directory has its own README. Most are stubs at this stage — the foundation tickets fill them in.
