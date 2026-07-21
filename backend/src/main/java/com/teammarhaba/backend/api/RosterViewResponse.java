package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.EventRosterAdminService.Roster;
import com.teammarhaba.backend.event.EventRosterAdminService.RosterEntry;
import java.util.List;

/**
 * The admin roster for one event (TM-592) — returned by {@code GET /api/v1/admin/events/{id}/roster}.
 * Lists every attendee (GOING in join order, then WAITLISTED FIFO) with the state they hold, plus the
 * event's capacity and counts, so the console can render the roster and its evict/add controls.
 *
 * @param eventId  the event
 * @param capacity the event's capacity ({@code null} = unlimited)
 * @param going    the {@code GOING} count
 * @param waitlist the {@code WAITLISTED} count
 * @param entries  the attendees (GOING first, then WAITLISTED), each with its over-cap flag
 */
public record RosterViewResponse(
        long eventId, Integer capacity, long going, long waitlist, List<Entry> entries) {

    /**
     * One attendee row.
     *
     * @param userId       the attendee's {@code users.id} (the evict/target key the console posts back)
     * @param displayName  their profile name (may be {@code null} — the console shows a placeholder)
     * @param state        {@code "GOING"} or {@code "WAITLISTED"}
     * @param overCapacity {@code true} for a GOING attendee sitting over the current cap (never auto-evicted)
     */
    public record Entry(Long userId, String displayName, String state, boolean overCapacity) {

        static Entry from(RosterEntry e) {
            return new Entry(e.userId(), e.displayName(), e.state().name(), e.overCapacity());
        }
    }

    public static RosterViewResponse from(Roster roster) {
        return new RosterViewResponse(
                roster.eventId(),
                roster.capacity(),
                roster.going(),
                roster.waitlist(),
                roster.entries().stream().map(Entry::from).toList());
    }
}
