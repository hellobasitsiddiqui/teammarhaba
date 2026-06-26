// TM-318 — inject the persisted phone-auth e2e flag into the app's WebView over CDP.
//
// The Maestro SMS flow (login-sms.yaml) needs `localStorage["tm_e2e_phone_test"] = "1"` set INSIDE
// the app's WebView so web/src/assets/auth.js disables reCAPTCHA app-verification for the Firebase
// test phone number (see phone-e2e.js). Maestro can't reach the WebView's JS context, and a `window`
// global / `Page.addScriptToEvaluateOnNewDocument` hook is lost on the app relaunch Maestro performs.
// A PERSISTED localStorage value survives those relaunches, so we set it once here over the Chrome
// DevTools Protocol before handing off to Maestro.
//
// Runs on Node 22 (global `fetch` + global `WebSocket`, no deps). Expects an `adb forward` already in
// place mapping a local TCP port to the WebView's devtools socket; pass that port as $CDP_PORT (the
// CI step below sets up the forward and invokes this). The script:
//   1. GET http://localhost:$CDP_PORT/json  → find the page target's webSocketDebuggerUrl
//   2. Runtime.evaluate  localStorage.setItem('tm_e2e_phone_test','1')
//   3. Runtime.evaluate  localStorage.getItem(...)  → verify it stuck
//   4. Page.reload       so auth.js re-reads the flag on the next document load
// Exits non-zero (failing the CI step) if no page target is found or the verify read != "1".

const PORT = process.env.CDP_PORT || "9222";
const KEY = "tm_e2e_phone_test";
const VALUE = "1";

/** Resolve the WebView page target's CDP websocket URL from the /json discovery endpoint. */
async function findPageTarget() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json returned HTTP ${res.status}`);
  const targets = await res.json();
  // Prefer an actual "page" target; fall back to the first target with a ws debugger URL.
  const page =
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ||
    targets.find((t) => t.webSocketDebuggerUrl);
  if (!page) {
    throw new Error(
      `No CDP page target with a webSocketDebuggerUrl found (got ${targets.length} target(s)). ` +
        `Is the WebView up and is WebView debugging enabled (debug build)?`,
    );
  }
  return page.webSocketDebuggerUrl;
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

  /** Run a JS expression in the page and return the evaluated value. */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result && result.result.value;
  }

  return { ws, ready, send, evaluate };
}

async function main() {
  const wsUrl = await findPageTarget();
  console.log(`[inject-e2e-flag] attaching to WebView target: ${wsUrl}`);
  const cdp = connect(wsUrl);
  await cdp.ready;

  // Set the persisted flag, then read it back to confirm it stuck.
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(VALUE)})`);
  const readBack = await cdp.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`);
  if (readBack !== VALUE) {
    throw new Error(`Verify failed: localStorage["${KEY}"] = ${JSON.stringify(readBack)} (expected "${VALUE}")`);
  }
  console.log(`[inject-e2e-flag] set + verified localStorage["${KEY}"] = "${VALUE}"`);

  // Reload so auth.js re-evaluates with the flag present on the next document load.
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.reload", { ignoreCache: false });
  console.log("[inject-e2e-flag] reloaded the WebView; flag will be honoured on next page load.");

  cdp.ws.close();
}

main().catch((err) => {
  console.error(`[inject-e2e-flag] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
