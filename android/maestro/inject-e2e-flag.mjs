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
// place mapping a local TCP port to the WebView's devtools socket; pass that port as $CDP_PORT.
//
// IMPORTANT (the race this guards against): right after the app launches, the WebView document is
// `about:blank` (no origin) until the SPA navigates to https://teammarhaba.web.app. `localStorage` on
// an origin-less document throws `SecurityError: Access is denied for this document`. So we (1) wait
// for the page target whose URL is the hosted SPA, and (2) wait for `location.origin` to be a real
// http(s) origin, before writing the key.

const PORT = process.env.CDP_PORT || "9222";
const KEY = "tm_e2e_phone_test";
const VALUE = "1";
const HOSTED = "teammarhaba.web.app";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll /json until a page target on the hosted SPA appears; return its webSocketDebuggerUrl. */
async function findHostedPageTarget(maxWaitMs = 90000) {
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
  throw new Error(
    `No CDP page target on ${HOSTED} after ${maxWaitMs}ms. Last targets seen: ${lastSeen}. ` +
      `Is the WebView loading the hosted SPA, and is this a DEBUG build (WebView debugging on)?`,
  );
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

  /** Run a JS expression in the page and return the evaluated value (or throw on JS exception). */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result && result.result.value;
  }

  return { ws, ready, send, evaluate };
}

/** Wait until the attached document has a real http(s) origin (not about:blank → no localStorage). */
async function waitForRealOrigin(cdp, maxWaitMs = 45000) {
  const start = Date.now();
  let last = "(unknown)";
  while (Date.now() - start < maxWaitMs) {
    last = await cdp.evaluate("location.origin").catch(() => null);
    if (typeof last === "string" && /^https?:/.test(last)) return last;
    await sleep(1000);
  }
  throw new Error(`WebView never reached a real http(s) origin (last: ${last}); localStorage would be inaccessible.`);
}

async function main() {
  const wsUrl = await findHostedPageTarget();
  console.log(`[inject-e2e-flag] attaching to hosted WebView target: ${wsUrl}`);
  const cdp = connect(wsUrl);
  await cdp.ready;

  const origin = await waitForRealOrigin(cdp);
  console.log(`[inject-e2e-flag] document origin is ${origin}; writing the flag.`);

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
