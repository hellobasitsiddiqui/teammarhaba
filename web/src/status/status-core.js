// Public status page — the pure, browser-free core (TM-182).
//
// Split out of status.js for the same reason verify-banner-state.js / home-core.js were split from
// their mounting modules: this is the unit-testable half. Given the raw health-probe results and a
// list of latency/availability SAMPLES, it decides the overall banner state and buckets the samples
// into the 15-minute windows the charts draw — with ZERO DOM, fetch or timer dependencies, so
// `node --test web/tools/*.test.mjs` (the PR gate) can guard the behaviour without a browser.
//
// Everything the page actually SHOWS is derived here so it can be asserted:
//   • the overall Available / degraded / outage banner (from the two independent health signals);
//   • the per-bucket latency + availability rollup (mean latency + non-5xx success ratio per window);
//   • the green/amber colour decision for each bar (a DEVIATION from the observed baseline — the same
//     "a single amber bar is a deviation within a 15-minute window, not necessarily an SLO violation"
//     caveat the reference Firebase status page uses).
//
// DESIGN NOTE — why the charts are driven by client-measured samples. The reference layout sources its
// history from Cloud Monitoring (TM-75). A public page can't query Cloud Monitoring without a read
// path + IAM that isn't wired yet (raised as a human HITL follow-up, see the PR). So the shipped first
// cut measures REAL latency + availability from the page's own periodic `/health` probes and buckets
// them here — honest, needs no server credentials, and degrades cleanly. When the Cloud Monitoring
// read path lands, the same rollup/colour logic renders that richer history unchanged; only the sample
// source swaps. Nothing here assumes where a sample came from.

/**
 * The overall banner states, worst → best is OUTAGE > DEGRADED > AVAILABLE. CHECKING is the
 * pre-first-probe state (we haven't heard back from either signal yet), so the banner never flashes
 * a scary red before the first result settles.
 * @readonly @enum {string}
 */
export const Overall = Object.freeze({
  CHECKING: "checking",
  AVAILABLE: "available",
  DEGRADED: "degraded",
  OUTAGE: "outage",
});

/**
 * Classify the overall status from the two INDEPENDENT health signals:
 *   • `backendUp`     — did the backend `/health` probe return a healthy 200? (the API is the service)
 *   • `webReachable`  — is the web/Hosting origin reachable? (the site/CDN)
 *
 * Rule (a simple, symmetric "worst of two independent signals"):
 *   both up            → AVAILABLE (green)
 *   exactly one down   → DEGRADED  (amber) — one half is impaired, the other still serves
 *   both down          → OUTAGE    (red)
 *   either not yet known (null/undefined) → CHECKING — don't judge before the first probe settles.
 *
 * Returns rich, ready-to-render copy (title + detail) so the exact words are unit-testable and the
 * DOM layer stays a dumb renderer. The detail line names WHICH half is impaired in the degraded case.
 *
 * @param {{backendUp?: ?boolean, webReachable?: ?boolean}} signals
 * @returns {{level: string, title: string, detail: string}}
 */
export function classifyOverall(signals) {
  const backendUp = signals ? signals.backendUp : undefined;
  const webReachable = signals ? signals.webReachable : undefined;

  // Haven't heard back from a signal yet → hold on the neutral "checking" state.
  if (backendUp === null || backendUp === undefined || webReachable === null || webReachable === undefined) {
    return {
      level: Overall.CHECKING,
      title: "Checking status…",
      detail: "Contacting the TeamMarhaba API…",
    };
  }

  if (backendUp && webReachable) {
    return {
      level: Overall.AVAILABLE,
      title: "All systems operational",
      detail: "The TeamMarhaba API and website are responding normally.",
    };
  }
  if (!backendUp && !webReachable) {
    return {
      level: Overall.OUTAGE,
      title: "Major outage",
      detail: "We can’t reach the TeamMarhaba API or website right now.",
    };
  }
  // Exactly one side is down → degraded; say which so the page is genuinely informative.
  const detail = !backendUp
    ? "The API isn’t responding. The website is up, but sign-in and live data may be affected."
    : "The website looks unreachable from here. The API is responding normally.";
  return { level: Overall.DEGRADED, title: "Partial outage", detail };
}

/** One chart bucket = a 15-minute window (matching the reference page's "one bar per 15-minute window"). */
export const BUCKET_MS = 15 * 60 * 1000;

/** How many 15-minute buckets make up the Day view (96 × 15 min = 24 h). */
export const DAY_BUCKETS = 96;

/**
 * Floor a timestamp to the start of its 15-minute bucket, so every sample in the same window shares a
 * bucket key. Pure integer maths — no Date/timezone dependence (buckets are UTC-epoch aligned).
 * @param {number} tsMs epoch millis
 * @param {number} [bucketMs=BUCKET_MS]
 * @returns {number} the bucket-start epoch millis
 */
export function bucketStart(tsMs, bucketMs = BUCKET_MS) {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * The ascending list of bucket-start timestamps for the Day view ending with the bucket `nowMs` falls
 * in — i.e. the last `count` windows. The charts render one bar per entry (older → newer), so empty
 * windows still get a slot (rendered as "no data") and the axis is a fixed width regardless of how
 * many samples we have.
 * @param {number} nowMs
 * @param {number} [bucketMs=BUCKET_MS]
 * @param {number} [count=DAY_BUCKETS]
 * @returns {number[]}
 */
export function dayBucketStarts(nowMs, bucketMs = BUCKET_MS, count = DAY_BUCKETS) {
  const current = bucketStart(nowMs, bucketMs);
  const starts = [];
  for (let i = count - 1; i >= 0; i--) starts.push(current - i * bucketMs);
  return starts;
}

/**
 * A single measured probe.
 * @typedef {{ts: number, latencyMs: ?number, ok: boolean}} Sample
 *   ts        — when the probe was taken (epoch millis).
 *   latencyMs — round-trip time in ms for a response we actually got, or null if the request failed
 *               outright (timeout / network error) so there's no latency to average.
 *   ok        — true when the response counts as a success (a non-5xx, non-failed response); this is
 *               the availability signal (mirrors the reference page's "non-5xx success rate").
 */

/**
 * Group `samples` into the fixed Day-view buckets and aggregate each window:
 *   • `avgLatencyMs`  — mean of the latencies we could measure (successful responses); null if none.
 *   • `successRatio`  — ok ÷ total for the window (the availability rate); null for an empty window.
 *   • `hasData`       — did any sample land in this window? (empty windows render as "no data").
 *
 * Samples outside the Day window are simply dropped (their bucket-start isn't in the axis).
 *
 * @param {Sample[]} samples
 * @param {{nowMs: number, bucketMs?: number, count?: number}} opts
 * @returns {{start: number, count: number, avgLatencyMs: ?number, successRatio: ?number, hasData: boolean}[]}
 */
export function rollup(samples, opts) {
  const bucketMs = opts.bucketMs ?? BUCKET_MS;
  const count = opts.count ?? DAY_BUCKETS;
  const starts = dayBucketStarts(opts.nowMs, bucketMs, count);
  const first = starts[0];
  const last = starts[starts.length - 1];

  // Accumulate per bucket-start: total requests, ok requests, and the sum/count of measurable latencies.
  const acc = new Map(starts.map((s) => [s, { total: 0, ok: 0, latSum: 0, latN: 0 }]));
  for (const s of samples || []) {
    if (typeof s.ts !== "number") continue;
    const key = bucketStart(s.ts, bucketMs);
    if (key < first || key > last) continue; // outside the Day window
    const b = acc.get(key);
    if (!b) continue;
    b.total += 1;
    if (s.ok) b.ok += 1;
    if (typeof s.latencyMs === "number" && Number.isFinite(s.latencyMs)) {
      b.latSum += s.latencyMs;
      b.latN += 1;
    }
  }

  return starts.map((start) => {
    const b = acc.get(start);
    const hasData = b.total > 0;
    return {
      start,
      count: b.total,
      avgLatencyMs: b.latN > 0 ? b.latSum / b.latN : null,
      successRatio: hasData ? b.ok / b.total : null,
      hasData,
    };
  });
}

/**
 * The observed latency baseline the amber "deviation" bars are judged against: the MEDIAN of the
 * non-empty buckets' average latencies. Median (not mean) so a single slow spike doesn't drag the
 * baseline up and mask later deviations. Null when there's nothing to measure yet.
 * @param {{avgLatencyMs: ?number}[]} buckets
 * @returns {?number}
 */
export function latencyBaseline(buckets) {
  const vals = (buckets || [])
    .map((b) => b.avgLatencyMs)
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/**
 * The per-bar colour states. `NODATA` is an empty window (no bar / faint tick), so the two coloured
 * states stay meaningful.
 * @readonly @enum {string}
 */
export const Level = Object.freeze({
  NORMAL: "normal", // green
  DEVIATION: "deviation", // amber
  NODATA: "nodata", // no samples in this window
});

/**
 * Colour a latency bar: green when it's within the normal band, amber when it DEVIATES from the
 * baseline by more than `warnFactor` (default 1.5×). Deliberately RELATIVE to the observed baseline —
 * an amber bar flags "this window ran notably slower than usual", NOT an SLO breach (same caveat as
 * the reference page). Until we have a baseline (first samples), everything measurable reads normal.
 * @param {?number} avgLatencyMs the window's mean latency (null = no data)
 * @param {?number} baselineMs the observed baseline (null = not enough data yet)
 * @param {{warnFactor?: number}} [opts]
 * @returns {string} a {@link Level}
 */
export function latencyLevel(avgLatencyMs, baselineMs, opts = {}) {
  if (avgLatencyMs === null || avgLatencyMs === undefined || !Number.isFinite(avgLatencyMs)) return Level.NODATA;
  if (baselineMs === null || baselineMs === undefined || !(baselineMs > 0)) return Level.NORMAL;
  const warnFactor = opts.warnFactor ?? 1.5;
  return avgLatencyMs > baselineMs * warnFactor ? Level.DEVIATION : Level.NORMAL;
}

/**
 * Colour an availability bar: green at/above the success-rate threshold (default 99.5% non-5xx),
 * amber below it. An empty window has no rate → NODATA.
 * @param {?number} successRatio 0..1 (null = no data)
 * @param {{warnBelow?: number}} [opts]
 * @returns {string} a {@link Level}
 */
export function availabilityLevel(successRatio, opts = {}) {
  if (successRatio === null || successRatio === undefined || !Number.isFinite(successRatio)) return Level.NODATA;
  const warnBelow = opts.warnBelow ?? 0.995;
  return successRatio >= warnBelow ? Level.NORMAL : Level.DEVIATION;
}
