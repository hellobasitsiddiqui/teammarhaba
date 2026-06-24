// Framework-free product-tour engine (TM-135) — coachmarks over the live UI.
//
// A "tour" is data: { id, steps: [{ target?, title, body, placement? }] }. Each step spotlights a
// target element (a CSS selector; omit for a centered intro/outro card) and shows a callout with
// Back / Next / Skip / Done. Tours are:
//   - per-user + per-tour persisted (localStorage, keyed by the signed-in uid) — seen-once,
//   - pausable/resumable (closing mid-tour saves the current step; re-running resumes there),
//   - replayable on demand (run with {force:true} from the Help menu).
//
// XSS-safe: all text is rendered via ui.js `el` (textContent only). Honors prefers-reduced-motion.
// This module is generic (no app specifics) — the app's tours + triggers live in tours.js.

import { clear, el } from "./ui.js";
import { currentUser } from "./auth.js";

const PERSIST_VERSION = 1; // bump to re-show all tours after a material content change

function stateKey(tourId) {
  const uid = currentUser()?.uid || "anon";
  return `tm.tour.v${PERSIST_VERSION}.${uid}.${tourId}`;
}

function readState(tourId) {
  try {
    return JSON.parse(localStorage.getItem(stateKey(tourId))) || {};
  } catch {
    return {};
  }
}

function writeState(tourId, patch) {
  try {
    localStorage.setItem(stateKey(tourId), JSON.stringify({ ...readState(tourId), ...patch }));
  } catch {
    /* storage unavailable (private mode) — tours just won't persist; non-fatal. */
  }
}

/** Has the user already completed (or skipped) this tour? */
export function isTourCompleted(tourId) {
  return Boolean(readState(tourId).done);
}

/** Forget a tour's state so it can auto-run again (used by tests / a "reset tours" action). */
export function resetTour(tourId) {
  try {
    localStorage.removeItem(stateKey(tourId));
  } catch {
    /* non-fatal */
  }
}

let active = null; // teardown fn for the running tour, or null — only one tour at a time.

/** Is a tour currently on screen? (so callers don't stack tours.) */
export function isTourActive() {
  return active != null;
}

const REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A target is usable only if it's actually rendered + visible (skips e.g. a hidden admin link). */
function visible(node) {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && node.offsetParent !== null;
}

/**
 * Run a tour.
 * @param {{id: string, steps: Array}} tour
 * @param {{force?: boolean}} [opts] force re-run even if completed, starting from step 0.
 * @returns {boolean} whether a tour actually started.
 */
export function runTour(tour, { force = false } = {}) {
  if (active || !tour || !Array.isArray(tour.steps)) return false;

  const state = readState(tour.id);
  if (!force && state.done) return false;

  // Only steps whose target is visible right now are runnable (targetless intro cards always qualify).
  const steps = tour.steps.filter((s) => !s.target || visible(document.querySelector(s.target)));
  if (steps.length === 0) return false;

  let index = force ? 0 : Math.min(Math.max(state.step || 0, 0), steps.length - 1);

  // --- overlay scaffold -------------------------------------------------------------------
  const blocker = el("div", { class: "tm-tour-blocker", onClick: () => pause() });
  const spotlight = el("div", { class: "tm-tour-spotlight", "aria-hidden": "true" });
  const callout = el("div", {
    class: "tm-tour-callout",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Product tour",
  });
  const layer = el("div", { class: `tm-tour ${REDUCED_MOTION ? "tm-tour-reduced" : ""}` }, [
    blocker,
    spotlight,
    callout,
  ]);
  document.body.append(layer);

  const onKey = (e) => {
    if (e.key === "Escape") pause();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") back();
  };
  const onReflow = () => position();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);

  function teardown() {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
    layer.remove();
    active = null;
  }
  active = teardown;

  function finish(done) {
    writeState(tour.id, done ? { done: true, step: 0 } : { step: index });
    teardown();
  }
  const pause = () => finish(false); // closing mid-tour resumes here next time
  const complete = () => finish(true); // finished or skipped → don't auto-show again

  function next() {
    if (index < steps.length - 1) {
      index++;
      render();
    } else {
      complete();
    }
  }
  function back() {
    if (index > 0) {
      index--;
      render();
    }
  }

  function render() {
    const step = steps[index];
    clear(callout).append(
      el("button", { class: "tm-tour-close", type: "button", "aria-label": "Close tour", onClick: pause }, "×"),
      step.title ? el("h2", { class: "tm-tour-title", text: step.title }) : null,
      el("p", { class: "tm-tour-body", text: step.body || "" }),
      el("div", { class: "tm-tour-foot" }, [
        el("span", { class: "tm-tour-progress", text: `${index + 1} of ${steps.length}` }),
        el("div", { class: "tm-tour-actions" }, [
          el("button", { class: "tm-tour-link", type: "button", onClick: complete }, "Skip"),
          el("button", { class: "tm-btn tm-btn-sm", type: "button", disabled: index === 0, onClick: back }, "Back"),
          el(
            "button",
            { class: "tm-btn tm-btn-sm tm-btn-primary", type: "button", onClick: next },
            index === steps.length - 1 ? "Done" : "Next",
          ),
        ]),
      ]),
    );
    position();
    // Move keyboard focus into the dialog for accessibility.
    callout.querySelector(".tm-btn-primary")?.focus();
  }

  function position() {
    const step = steps[index];
    const target = step.target ? document.querySelector(step.target) : null;
    layer.classList.toggle("tm-tour-dim", !target); // targetless cards dim the whole screen
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });
      const r = target.getBoundingClientRect();
      const pad = 6;
      spotlight.hidden = false;
      spotlight.style.top = `${r.top - pad}px`;
      spotlight.style.left = `${r.left - pad}px`;
      spotlight.style.width = `${r.width + pad * 2}px`;
      spotlight.style.height = `${r.height + pad * 2}px`;
      placeCallout(r);
    } else {
      // Targetless step → fully dim, centered card.
      spotlight.hidden = true;
      callout.classList.add("tm-tour-callout-center");
      callout.style.top = "";
      callout.style.left = "";
    }
  }

  function placeCallout(r) {
    callout.classList.remove("tm-tour-callout-center");
    const margin = 12;
    const cw = callout.offsetWidth || 320;
    const ch = callout.offsetHeight || 160;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Horizontal: centre on the target, then clamp inside the viewport (the callout width is already
    // capped to `100vw - 2rem` in CSS, so this always fits on a phone).
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - cw - margin));

    // Vertical: prefer below the target, flip above if there isn't room below.
    const roomBelow = vh - r.bottom - margin;
    const roomAbove = r.top - margin;
    let top;
    if (roomBelow >= ch) {
      top = r.bottom + margin;
    } else if (roomAbove >= ch) {
      top = r.top - ch - margin;
    } else {
      // TM-229: small/short screens — the target is tall relative to the viewport and the callout
      // fits neither fully below nor fully above without overlapping the spotlight. Dock it to the
      // side (below vs above) that has MORE room and clamp it into the viewport, so the callout is
      // always fully visible and never pushed off-screen. The spotlight may be partially behind it,
      // but the callout text + actions stay reachable — the previous logic could shove it off the
      // bottom edge on a phone, hiding the Next/Done buttons.
      top = roomBelow >= roomAbove ? r.bottom + margin : Math.max(margin, r.top - ch - margin);
    }
    // Final clamp: never let the callout extend past either viewport edge.
    top = Math.min(Math.max(margin, top), Math.max(margin, vh - ch - margin));
    callout.style.top = `${top}px`;
    callout.style.left = `${left}px`;
  }

  render();
  return true;
}
