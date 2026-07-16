package com.teammarhaba.backend.interests;

/**
 * Domain-side command for a partial edit of an interest (TM-774) — the {@code interests} package's
 * own value object (mirrors {@code VenuePatch}). Built by {@code UpdateInterestRequest.toPatch()}.
 * House PATCH convention: a {@code null} field is left unchanged.
 *
 * <p>{@code highlighted} is a nullable {@link Boolean} (not a primitive) precisely so "field not
 * sent" is distinguishable from "set to false" — a primitive would silently un-highlight an interest
 * on any partial edit that omits the flag.
 *
 * @param label       new label, or {@code null} to leave unchanged
 * @param category    new category (a known bucket), or {@code null} to leave unchanged
 * @param highlighted new highlight flag, or {@code null} to leave unchanged
 * @param sortWeight  new sort weight, or {@code null} to leave unchanged
 */
public record InterestPatch(String label, String category, Boolean highlighted, Integer sortWeight) {

    /** {@code true} when the patch carries no field at all — a no-op edit (no touch, no audit). */
    public boolean isEmpty() {
        return label == null && category == null && highlighted == null && sortWeight == null;
    }
}
