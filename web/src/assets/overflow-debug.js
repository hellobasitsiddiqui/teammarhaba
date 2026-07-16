// TM-665 — TEMPORARY on-device horizontal-overflow highlighter. Diagnoses the "Profile content cut off
// on the right (Android)" clip that the emulator/Playwright doesn't reproduce, by finding — on the real
// device — every element whose right edge pokes past the visible viewport, outlining it, and listing the
// worst offenders in a fixed banner you can screenshot.
//
// INERT by default. Activate by loading the app with `?debug=overflow` in the URL (the flag persists in
// localStorage across the SPA's in-app hash navigation, so you can then tap through to Profile);
// deactivate with `?debug=off`. REMOVE this module + its <script> tag once TM-665 is diagnosed.
const KEY = "tm_debug_overflow";
const THRESHOLD = 0.5; // px of slack, so sub-pixel rounding isn't flagged

function isActive() {
  try {
    const q = new URLSearchParams(location.search).get("debug");
    if (q === "off") { localStorage.removeItem(KEY); return false; }
    if (q === "overflow" || (location.hash || "").includes("debug=overflow")) {
      localStorage.setItem(KEY, "1");
      return true;
    }
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** A short, human identifier for an element (tag + id + first classes). */
function label(el) {
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
  return (el.tagName.toLowerCase() + id + cls).slice(0, 60);
}

/** Every visible element whose right edge exceeds the viewport width, worst overflow first. */
function offenders() {
  const w = window.innerWidth;
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.id === "tm-overflow-debug") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > w + THRESHOLD) out.push({ el, over: Math.round(r.right - w), right: Math.round(r.right) });
  }
  out.sort((a, b) => b.over - a.over);
  return out;
}

let banner = null;
function ensureBanner() {
  if (banner && banner.isConnected) return banner;
  banner = document.createElement("div");
  banner.id = "tm-overflow-debug";
  banner.setAttribute(
    "style",
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;max-height:45vh;overflow:auto;" +
      "background:#7a0012;color:#fff;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;" +
      "padding:8px 10px;box-shadow:0 2px 10px rgba(0,0,0,.45);white-space:pre-wrap;box-sizing:border-box;",
  );
  document.body.appendChild(banner);
  return banner;
}

function clearOutlines() {
  document.querySelectorAll("[data-tm-of]").forEach((e) => {
    e.style.outline = "";
    e.removeAttribute("data-tm-of");
  });
}

function scan() {
  if (!document.body) return;
  if (!isActive()) {
    clearOutlines();
    if (banner) { banner.remove(); banner = null; }
    return;
  }
  clearOutlines();
  const list = offenders();
  const b = ensureBanner();
  if (!list.length) {
    b.textContent = `TM-665 overflow debug · innerWidth ${window.innerWidth}px · ✓ nothing overflows the right edge on this screen`;
    return;
  }
  list.slice(0, 15).forEach(({ el }) => {
    el.style.outline = "2px solid #ff2d55";
    el.setAttribute("data-tm-of", "1");
  });
  const lines = list.slice(0, 15).map((o) => `+${o.over}px  ${label(o.el)}  (right ${o.right} > ${window.innerWidth})`);
  b.textContent =
    `TM-665 overflow debug · innerWidth ${window.innerWidth}px · ${list.length} element(s) past the right edge:\n` +
    lines.join("\n");
}

function start() {
  scan();
  window.addEventListener("resize", scan, { passive: true });
  window.addEventListener("hashchange", () => setTimeout(scan, 200));
  // The SPA re-renders on route/data changes; re-scan on a light interval so async content is measured.
  setInterval(scan, 900);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
