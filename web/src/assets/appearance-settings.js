// Appearance settings control (TM-529) — the two per-user Paper controls on the #/profile page:
//   1. Colour   — a FIXED curated palette of accent swatches; picking one re-tints the whole Paper
//                 theme live (re-points --accent/--on-accent) and persists it server-side.
//   2. Wavy/sketchy toggle — on = the hand-drawn wobble style, off = clean Paper; persists too.
//
// This replaces the retired clean/doodle/sketch theme picker (theme-settings.js). Both controls
// PERSIST SERVER-SIDE per user via PATCH /api/v1/me (themeAccent / themeSketchy) — not just
// localStorage — so the choice survives reload and follows the user across devices (AC2/AC3). The
// boot script (appearance.js) + appearance-sync.js handle the load-time apply; this control owns the
// live change + the write-back, and refreshes the localStorage boot hint so the next cold start is
// flash-free.
//
// It reflects the CURRENTLY APPLIED state (read off <html> — set by appearance-sync from the server
// before the profile renders), so the selected swatch + toggle match what the user has stored.
//
// XSS-safe by construction: every node is built with the ui.js `el()` kit (textContent only, no
// innerHTML), and only ever writes an ALLOWED swatch id / a boolean — never free text — to the DOM,
// storage, or the API.

import { el, toast } from "./ui.js";
import { updateMe, ApiError } from "./api.js";
import {
  PAPER_PALETTE,
  DEFAULT_ACCENT_ID,
  DEFAULT_SKETCHY,
  isValidAccentId,
  accentIdFromHex,
  applyAppearance,
  writeHint,
  createAppearancePersister,
} from "./appearance-core.js";

function safeStorage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The currently applied wavy/sketchy state, read off <html data-sketchy> (default ON). */
function currentSketchy() {
  return document.documentElement.getAttribute("data-sketchy") !== "off";
}

/** The currently applied accent swatch id, read off the inline --accent (default swatch otherwise). */
function currentAccentId() {
  const inline = document.documentElement.style.getPropertyValue("--accent");
  return accentIdFromHex(inline) || DEFAULT_ACCENT_ID;
}

/**
 * Build the Appearance settings section. Returns the section node. Self-contained: it reads the
 * applied state, renders the palette + toggle, and on any change applies live, persists server-side,
 * and refreshes the boot hint.
 */
export function buildAppearanceSettings() {
  // Live working state, seeded from what's currently applied to the page.
  const state = { accentId: currentAccentId(), sketchy: currentSketchy() };

  // ── Colour: one swatch button per palette entry ──────────────────────────────────────────────
  const swatchButtons = new Map(); // id -> button, so we can move the aria-pressed selection
  const swatches = el("div", { class: "tm-swatches", role: "group", "aria-label": "Accent colour" });
  for (const swatch of PAPER_PALETTE) {
    const btn = el("button", {
      type: "button",
      class: "tm-swatch",
      "data-accent": swatch.id,
      // The swatch fill is a CSS var set inline so the button carries no free-text colour into CSS.
      style: `--tm-swatch: ${swatch.hex}`,
      "aria-label": swatch.label,
      "aria-pressed": String(swatch.id === state.accentId),
      title: swatch.label,
    });
    btn.addEventListener("click", () => selectAccent(swatch.id));
    swatchButtons.set(swatch.id, btn);
    swatches.append(btn);
  }

  const colourField = el("div", { class: "tm-form-field" }, [
    el("label", { class: "tm-field-label", text: "Colour" }),
    swatches,
    el("p", {
      class: "tm-muted tm-field-hint",
      text: "Pick an accent. Saved to your account and used across your devices.",
    }),
  ]);

  // ── Wavy/sketchy toggle ──────────────────────────────────────────────────────────────────────
  const toggleId = "appearance-sketchy";
  const toggle = el("input", {
    id: toggleId,
    type: "checkbox",
    class: "tm-switch-input",
    "aria-describedby": `${toggleId}-hint`,
  });
  toggle.checked = state.sketchy;
  toggle.addEventListener("change", () => setSketchy(toggle.checked));

  const toggleField = el("div", { class: "tm-form-field tm-appearance-toggle" }, [
    // Reuses the shared .tm-switch component (a visually-hidden checkbox driving a pill track + thumb).
    el("label", { class: "tm-switch", for: toggleId }, [
      toggle,
      el("span", { class: "tm-switch-track", "aria-hidden": "true" }, [
        el("span", { class: "tm-switch-thumb" }),
      ]),
      el("span", { class: "tm-switch-text", text: "Wavy / sketchy style" }),
    ]),
    el("p", {
      id: `${toggleId}-hint`,
      class: "tm-muted tm-field-hint",
      text: "On = the hand-drawn wobble look. Off = clean Paper.",
    }),
  ]);

  const section = el(
    "section",
    { class: "tm-theme-settings tm-appearance", id: "appearance-settings", "aria-label": "Appearance" },
    [el("h3", { text: "Appearance" }), colourField, toggleField],
  );

  // ── behaviour ────────────────────────────────────────────────────────────────────────────────

  function reflectAccent() {
    for (const [id, btn] of swatchButtons) {
      btn.setAttribute("aria-pressed", String(id === state.accentId));
    }
  }

  /** Apply the working state to the page + refresh the no-flash boot hint. */
  function applyLive() {
    applyAppearance(document, state);
    const storage = safeStorage();
    if (storage) writeHint(storage, state);
  }

  /**
   * Restore the working state + UI to `previous` (used by the persister when a save fails and this is
   * still the latest change — see createAppearancePersister). Kept separate so the sequencer decides
   * WHETHER to revert; this only knows HOW.
   */
  function revertTo(previous) {
    state.accentId = previous.accentId;
    state.sketchy = previous.sketchy;
    applyLive();
    reflectAccent();
    toggle.checked = state.sketchy;
  }

  // Sequenced persistence (TM-720): the user can flip accent/toggle faster than a PATCH round-trips,
  // so two writes can be in flight at once and resolve out of order. The persister guards against a
  // stale FAILED request reverting a newer successful change — only the latest change may revert on
  // failure — so the UI always settles on the last thing the user picked (last-write-wins by request
  // order), never on a half-applied mix of server and UI state.
  const persister = createAppearancePersister({
    patch: updateMe,
    revert: revertTo,
    onError: (err, superseded) => {
      // A superseded (stale) failure is swallowed — a newer change owns the UI; don't nag/undo it.
      if (superseded) return;
      const msg = err instanceof ApiError ? err.message : "Couldn't save your appearance. Try again.";
      toast(msg, { type: "error" });
    },
  });

  /** Persist a single changed field server-side, sequenced so out-of-order responses can't disagree. */
  function persist(patch, previous) {
    persister.run(patch, previous);
  }

  function selectAccent(id) {
    if (!isValidAccentId(id) || id === state.accentId) return;
    const previous = { ...state };
    state.accentId = id;
    applyLive();
    reflectAccent();
    persist({ themeAccent: id }, previous);
  }

  function setSketchy(on) {
    const next = Boolean(on);
    if (next === state.sketchy) return;
    const previous = { ...state };
    state.sketchy = next;
    applyLive();
    persist({ themeSketchy: next }, previous);
  }

  return section;
}

// Re-exported so callers/tests can reference the defaults without re-importing the core module.
export { DEFAULT_ACCENT_ID, DEFAULT_SKETCHY };
