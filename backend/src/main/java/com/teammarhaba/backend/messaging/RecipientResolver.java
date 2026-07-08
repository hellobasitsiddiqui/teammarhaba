package com.teammarhaba.backend.messaging;

import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.Collections;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Resolves an {@link AudienceSpec} into the concrete, distinct set of active account ids an admin
 * message should reach (TM-440, epic TM-432). This is the single, transport-neutral "who receives
 * this" rule that every downstream sender (first: the TM-441 admin send endpoint) reuses, so the
 * guarantees below are enforced exactly once, here.
 *
 * <p><strong>Snapshot at resolve time.</strong> The result is a materialised set computed from the
 * database as it is <em>now</em> — not a live query kept in the spec. Whoever joins the city or the
 * event <em>after</em> the send has been resolved is therefore never auto-added: the sender persists
 * this concrete set as the campaign's membership. The whole resolve runs in one read-only
 * transaction so the several reads (cities, explicit ids, attendees) see one consistent snapshot.
 *
 * <p><strong>Active accounts only.</strong> Every id in the result maps to an <em>active</em>
 * account. Two paths reach this differently, but the effect is uniform:
 *
 * <ul>
 *   <li><b>Cities</b> are resolved <em>through</em> {@link UserRepository}, whose entity
 *       {@code @SQLRestriction("deleted_at is null")} already drops soft-deleted rows — so
 *       {@link UserRepository#findActiveIdsByCity} can only return active ids.</li>
 *   <li><b>Explicit user ids</b> and <b>GOING attendees</b> are treated as <em>candidates</em>: an
 *       explicit id may be stale, and an attendance row deliberately survives its attendee's account
 *       soft-delete (see {@code EventAttendance}'s note — people are resolved through the {@code User}
 *       aggregate, never through the attendance table). Both are validated in one pass through
 *       {@link UserRepository#findActiveIdsByIdIn}, which returns only the ids that still map to an
 *       active account. A soft-deleted or unknown id is silently dropped, never delivered to.</li>
 * </ul>
 *
 * <p><strong>Distinct union.</strong> The three dimensions are unioned and de-duplicated across the
 * whole spec — a user picked by id, by their city, and as an attendee of two different events appears
 * exactly once. A {@link TreeSet} gives both the distinctness and a deterministic ascending order, so
 * a resolved audience is stable and reviewable (and its unit tests need no ordering fudge). An empty
 * or {@linkplain AudienceSpec#isEmpty() no-op} spec resolves to an empty set; the empty-recipient
 * guard (a send to nobody is a {@code 400}) belongs to the sender, not this pure resolver.
 */
@Service
public class RecipientResolver {

    private final UserRepository users;
    private final EventAttendanceRepository attendance;

    public RecipientResolver(UserRepository users, EventAttendanceRepository attendance) {
        this.users = users;
        this.attendance = attendance;
    }

    /**
     * Resolve {@code spec} to the distinct set of active account ids to deliver to, as a snapshot of
     * the database at call time.
     *
     * @param spec the audience to resolve (must not be {@code null}; may be empty)
     * @return an unmodifiable, ascending, duplicate-free set of active {@code users.id} values —
     *     empty when the spec targets no one or resolves only to soft-deleted/unknown accounts
     */
    @Transactional(readOnly = true)
    public Set<Long> resolve(AudienceSpec spec) {
        Objects.requireNonNull(spec, "spec");

        // TreeSet: de-duplicates the union AND fixes a deterministic ascending order, so the resolved
        // snapshot is stable across runs (readable audit, fudge-free tests).
        Set<Long> recipients = new TreeSet<>();

        // City audiences are already active-only — findActiveIdsByCity reads through the User entity,
        // whose @SQLRestriction hides soft-deleted rows — so they go straight into the union.
        for (String city : spec.cities()) {
            recipients.addAll(users.findActiveIdsByCity(city));
        }

        // Explicit ids and GOING attendees are only *candidates*: an explicit id may be stale, and an
        // attendance row outlives its attendee's account tombstone (people must be resolved through the
        // User aggregate, never the attendance table). Collect them, then validate in one query so a
        // soft-deleted/unknown id is dropped rather than messaged.
        Set<Long> candidates = new HashSet<>(spec.userIds());
        if (!spec.eventIds().isEmpty()) {
            candidates.addAll(attendance.findGoingUserIds(spec.eventIds()));
        }
        if (!candidates.isEmpty()) {
            recipients.addAll(users.findActiveIdsByIdIn(candidates));
        }

        return Collections.unmodifiableSet(recipients);
    }
}
