package com.teammarhaba.backend.messaging;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;

/**
 * The <em>target spec</em> for an admin message (TM-440, epic TM-432): a transport-neutral,
 * immutable description of <em>who</em> a send should reach, before it is resolved into concrete
 * user ids by {@link RecipientResolver}.
 *
 * <p>An audience is expressed along three independent dimensions, each optional:
 *
 * <ul>
 *   <li><b>{@link #userIds()}</b> — explicit account ids (the "message this one user" case, or a
 *       hand-picked list);</li>
 *   <li><b>{@link #cities()}</b> — every account whose profile city matches (city-wide sends). The
 *       match is applied case-insensitively and on the trimmed value by the resolver's query, so
 *       {@code "London"} and {@code " london "} select the same people;</li>
 *   <li><b>{@link #eventIds()}</b> — the {@code GOING} attendees of one <em>or several</em> events
 *       (an event's guest list, or the union across a handful of events).</li>
 * </ul>
 *
 * <p>The spec only <em>describes</em> intent; it holds no user rows and does no filtering itself.
 * Resolving it is a {@linkplain RecipientResolver snapshot} taken at send time: the concrete
 * recipient set is whatever the DB says <em>now</em>, so someone who joins the city or event
 * <em>after</em> the send is never retro-added. The resolver also owns the guarantees this type
 * cannot (soft-deleted accounts excluded; the union de-duplicated), so the same intent produces the
 * same recipients regardless of which sender resolves it.
 *
 * <p>The wave-0 resolver deliberately supports a <em>combined</em> spec (any mix of the three
 * dimensions, de-duplicated) because that is the honest, reusable shape and it makes the union
 * unit-testable. The first consumer — the admin send endpoint (TM-441) — restricts a single send to
 * one target type at the API edge; that is a product policy for the endpoint, not a limitation of
 * this type or the resolver.
 *
 * <p><b>Normalisation.</b> The compact constructor makes every instance canonical and safe to share:
 * each collection is defensively copied into an insertion-ordered, <em>unmodifiable</em>
 * {@link Set} (so duplicates within a dimension collapse and order is stable for readable results);
 * a {@code null} collection becomes empty; {@code null} ids are dropped; and city strings are
 * trimmed with {@code null}/blank entries dropped (their original case is preserved — the
 * case-insensitive match happens in the query).
 *
 * @param userIds  explicit account ids to target (never {@code null} after construction)
 * @param cities   profile cities to target, trimmed and non-blank (never {@code null})
 * @param eventIds events whose {@code GOING} attendees to target (never {@code null})
 */
public record AudienceSpec(Set<Long> userIds, Set<String> cities, Set<Long> eventIds) {

    /** Canonicalise every dimension so an instance is immutable, null-safe and de-duplicated. */
    public AudienceSpec {
        userIds = normaliseIds(userIds);
        cities = normaliseCities(cities);
        eventIds = normaliseIds(eventIds);
    }

    /** Target a single account by id — the "message this one user" case. */
    public static AudienceSpec user(long userId) {
        return new AudienceSpec(Set.of(userId), Set.of(), Set.of());
    }

    /** Target an explicit set of accounts by id. */
    public static AudienceSpec users(Collection<Long> userIds) {
        return new AudienceSpec(toSet(userIds), Set.of(), Set.of());
    }

    /** Target every account whose profile city matches (case-insensitive, trimmed). */
    public static AudienceSpec city(String city) {
        return new AudienceSpec(Set.of(), city == null ? Set.of() : Set.of(city), Set.of());
    }

    /** Target every account in any of several cities (each matched case-insensitively, trimmed). */
    public static AudienceSpec cities(Collection<String> cities) {
        return new AudienceSpec(Set.of(), normaliseCities(cities), Set.of());
    }

    /** Target the {@code GOING} attendees of a single event. */
    public static AudienceSpec event(long eventId) {
        return new AudienceSpec(Set.of(), Set.of(), Set.of(eventId));
    }

    /** Target the {@code GOING} attendees of one or more events — the multi-event union. */
    public static AudienceSpec events(Collection<Long> eventIds) {
        return new AudienceSpec(Set.of(), Set.of(), toSet(eventIds));
    }

    /** {@code true} when no dimension targets anyone — resolving it yields an empty recipient set. */
    public boolean isEmpty() {
        return userIds.isEmpty() && cities.isEmpty() && eventIds.isEmpty();
    }

    /** Copy non-null ids into an insertion-ordered, unmodifiable set (drops {@code null} entries). */
    private static Set<Long> normaliseIds(Collection<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return Set.of();
        }
        Set<Long> copy = new LinkedHashSet<>(ids.size());
        for (Long id : ids) {
            if (id != null) {
                copy.add(id);
            }
        }
        return Collections.unmodifiableSet(copy);
    }

    /** Trim city strings, drop {@code null}/blank entries, and return an unmodifiable set. */
    private static Set<String> normaliseCities(Collection<String> cities) {
        if (cities == null || cities.isEmpty()) {
            return Set.of();
        }
        Set<String> copy = new LinkedHashSet<>(cities.size());
        for (String city : cities) {
            if (city != null && !city.isBlank()) {
                copy.add(city.trim());
            }
        }
        return Collections.unmodifiableSet(copy);
    }

    /** Null-tolerant {@link Collection} → normalised id {@link Set} bridge for the factory helpers. */
    private static Set<Long> toSet(Collection<Long> ids) {
        return normaliseIds(Objects.requireNonNullElse(ids, Set.of()));
    }
}
