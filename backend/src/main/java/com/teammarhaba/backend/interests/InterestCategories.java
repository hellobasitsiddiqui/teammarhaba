package com.teammarhaba.backend.interests;

import java.util.Set;

/**
 * The frozen set of known interest categories (TM-774) — the seven grouping buckets seeded by
 * {@code V45__create_interests}. An admin creating or editing an interest must pick one of these
 * exact strings so the picker's category grouping stays coherent.
 *
 * <p>The match is <b>case-sensitive and exact</b> against the seed spellings (e.g. {@code "Food &
 * Drink"}, not {@code "food & drink"}): the seed rows use these exact strings, so accepting a
 * differently-cased variant would fragment a category into two visually-identical buckets in the
 * picker. This is the single source of truth for the valid category set; the admin request DTOs
 * validate against it ({@code CreateInterestRequest}/{@code UpdateInterestRequest}) and it is kept
 * here in the {@code interests} package so the domain owns its own vocabulary.
 *
 * <p>Adding a category is a deliberate, reviewed change: add the string here (and seed rows for it
 * if desired) — there is intentionally no free-text category path, so the set can't drift silently.
 */
public final class InterestCategories {

    /** The seven seed categories (V45). Immutable; order is irrelevant (membership test only). */
    public static final Set<String> KNOWN = Set.of(
            "Outdoors & Nature",
            "Sport & Fitness",
            "Food & Drink",
            "Arts & Creative",
            "Games & Tech",
            "Music & Nightlife",
            "Social & Wellbeing");

    private InterestCategories() {}

    /** {@code true} if {@code category} is one of the known buckets (exact, case-sensitive match). */
    public static boolean isKnown(String category) {
        return category != null && KNOWN.contains(category);
    }
}
