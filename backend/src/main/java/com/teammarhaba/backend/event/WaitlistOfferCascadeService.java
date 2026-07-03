package com.teammarhaba.backend.event;

import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.notify.PushRoutes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The waitlist <b>offer cascade</b> (TM-397, owner policy 2026-07-03 — supersedes auto-promotion).
 * When a {@code GOING} spot frees on a full event, nobody is promoted automatically; instead the
 * waitlist is offered the spot in FIFO order, widening every five minutes, and it goes to the first
 * member to {@linkplain EventRsvpService#claim claim} it. This service is the recurring sweep behind
 * that policy, driven by the {@link WaitlistOfferCascadeScheduler} tick (reusing TM-394's
 * scheduler-plus-clock-injected-service shape).
 *
 * <h2>Chosen semantics — pooled offers, cascade per event</h2>
 *
 * A single episode runs per event (not per individual spot), sized by the <em>derived</em> free-spot
 * count ({@code capacity − GOING count}; no counter column — see {@code V13}):
 *
 * <ol>
 *   <li><b>T+0</b> (the first tick after the spot(s) free): offer the first {@code freeSpots}
 *       waitlisted members. For the common single freed spot that is exactly waitlist #1.</li>
 *   <li><b>Every {@value #OFFER_INTERVAL_MINUTES} minutes</b> the spot stays unclaimed: widen to one
 *       more FIFO member — the offer pool grows, first claim wins.</li>
 *   <li><b>Stop the instant it fills</b>: a claim that takes the last free spot voids the remaining
 *       live offers ({@link EventAttendanceRepository#clearOpenOffers}, from {@link
 *       EventRsvpService#claim}); this sweep then sees no free spot and offers no more. The list
 *       running out is the other stop (target is capped at the waitlist size).</li>
 * </ol>
 *
 * <p>The spacing and the pool size fall out of one formula each tick:
 * {@code target = min(waitlistSize, freeSpots + floor((now − episodeStart) / 5m))}, where
 * {@code episodeStart} is the earliest live offer's stamp (or {@code now} for a fresh episode).
 * {@code target − liveOffers} new members are stamped, in FIFO order, skipping anyone already
 * offered. So a new member is added only once a 5-minute boundary passes, and a freshly freed extra
 * spot widens the pool immediately.
 *
 * <h2>Idempotency &amp; restart-safety</h2>
 *
 * The persisted {@code offer_notified_at} stamp <em>is</em> the marker: a member with a live offer is
 * never re-stamped, so each waitlisted member is offer-notified <b>at most once per free-spot
 * episode</b>, and the whole state lives in Postgres — a restarted or second instance reads the same
 * stamps and continues the same cascade rather than restarting it. When a claim fills the spot the
 * stamps are wiped, so a future freed spot begins a genuinely fresh episode (members may be offered
 * again — a new spot, a new episode). Like the reminder job, the order is <em>stamp → commit →
 * push</em>: a crash between the two drops that one offer push (the member still sees the in-app
 * "spot available to claim" from the committed stamp) rather than ever double-pushing.
 *
 * <h2>Concurrency</h2>
 *
 * Each event is swept in its own short transaction holding the same {@code SELECT … FOR UPDATE} lock
 * on the {@code events} row that every capacity-affecting write takes ({@link
 * EventRepository#findByIdForUpdate}). Stamping therefore serialises with RSVP/claim: the free-spot
 * count read under the lock is exact, and the sweep can never stamp a new offer <em>after</em> a
 * concurrent claim fills the spot (it would re-read a full event and stop) — that is what makes
 * "stop the instant it fills" race-free, and it also closes the cancel race (a cancel's status write
 * contends on the same row, so {@link #killCascade} always runs after any in-flight stamp). The push
 * fan-out runs <em>after</em> the transaction commits (never inside the lock), through the shared
 * {@link EventAttendeeNotifier} rails.
 *
 * <p>Only claimable events are offered: the sweep applies the same gate as {@link
 * EventRsvpService#claim} — {@code PUBLISHED} and inside its visibility window, not yet started, and
 * before the {@link BookingCutoffPolicy booking cutoff} (TM-424) — so every offer corresponds to a
 * spot a member can actually take (an out-of-window, started or past-cutoff event is skipped, never
 * offered; past the cutoff a claim would 409 {@code BOOKING_CLOSED}).
 */
@Service
public class WaitlistOfferCascadeService {

    /** How long a freed spot stays offered to the current pool before widening to one more member. */
    static final int OFFER_INTERVAL_MINUTES = 5;

    static final Duration OFFER_INTERVAL = Duration.ofMinutes(OFFER_INTERVAL_MINUTES);

    private static final Logger log = LoggerFactory.getLogger(WaitlistOfferCascadeService.class);

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final OfferCascadeScanRepository scan;
    private final EventAttendeeNotifier notifier;
    private final BookingCutoffPolicy bookingCutoff;
    private final TransactionTemplate tx;
    private final Clock clock;

    @Autowired
    public WaitlistOfferCascadeService(
            EventRepository events,
            EventAttendanceRepository attendance,
            OfferCascadeScanRepository scan,
            EventAttendeeNotifier notifier,
            BookingCutoffPolicy bookingCutoff,
            PlatformTransactionManager txManager) {
        this(events, attendance, scan, notifier, bookingCutoff, new TransactionTemplate(txManager), Clock.systemUTC());
    }

    /** Test seam: inject an advanceable {@link Clock} and an explicit template (house pattern, TM-394). */
    WaitlistOfferCascadeService(
            EventRepository events,
            EventAttendanceRepository attendance,
            OfferCascadeScanRepository scan,
            EventAttendeeNotifier notifier,
            BookingCutoffPolicy bookingCutoff,
            TransactionTemplate tx,
            Clock clock) {
        this.events = events;
        this.attendance = attendance;
        this.scan = scan;
        this.notifier = notifier;
        this.bookingCutoff = bookingCutoff;
        this.tx = tx;
        this.clock = clock;
    }

    /**
     * One sweep: walk every event that currently has a waitlist and offer/widen where a spot is free.
     * Safe to call from any number of instances concurrently — the per-event lock and the persisted
     * stamps decide who is offered.
     *
     * @return how many members this sweep newly offered (across all events), for logs/tests
     */
    public int sweepOpenOffers() {
        int pushed = 0;
        for (Long eventId : scan.findEventIdsWithWaitlist()) {
            pushed += offerForEvent(eventId);
        }
        return pushed;
    }

    /**
     * Kill any running cascade for an event: void its live offers (the recorded cascade-stop signal).
     * Called by the cancellation path ({@code EventLifecycleNotifier}) so a called-off event stops
     * offering a spot nobody can take. Idempotent — voiding zero offers is a clean no-op.
     *
     * <p>{@link Propagation#REQUIRES_NEW} is deliberate: the caller is an {@code AFTER_COMMIT} event
     * listener, so the publishing transaction is committed but still bound to the thread — a plain
     * {@code REQUIRED} would try to join that dead transaction and the bulk update would fail with
     * {@code TransactionRequiredException}. A fresh transaction gives the {@code @Modifying} wipe a
     * live one to run in.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void killCascade(long eventId) {
        int voided = attendance.clearOpenOffers(eventId);
        if (voided > 0) {
            log.info("Offer cascade for event {} killed: {} live offer(s) voided.", eventId, voided);
        }
    }

    /** Stamp this event's due offers under the lock (its own tx), then push to them after commit. */
    private int offerForEvent(Long eventId) {
        OfferBatch batch = tx.execute(status -> stampDueOffers(eventId));
        if (batch == null || batch.userIds().isEmpty()) {
            return 0;
        }
        PushFanout fanout =
                notifier.pushToUsers(batch.userIds(), offerMessage(batch.eventId(), batch.heading()));
        log.info(
                "Offer cascade widened event {} to {} waitlisted member(s): {}",
                batch.eventId(),
                batch.userIds().size(),
                fanout);
        return batch.userIds().size();
    }

    /**
     * The locked phase: under the event's {@code FOR UPDATE} lock, work out how many members the
     * cascade owes an offer right now (the pool formula), stamp exactly those next FIFO members, and
     * return them for the post-commit push. Returns {@code null} when there is nothing to offer (event
     * gone/cancelled/out-of-window/started, unlimited capacity, no free spot, or the spacing hasn't
     * elapsed). Runs inside {@link #tx}, so every read and the stamps commit as one unit.
     */
    private OfferBatch stampDueOffers(Long eventId) {
        Instant now = clock.instant();
        Event event = events.findByIdForUpdate(eventId).orElse(null);
        if (event == null
                || !event.isVisibleAt(now)
                || !event.getStartAt().isAfter(now)
                || bookingCutoff.isPastCutoff(event, now)) {
            // No claimable spot here — the exact same gate as claim (visible + not started + before the
            // booking cutoff, TM-424). Past the cutoff claim 409s BOOKING_CLOSED, so offering a spot in
            // the final window would nudge waitlisters toward a spot they cannot take.
            return null;
        }
        if (!event.hasCapacityLimit()) {
            return null; // unlimited capacity never waitlists — nothing to cascade
        }

        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long freeSpots = event.getCapacity() - going;
        List<EventAttendance> waitlist = attendance.findWaitlistFifo(eventId);
        if (freeSpots <= 0) {
            // Defensive cascade-stop for the rare "spot vanished without a claim" (e.g. capacity
            // lowered below the GOING count): the claim path already voids offers on a last-spot fill.
            if (waitlist.stream().anyMatch(EventAttendance::hasOpenOffer)) {
                attendance.clearOpenOffers(eventId);
            }
            return null;
        }

        List<EventAttendance> liveOffers =
                waitlist.stream().filter(EventAttendance::hasOpenOffer).toList();
        Instant episodeStart = liveOffers.stream()
                .map(EventAttendance::getOfferNotifiedAt)
                .min(Comparator.naturalOrder())
                .orElse(now); // fresh episode: this tick anchors it
        long elapsedIntervals =
                Math.max(0, Duration.between(episodeStart, now).toMillis() / OFFER_INTERVAL.toMillis());
        long target = Math.min(waitlist.size(), freeSpots + elapsedIntervals);
        int toOffer = (int) (target - liveOffers.size());
        if (toOffer <= 0) {
            return null; // spacing not yet elapsed (or the whole waitlist already holds an offer)
        }

        List<Long> offered = new ArrayList<>(toOffer);
        for (EventAttendance member : waitlist) {
            if (offered.size() >= toOffer) {
                break;
            }
            if (member.hasOpenOffer()) {
                continue; // already offered this episode — never notified twice
            }
            member.recordOffer(now); // the persisted idempotency marker + "spot available to claim" flag
            attendance.save(member);
            offered.add(member.getUserId());
        }
        return new OfferBatch(eventId, event.getHeading(), offered);
    }

    /** The offer push: title + who-first line + the event-detail deep link (allow-listed, TM-290). */
    private static PushMessage offerMessage(long eventId, String heading) {
        return new PushMessage(
                "A spot opened: " + heading,
                "First to claim it gets in — tap to grab the spot.",
                PushRoutes.eventDetail(eventId));
    }

    /** The stamped-but-not-yet-pushed result of one locked pass: who to push, and the message inputs. */
    private record OfferBatch(long eventId, String heading, List<Long> userIds) {}
}
