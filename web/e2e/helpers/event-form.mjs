// Shared helper for the admin event create/edit form e2e specs (TM-1195).
//
// The form is regrouped into 5 collapsible <details> sections (Basics · When · Where · Who can join ·
// Booking rules). Basics/When/Where open by default; Who can join + Booking rules are COLLAPSED. A
// collapsed <details> keeps its body in the DOM but `display:none`, so Playwright's visibility-gated
// `fill()` / `selectOption()` / `toBeVisible()` would time out on a field inside a closed section
// (capacity, age band, visibility window → "Who can join"; RSVP cutoff, reveal hours, price → "Booking
// rules"). Rather than sprinkle per-section toggle clicks through every spec, expand ALL sections once
// after the form is visible so every field is interactable — the pre-TM-1195 single-column behaviour.
//
// Idempotent: it only opens a still-closed section, so calling it after a re-mount / edit-open is safe.

/**
 * Force every event-form collapsible section OPEN so all fields are visible + interactable.
 * @param {import("@playwright/test").Page} page
 */
export async function openAllEventFormSections(page) {
  // Set the native <details> `open` property directly (no per-toggle click races): reveals the body and
  // reflects to the attribute exactly as a user click would. Scoped to the event form's sections.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true;
  });
}
