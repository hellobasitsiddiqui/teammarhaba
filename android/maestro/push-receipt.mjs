// TM-399 — receiver-side setup for the events reminder/lifecycle PUSH RECEIPT check (the TM-368 method).
//
// Pure Maestro cannot make the device opt into push, fetch its FCM registration token, or read the
// notification tray — so the "a real reminder/lifecycle push was RECEIVED on the emulator" half of
// TM-399 is a best-effort HARNESS step (ci-run.sh → verify_reminder_push), not a Maestro flow. This
// script is the WebView-side piece of it: over the Chrome DevTools Protocol (the same CDP bridge
// inject-e2e-flag.mjs uses for the reCAPTCHA flag) it drives the app's OWN client modules to:
//
//   1. OPT the signed-in account INTO push  — api.js `updateMe({ notificationPref: "BOTH" })`. Push
//      defaults to EMAIL = opted out (TM-358), so without this a reminder/broadcast reaches nobody.
//   2. READ the device's registered FCM token — push.js `getCurrentToken()` (the token push.js POSTed
//      to /api/v1/me/devices on login, once POST_NOTIFICATIONS was granted). Its PRESENCE is the proof
//      the google_apis emulator got a real FCM token and this device is now targetable.
//
// It drives the real shipped code (dynamic `import()` of the same-origin modules) rather than
// re-implementing the API calls, so there are no invented request shapes and the Firebase ID token is
// attached by apiFetch exactly as in the app. Requires a SIGNED-IN session on the attached WebView
// (ci-run.sh runs this straight after events.yaml, before the next flow's `pm clear`).
//
// Node 22 (global fetch + WebSocket, no deps). Expects an `adb forward` mapping $CDP_PORT to the
// WebView devtools socket already in place (ci-run.sh sets it up). NEVER fatal to the run: it prints a
// one-line JSON summary and exits 0 even when push isn't available (no token / not signed in / opt-in
// failed) — the emulator may not deliver an FCM token, which is expected and must not red the suite.

const PORT = process.env.CDP_PORT || "9222";
const HOSTED = "teammarhaba.web.app";
const PUSH_PREF = "BOTH"; // EMAIL | PUSH | BOTH — BOTH keeps email and adds push (TM-358)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll /json until a page target on the hosted SPA appears; return its webSocketDebuggerUrl. */
async function findHostedPageTarget(maxWaitMs = 60000) {
  const start = Date.now();
  let lastSeen = "(none)";
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json`);
      if (res.ok) {
        const targets = await res.json();
        lastSeen = targets.map((t) => `${t.type}:${t.url}`).join(", ") || "(no targets)";
        const hosted = targets.find(
          (t) => t.type === "page" && t.webSocketDebuggerUrl && typeof t.url === "string" && t.url.includes(HOSTED),
        );
        if (hosted) return hosted.webSocketDebuggerUrl;
      }
    } catch {
      /* devtools endpoint not ready yet — keep polling */
    }
    await sleep(2000);
  }
  throw new Error(`No CDP page target on ${HOSTED} after ${maxWaitMs}ms. Last targets: ${lastSeen}.`);
}

/** Minimal CDP client over the discovered websocket: send commands, await matching responses. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page, awaiting a returned promise, and return its value by value.
   * Throws on a JS exception so callers can degrade gracefully. Used to await the app's async client
   * modules (dynamic import + updateMe/getCurrentToken all return promises).
   */
  async function evaluateAsync(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    }
    return result.result && result.result.value;
  }

  return { ws, ready, evaluateAsync };
}

/** Wait until the attached document has a real http(s) origin (SPA loaded, modules resolvable). */
async function waitForRealOrigin(cdp, maxWaitMs = 45000) {
  const start = Date.now();
  let last = "(unknown)";
  while (Date.now() - start < maxWaitMs) {
    last = await cdp.evaluateAsync("location.origin").catch(() => null);
    if (typeof last === "string" && /^https?:/.test(last)) return last;
    await sleep(1000);
  }
  throw new Error(`WebView never reached a real http(s) origin (last: ${last}).`);
}

async function main() {
  const summary = { signedIn: false, optInPref: null, tokenPresent: false, tokenPrefix: null, notes: [] };

  const wsUrl = await findHostedPageTarget();
  const cdp = connect(wsUrl);
  await cdp.ready;
  await waitForRealOrigin(cdp);

  // Are we signed in? (updateMe needs a Bearer token; degrade clearly if not.)
  summary.signedIn = Boolean(
    await cdp
      .evaluateAsync(`import('/assets/auth.js').then(m => !!(m.getIdToken && (typeof m.getCurrentUser === 'function' ? m.getCurrentUser() : true)), () => false).catch(() => false)`)
      .catch(() => false),
  );

  // 1) Opt into push (idempotent PATCH /me). Report the pref the server accepted, or the error class.
  summary.optInPref = await cdp
    .evaluateAsync(
      `import('/assets/api.js')
         .then(m => m.updateMe({ notificationPref: ${JSON.stringify(PUSH_PREF)} }))
         .then(me => (me && me.notificationPref) || ${JSON.stringify(PUSH_PREF)}, e => 'ERR:' + (e && e.message || e))`,
    )
    .catch((e) => "ERR:" + (e && e.message));
  if (typeof summary.optInPref === "string" && summary.optInPref.startsWith("ERR:")) {
    summary.notes.push(`opt-in failed (${summary.optInPref}) — not signed in, or push pref rejected`);
  }

  // 2) Read the device's registered FCM token. Presence ⇒ the emulator obtained a real FCM token and
  //    push.js registered it — this device is targetable. Never print the full token.
  const token = await cdp
    .evaluateAsync(`import('/assets/push.js').then(m => (m.getCurrentToken && m.getCurrentToken()) || null, () => null)`)
    .catch(() => null);
  if (typeof token === "string" && token.length > 0) {
    summary.tokenPresent = true;
    summary.tokenPrefix = token.slice(0, 8) + "…";
  } else {
    summary.notes.push("no FCM token yet — grant POST_NOTIFICATIONS + let Play services deliver one (emulator-dependent)");
  }

  console.log("[push-receipt] " + JSON.stringify(summary));
  cdp.ws.close();
}

main().catch((err) => {
  // Non-fatal by contract: log and still exit 0 so the best-effort push check never reds the suite.
  console.log("[push-receipt] " + JSON.stringify({ ok: false, error: (err && err.message) || String(err) }));
  process.exit(0);
});
