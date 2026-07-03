package com.teammarhaba.backend.event;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The capacity-affecting attendance commands — RSVP, un-RSVP and claim (TM-393).
 *
 * <p><b>Locking discipline</b> — every command runs in its own transaction and starts by taking a
 * {@code SELECT ... FOR UPDATE} lock on the {@code events} row
 * ({@link EventRepository#findByIdForUpdate}). All capacity-affecting writes on one event therefore
 * serialise: counts read under the lock are exact, oversell is impossible, and concurrent claims
 * resolve strictly first-come-first-served (first-claim-wins). Contention is per event — commands
 * on different events never queue behind each other.
 *
 * <p><b>Offer-cascade policy (owner decision 2026-07-03, supersedes auto-promotion)</b> — when a
 * {@code GOING} spot frees, nobody is promoted automatically. The freed spot is <em>recorded</em>
 * purely by derivation (free spots = {@code capacity − GOING count}; see {@code V13}); TM-397
 * polls that condition, notifies waitlisted members in FIFO order five minutes apart (stamping
 * {@code offer_notified_at}), and the spot goes to whichever waitlisted member
 * {@linkplain #claim(VerifiedUser, Long) claims} first. Claiming never requires having been
 * notified — the 5-minute spacing gives earlier queue members a head start, but a later member who
 * learns of the spot may take it (first come, capacity-safe).
 *
 * <p><b>Fairness while a waitlist exists</b> — a new RSVP lands {@code WAITLISTED} whenever the
 * event is at capacity <em>or</em> the waitlist is non-empty, even if a freed spot is technically
 * open. Freed spots belong to the offer cascade; letting a fresh RSVP grab one would let
 * newcomers jump the queue and starve the waitlist forever.
 *
 * <p><b>Change window</b> — all three commands are refused with a {@code 409} once the event has
 * started; hidden events (cancelled, outside the visibility window, soft-deleted) are a public
 * {@code 404} exactly as on the read side.
 */
@Service
public class EventRsvpService {

    static final String EVENT_NOT_FOUND = "Event not found.";
    static final String EVENT_STARTED = "This event has already started, so attendance can no longer be changed.";
    static final String NOT_ON_WAITLIST = "You are not on the waitlist for this event.";
    static final String SPOT_ALREADY_TAKEN = "That spot has already been taken — you are still on the waitlist.";

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final UserService users;

    public EventRsvpService(EventRepository events, EventAttendanceRepository attendance, UserService users) {
        this.events = events;
        this.attendance = attendance;
        this.users = users;
    }

    /**
     * RSVP the caller to an event. Capacity-safe under the event lock: lands {@code GOING} while
     * free spots exist <em>and</em> nobody is waitlisted, otherwise {@code WAITLISTED} at the back
     * of the FIFO queue ({@code created_at} is DB-authoritative, so the queue position is the
     * insert order under the lock). Re-RSVPing while already on the event is idempotent — it
     * returns the current state and changes nothing. The caller's account is provisioned
     * just-in-time (as elsewhere), so a brand-new account's first call works.
     */
    @Transactional
    public RsvpResult rsvp(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }

        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlisted = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        return attendance
                .findByEventIdAndUserId(eventId, user.getId())
                .map(existing -> new RsvpResult(existing.getState(), going, waitlisted))
                .orElseGet(() -> {
                    boolean spotFree = !event.hasCapacityLimit() || going < event.getCapacity();
                    AttendanceState state =
                            (spotFree && waitlisted == 0) ? AttendanceState.GOING : AttendanceState.WAITLISTED;
                    attendance.save(new EventAttendance(eventId, user.getId(), state));
                    return state == AttendanceState.GOING
                            ? new RsvpResult(state, going + 1, waitlisted)
                            : new RsvpResult(state, going, waitlisted + 1);
                });
    }

    /**
     * Un-RSVP the caller (leave the event) — idempotent: leaving an event you are not on is a
     * quiet no-op. Removing a {@code GOING} attendee frees a spot, and that is the whole
     * "recording" the offer cascade needs: free spots are derived ({@code capacity − GOING count},
     * see {@code V13}), so the moment this transaction commits, TM-397's cascade can see a spot to
     * offer. Deliberately <b>no promotion happens here</b> — waitlisted members stay
     * {@code WAITLISTED} until one of them claims.
     */
    @Transactional
    public void cancelRsvp(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }
        attendance.deleteByEventIdAndUserId(eventId, user.getId());
    }

    /**
     * Claim an open spot from the waitlist — the offer cascade's terminal move (TM-393).
     * Transactional first-claim-wins: under the event lock, the first waitlisted claimer to get
     * here flips to {@code GOING} (their waitlist entry closes, keeping its original
     * {@code createdAt}); every later claimer finds the spot gone and gets a {@code 409} with
     * honest copy. When the claim fills the <em>last</em> free spot, the remaining live offers are
     * {@linkplain EventAttendanceRepository#clearOpenOffers voided} — the recorded cascade-stop
     * signal (TM-397 stops walking, and a future freed spot starts a fresh cascade). A claim by a
     * member who is already {@code GOING} is idempotent (double-tap safe); a claim by someone not
     * on the waitlist at all is a {@code 409}.
     */
    @Transactional
    public RsvpResult claim(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }

        EventAttendance mine = attendance
                .findByEventIdAndUserId(eventId, user.getId())
                .orElseThrow(() -> new ConflictException(NOT_ON_WAITLIST));
        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlisted = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        if (mine.getState() == AttendanceState.GOING) {
            return new RsvpResult(AttendanceState.GOING, going, waitlisted); // double-tap after winning
        }
        if (event.hasCapacityLimit() && going >= event.getCapacity()) {
            throw new ConflictException(SPOT_ALREADY_TAKEN);
        }

        mine.promote(); // WAITLISTED -> GOING, own offer stamp cleared; dirty-checking flushes on commit
        boolean lastSpotFilled = event.hasCapacityLimit() && going + 1 >= event.getCapacity();
        if (lastSpotFilled) {
            attendance.clearOpenOffers(eventId); // cascade-stop signal: void the remaining live offers
        }
        return new RsvpResult(AttendanceState.GOING, going + 1, waitlisted - 1);
    }

    /**
     * Load the event under the {@code FOR UPDATE} lock and apply the public 404 rule: missing,
     * soft-deleted (never loads), cancelled or outside the visibility window all read as
     * "not found" — hidden events must be indistinguishable from absent ones.
     */
    private Event lockedVisibleEvent(Long eventId, Instant now) {
        Event event = events.findByIdForUpdate(eventId).orElseThrow(() -> new ResourceNotFoundException(
                EVENT_NOT_FOUND));
        if (!event.isVisibleAt(now)) {
            throw new ResourceNotFoundException(EVENT_NOT_FOUND);
        }
        return event;
    }
}
