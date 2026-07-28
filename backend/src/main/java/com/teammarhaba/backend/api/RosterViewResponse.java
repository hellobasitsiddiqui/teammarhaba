package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.EventRosterAdminService.PastEntry;
import com.teammarhaba.backend.event.EventRosterAdminService.Roster;
import com.teammarhaba.backend.event.EventRosterAdminService.RosterEntry;
import java.time.Instant;
import java.util.List;

/**
 * The admin roster for one event (TM-592 / TM-1114) — returned by
 * {@code GET /api/v1/admin/events/{id}/roster}. Lists every live attendee (GOING in join order, then
 * WAITLISTED FIFO) with the state they hold, plus the event's capacity and counts, and {@code pastEntries}
 * — the reconstructed history of users who left (evicted or self-cancelled) — so the console can render the
 * roster, its evict/add controls, and a "previously on this event" history.
 *
 * @param eventId     the event
 * @param capacity    the event's capacity ({@code null} = unlimited)
 * @param going       the {@code GOING} count
 * @param waitlist    the {@code WAITLISTED} count
 * @param entries     the live attendees (GOING first, then WAITLISTED), each with its over-cap flag
 * @param pastEntries users who left (most recent exit first), excluding anyone currently live (TM-1114)
 */
public record RosterViewResponse(
        long eventId,
        Integer capacity,
        long going,
        long waitlist,
        List<Entry> entries,
        List<PastEntryView> pastEntries) {

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

    /**
     * One past-attendance history row (TM-1114): a user who left the event (evicted or self-cancelled).
     *
     * @param userId      the past attendee's {@code users.id}
     * @param displayName their profile name (may be {@code null} — the console shows a placeholder)
     * @param lastState   {@code "EVICTED"} (admin removal) or {@code "CANCELLED"} (self un-RSVP)
     * @param at          when the exit was recorded (the audit row's timestamp)
     * @param byAdmin     {@code true} if an admin removed them, {@code false} for a self-cancellation
     */
    public record PastEntryView(
            Long userId, String displayName, String lastState, Instant at, boolean byAdmin) {

        static PastEntryView from(PastEntry p) {
            return new PastEntryView(p.userId(), p.displayName(), p.lastState(), p.at(), p.byAdmin());
        }
    }

    public static RosterViewResponse from(Roster roster) {
        return new RosterViewResponse(
                roster.eventId(),
                roster.capacity(),
                roster.going(),
                roster.waitlist(),
                roster.entries().stream().map(Entry::from).toList(),
                roster.pastEntries().stream().map(PastEntryView::from).toList());
    }
}
