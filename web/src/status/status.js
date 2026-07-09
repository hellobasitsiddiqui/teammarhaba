// Public status page — the browser half (TM-182).
//
// Loaded as an ES module by web/src/status/index.html (a STANDALONE page served at /status, before the
// SPA rewrite). It owns all the DOM/fetch/timer work; every DECISION it makes is delegated to the
// unit-tested, dependency-free status-core.js so the behaviour is guarded by `node --test` without a
// browser. This file is intentionally NOT under /assets, so the deploy's asset fingerprinter leaves it
// (and its `./status-core.js` import specifier) untouched — the page is served exactly as committed.
//
// WHAT IT DOES, each cycle:
//   1. Probe the backend `/health` (public, permitAll) — measure round-trip latency + whether it's a
//      healthy 200. This is BOTH the banner's "is the API up?" signal AND one availability/latency
//      SAMPLE for the charts.
//   2. Probe the web/Hosting origin for reachability (the banner's second, independent signal).
//   3. Feed both signals to classifyOverall() → paint the Available / degraded / outage banner.
//   4. Append the API sample to a rolling 24h buffer (persisted in localStorage so the Day chart keeps
//      real history across reloads/visits), roll it up into 15-minute buckets, and repaint the latency
//      + availability charts with the core's green/amber "deviation" colouring.
//
// GRACEFUL DEGRADATION (AC4): if the backend is unreachable the fetch simply fails → the sample is
// recorded as a failure, the banner shows degraded/outage from `/health`, and the charts show whatever
// real samples we do have (or a clean "collecting data" empty state). Nothing here throws to the user.
//
// NO LEAKAGE (AC5): the page only ever renders status words, latency in ms and success percentages. It
// never prints the backend URL, tokens, project ids or any infra detail. The API base it calls is the
// same PUBLIC endpoint the web app already uses.

import {
  Overall,
  Level,
  classifyOverall,
  rollup,
  latencyBaseline,
  latencyLevel,
  availabilityLevel,
  DAY_BUCKETS,
  BUCKET_MS,
} from "./status-core.js";

const CFG = window.TM_STATUS_CONFIG || {};
const API_BASE = (CFG.apiBaseUrl || "").replace(/\/+$/, ""); // trim trailing slash

const PROBE_INTERVAL_MS = 30_000; // re-probe every 30s (a status page doesn't need to hammer /health)
const PROBE_TIMEOUT_MS = 8_000; // give a slow/hung backend up to 8s before calling the probe failed
const STORE_KEY = "tm.status.samples.v1"; // rolling sample buffer (localStorage)
const DAY_MS = DAY_BUCKETS * BUCKET_MS; // 24h — how far back we keep samples

/** @type {{ts:number, latencyMs:?number, ok:boolean}[]} — the rolling 24h sample buffer. */
let samples = loadSamples();
/** Most recent web-reachability result, kept out of the API sample buffer (it's a banner-only signal). */
let lastWebReachable = null;

const $ = (id) => document.getElementById(id);

// ── persistence ────────────────────────────────────────────────────────────────────────────────
// Keep real measured history across reloads so the Day chart isn't empty every visit. Best-effort:
// any storage error (private mode, quota) just falls back to an in-memory buffer — never fatal.

function loadSamples() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const cutoff = Date.now() - DAY_MS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.ts === "number" && s.ts >= cutoff);
  } catch {
    return [];
  }
}

function saveSamples() {
  try {
    const cutoff = Date.now() - DAY_MS;
    samples = samples.filter((s) => s.ts >= cutoff);
    localStorage.setItem(STORE_KEY, JSON.stringify(samples));
  } catch {
    /* storage unavailable — keep going with the in-memory buffer */
  }
}

// ── probes ─────────────────────────────────────────────────────────────────────────────────────

/** fetch() with an AbortController timeout, so a hung backend can't stall the probe forever. */
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the backend `/health` once. Returns a SAMPLE: how long it took, and whether it was a healthy
 * (non-5xx) response. A network error / timeout / CORS block resolves to a failure sample (ok:false,
 * latencyMs:null) — conservative, so a genuinely unreachable API reads as down, not silently ignored.
 * A simple GET with only the safelisted `Accept` header → no CORS preflight.
 */
async function probeBackend() {
  const started = performance.now();
  try {
    const res = await fetchWithTimeout(`${API_BASE}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - started);
    // Non-5xx = success (mirrors the reference page's "non-5xx success rate"). A 4xx is still "the API
    // answered", so it counts as up for availability; only a 5xx or a failed request is a failure.
    const ok = res.status < 500;
    return { ts: Date.now(), latencyMs, ok };
  } catch {
    return { ts: Date.now(), latencyMs: null, ok: false };
  }
}

/**
 * Probe web/Hosting reachability — the banner's second, independent signal. Any HTTP response from the
 * site origin (even a 404) proves the CDN/site is reachable; only a rejected fetch (DNS/network) means
 * "web unreachable". Kept separate from the API sample buffer.
 */
async function probeWeb() {
  try {
    await fetchWithTimeout(`${window.location.origin}/?_status=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

// ── render: banner ───────────────────────────────────────────────────────────────────────────────

function renderBanner(level, title, detail) {
  const banner = $("overall-banner");
  if (!banner) return;
  // One class drives the colour band (see the page's own CSS): checking / available / degraded / outage.
  banner.className = `status-banner level-${level}`;
  banner.setAttribute("data-level", level);
  // Screen readers should hear a status change, but not be spammed on every identical re-probe.
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", level === Overall.OUTAGE ? "assertive" : "polite");
  const titleEl = $("overall-title");
  const detailEl = $("overall-detail");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
}

// ── render: charts ────────────────────────────────────────────────────────────────────────────────

/** Human time label for a bucket start, e.g. "12:15" — used in each bar's hover tooltip. */
function hhmm(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Render one bar row (latency OR availability) into `containerId`.
 *  - `heightFor(bucket)` → 0..1 bar height fraction.
 *  - `levelFor(bucket)`  → a status-core Level (green/amber/nodata) → the bar's colour class.
 *  - `tooltipFor(bucket)`→ the hover title text.
 * Empty windows render as a faint baseline tick so the fixed 96-slot axis reads as "no data here yet"
 * rather than a gap.
 */
function renderBars(containerId, buckets, heightFor, levelFor, tooltipFor) {
  const el = $(containerId);
  if (!el) return;
  el.replaceChildren(); // clear previous render
  for (const b of buckets) {
    const bar = document.createElement("div");
    const level = levelFor(b);
    bar.className = `bar bar-${level}`;
    const frac = b.hasData ? Math.max(0.06, Math.min(1, heightFor(b))) : 0;
    bar.style.height = `${(frac * 100).toFixed(1)}%`;
    bar.title = tooltipFor(b);
    el.appendChild(bar);
  }
}

function renderCharts() {
  const now = Date.now();
  const buckets = rollup(samples, { nowMs: now });
  const baseline = latencyBaseline(buckets);

  // Latency chart: taller = slower. Scale against the slowest window (with a sane floor so a healthy,
  // uniformly-fast day still shows visible bars rather than slivers).
  const maxLatency = Math.max(200, ...buckets.map((b) => b.avgLatencyMs || 0));
  renderBars(
    "latency-bars",
    buckets,
    (b) => (b.avgLatencyMs || 0) / maxLatency,
    (b) => latencyLevel(b.avgLatencyMs, baseline),
    (b) =>
      b.hasData
        ? `${hhmm(b.start)} · ${Math.round(b.avgLatencyMs ?? 0)} ms avg · ${b.count} probe${b.count === 1 ? "" : "s"}`
        : `${hhmm(b.start)} · no data`,
  );

  // Availability chart: full height = 100% success; a dip is a visibly shorter bar.
  renderBars(
    "availability-bars",
    buckets,
    (b) => b.successRatio ?? 0,
    (b) => availabilityLevel(b.successRatio),
    (b) =>
      b.hasData
        ? `${hhmm(b.start)} · ${(100 * (b.successRatio ?? 0)).toFixed(1)}% ok · ${b.count} probe${b.count === 1 ? "" : "s"}`
        : `${hhmm(b.start)} · no data`,
  );

  // "Collecting data" hint while there's not yet a single measured window (first-ever visit).
  const anyData = buckets.some((b) => b.hasData);
  const emptyHint = $("charts-empty");
  if (emptyHint) emptyHint.hidden = anyData;
}

// ── loop ───────────────────────────────────────────────────────────────────────────────────────

async function tick() {
  const [sample, webReachable] = await Promise.all([probeBackend(), probeWeb()]);
  lastWebReachable = webReachable;

  samples.push(sample);
  saveSamples();

  const { level, title, detail } = classifyOverall({ backendUp: sample.ok, webReachable });
  renderBanner(level, title, detail);
  renderCharts();

  // Reflect the last-checked time so the page visibly proves it's live, not a frozen snapshot.
  const stamp = $("last-checked");
  if (stamp) stamp.textContent = `Last checked ${hhmm(Date.now())}`;
}

function start() {
  // Paint the neutral "checking" banner + any persisted history immediately, then probe.
  const initial = classifyOverall({ backendUp: null, webReachable: null });
  renderBanner(initial.level, initial.title, initial.detail);
  renderCharts();
  tick();
  setInterval(tick, PROBE_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
