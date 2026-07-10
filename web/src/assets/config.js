// Web runtime config (TM-104). Single source of the backend API base URL so nothing is
// hard-coded against a host. Local dev (docker-compose) talks to the backend on :8080; the
// deployed build overrides `apiBaseUrl` (e.g. the Cloud Run URL) at deploy time. Consumers
// read `window.TEAMMARHABA_CONFIG.apiBaseUrl` (the API client lands in TM-108).
//
// `authEmulatorHost` is null in every real environment — Firebase Auth runs for real. It is
// set ONLY by the browser-e2e harness (TM-134), which serves a generated config pointing the
// Firebase client SDK at a local Auth emulator (see web/e2e/). Prod/dev never set it, so
// production auth behaviour is unchanged. `storageEmulatorHost` is the exact same idea for the
// Firebase Storage emulator (TM-166 avatar uploads): null everywhere except e2e.
//
// `buildVersion` is `git describe --tags` output for the web bundle (TM-155) — a readable build
// name from the nearest release tag (e.g. v1.4.0-12-ged338a9), or the bare short SHA until
// anything is tagged. It stays "dev" locally; the deploy injects the real value into this file
// the same way it injects `apiBaseUrl` (TM-142), so the live first page can show which build it
// is — and reveal a stale surface at a glance.
//
// NOTE (TM-529): there is no longer a `theme` config key. The multi-theme family system
// (clean/doodle/sketch) is retired — Paper is the single app theme. The only look the user can
// change is now PER-USER, from profile settings: the accent swatch + the wavy/sketchy toggle,
// persisted server-side (see appearance.js / appearance-settings.js). Nothing app-wide to configure.
//
// `ops*` (TM-183) drive the admin Operations panel's external-console links (Cloud Run, Logs Explorer,
// Firebase Auth, Artifact Registry, GitHub, Jira, the live site). They are the project's identifiers —
// NOT hardcoded in admin.js — so a re-skin/replay renders correct links by changing config, not code.
// The values below are TeamMarhaba's worked example (mirroring docs/agents/CONSTANTS.md); the deploy
// injects them into the built config.js the same way it injects `apiBaseUrl` (TM-142), so a re-skinned
// deploy.yml/CONSTANTS flows through. Any left blank simply hides its link (admin-ops-core.js).
//
// `flags` (TM-480) is the web feature-flag block — plain booleans read as `config.flags.<name>` that
// gate not-yet-launched screens behind an off switch so they can ship as inert dead code and be turned
// on later without a code change. `flags.membership` gates the whole Membership slice (the TM-480 tier
// screen + the TM-479 pricing/checkout screen, which READS this same flag); it ships OFF. This ticket
// is the flag owner (adds the key); a deploy can flip it the same way it overrides other config values.
//
// `payments` (TM-478) is the client-side Revolut checkout config for the membership PAY path. The
// `revolutPublicKey` is the SANDBOX Merchant PUBLIC key (pk_…) — public BY DESIGN: it ships in the
// browser widget and is not a secret (the Secret key lives server-side in Secret Manager). `revolutMode`
// selects the sandbox widget behaviour and `revolutScriptUrl` is the sandbox RevolutCheckout.js loader
// (a plain external CDN script the widget mounts from — not a fingerprinted local module). Only READ
// behind the OFF `membership` flag, so it is inert until the slice ships; go-live swaps the sandbox key +
// mode + script URL for the live ones the same way the deploy overrides other config values.
window.TEAMMARHABA_CONFIG = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8080",
    authEmulatorHost: null,
    storageEmulatorHost: null,
    buildVersion: "dev",
    opsProject: "teammarhaba",
    opsRegion: "europe-west2",
    opsService: "teammarhaba-backend",
    opsRepo: "hellobasitsiddiqui/teammarhaba",
    opsJiraBoardUrl: "https://10xai.atlassian.net/jira/software/projects/TM/boards/1",
    flags: Object.freeze({
        // Membership slice (TM-457): OFF until the tier (TM-480) + pricing/checkout (TM-479) screens
        // and the backend (TM-474) all land. Flip to true to reveal the membership screens.
        membership: false,
    }),
    payments: Object.freeze({
        // Revolut SANDBOX Merchant PUBLIC key (pk_…) — public by design, ships in the client widget (TM-478).
        revolutPublicKey: "pk_oAVwQr53jX37c6UacDoUr88gGXNLZB2CYLoa9neTXHfDUU0Z",
        revolutMode: "sandbox",
        revolutScriptUrl: "https://sandbox-merchant.revolut.com/embed.js",
    }),
});
