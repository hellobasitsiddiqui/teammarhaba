package com.teammarhaba.backend.event;

import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushRoutes;
import java.time.Clock;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Event lifecycle pushes (TM-397): turns the admin edit/cancel seam ({@link EventLifecycleEvent}) and
 * the successful-claim seam ({@link EventClaimedEvent}) into notifications for the people who care.
 *
 * <p>Both handlers fire {@code @TransactionalEventListener(phase = AFTER_COMMIT)}, so a push only ever
 * follows a change that actually committed — a rolled-back edit, cancel or claim notifies nobody.
 * Recipients are resolved fresh at send time and pushed through the shared {@link
 * EventAttendeeNotifier} rails (people via {@code User}, {@code notificationPref} honoured, tokens
 * de-duplicated), so the opt-out/suspended/soft-deleted handling matches reminders and broadcast.
 *
 * <h2>Edit — material changes only</h2>
 *
 * An {@link EventLifecycleEvent.Kind#UPDATED} notifies the {@code GOING} attendees only when a
 * <b>material</b> field moved — the {@link #MATERIAL_FIELDS}: the event's <em>when</em>
 * ({@code startAt}/{@code timezone}, which together fix the local start an attendee plans around) and
 * its <em>where</em> ({@code locationText}). A description fix, image swap, capacity or
 * visibility-window tweak carries no material field, so it never pushes — the notifier reads the
 * exact changed-field set the admin service already computed, off the event, and applies the policy
 * here (the domain seam stays policy-free). {@code endAt} and the map/online URLs are a deliberate
 * non-material trade-off for now (a follow-up can widen the set).
 *
 * <p><b>Reveal-aware venue (TM-416).</b> When the <em>where</em> moved, the push names the new venue
 * only once the event's location-reveal window has opened, routed through the shared
 * {@link EventPushLocation} helper — the same gate the reminders use. Before reveal the address is
 * withheld and the push just points at the app, so a location change on a not-yet-revealed event can
 * never leak the new address early; after reveal the attendee sees where it moved to.
 *
 * <h2>Cancel — notify and stop everything</h2>
 *
 * A {@link EventLifecycleEvent.Kind#CANCELLED} pushes "Event cancelled" to the {@code GOING}
 * attendees and {@linkplain WaitlistOfferCascadeService#killCascade kills any running offer cascade}
 * (voids the live offers so nobody is invited to claim a called-off event). Future <em>reminders</em>
 * need no action here: {@code EventReminderService} already filters to {@code PUBLISHED} in its scan
 * <em>and</em> re-checks the status just before sending, so a cancelled event simply never reminds —
 * cancellation itself is the stop signal (documented, not re-implemented).
 *
 * <h2>Claim — the winner's confirmation</h2>
 *
 * An {@link EventClaimedEvent} sends just the claimant the "You're in ✓" push. It is raised only on a
 * genuine WAITLISTED → GOING promotion, so a double-tap can't double-confirm.
 *
 * <p>All routes are the allow-listed event-detail deep link ({@link PushRoutes#eventDetail}), so a tap
 * lands on the event where the claim action / cancelled banner lives.
 */
@Component
public class EventLifecycleNotifier {

    /**
     * The fields whose change is "material" enough to notify GOING attendees — the event's when and
     * where. These are the exact names {@code EventAdminService} records on an edit, so membership is
     * a direct set check.
     */
    static final Set<String> MATERIAL_FIELDS = Set.of("startAt", "timezone", "locationText");

    private static final Logger log = LoggerFactory.getLogger(EventLifecycleNotifier.class);

    private final EventAttendanceRepository attendance;
    private final EventRepository events;
    private final EventAttendeeNotifier notifier;
    private final WaitlistOfferCascadeService cascade;
    private final EventPushLocation pushLocation;
    private final Clock clock;

    @Autowired
    public EventLifecycleNotifier(
            EventAttendanceRepository attendance,
            EventRepository events,
            EventAttendeeNotifier notifier,
            WaitlistOfferCascadeService cascade,
            EventPushLocation pushLocation) {
        this(attendance, events, notifier, cascade, pushLocation, Clock.systemUTC());
    }

    /** Test seam: inject a fixed {@link Clock} so the location-reveal boundary is deterministic. */
    EventLifecycleNotifier(
            EventAttendanceRepository attendance,
            EventRepository events,
            EventAttendeeNotifier notifier,
            WaitlistOfferCascadeService cascade,
            EventPushLocation pushLocation,
            Clock clock) {
        this.attendance = attendance;
        this.events = events;
        this.notifier = notifier;
        this.cascade = cascade;
        this.pushLocation = pushLocation;
        this.clock = clock;
    }

    /** Edit/cancel pushes, post-commit. Create has no attendees, so it is a no-op. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onLifecycle(EventLifecycleEvent event) {
        switch (event.kind()) {
            case CREATED -> {
                /* a brand-new event has no attendees to notify */
            }
            case UPDATED -> {
                if (isMaterial(event.changedFields())) {
                    pushToGoing(event.eventId(), updatedMessage(event));
                } else {
                    log.debug("Event {} updated with no material change; not notifying.", event.eventId());
                }
            }
            case CANCELLED -> {
                cascade.killCascade(event.eventId()); // stop any running offer cascade
                pushToGoing(event.eventId(), cancelledMessage(event.eventId(), event.heading()));
            }
        }
    }

    /** The claimant's "You're in ✓" confirmation, post-commit. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onClaimed(EventClaimedEvent event) {
        notifier.pushToUser(event.userId(), claimedMessage(event.eventId(), event.heading()));
    }

    /** A material change touches at least one {@link #MATERIAL_FIELDS} entry. */
    private static boolean isMaterial(Set<String> changedFields) {
        return changedFields.stream().anyMatch(MATERIAL_FIELDS::contains);
    }

    /** Resolve the event's current GOING attendees and push {@code message} to them (no-op if none). */
    private void pushToGoing(long eventId, PushMessage message) {
        List<Long> going = attendance.findByEventIdAndState(eventId, AttendanceState.GOING).stream()
                .map(EventAttendance::getUserId)
                .toList();
        if (going.isEmpty()) {
            return;
        }
        notifier.pushToUsers(going, message);
    }

    private PushMessage updatedMessage(EventLifecycleEvent lifecycle) {
        Set<String> changedFields = lifecycle.changedFields();
        boolean timeChanged = changedFields.contains("startAt") || changedFields.contains("timezone");
        boolean placeChanged = changedFields.contains("locationText");
        String what;
        if (timeChanged && placeChanged) {
            what = "The time and location changed";
        } else if (timeChanged) {
            what = "The start time changed";
        } else {
            what = "The location changed";
        }

        // When the venue moved, name the new place only once its reveal window has opened — the same
        // gate the reminders use, via the one shared EventPushLocation helper (TM-416). Before reveal
        // (or if the event has since been removed) we withhold the address and just point at the app,
        // exactly as the public events API withholds it; the client applies the policy when rendering.
        String tail = " — tap for details.";
        if (placeChanged) {
            Event current = events.findById(lifecycle.eventId()).orElse(null);
            if (current != null && pushLocation.isRevealed(current, clock.instant())) {
                tail = " — now at " + current.getLocationText() + ". Tap for details.";
            }
        }
        return new PushMessage(
                "Event updated: " + lifecycle.heading(), what + tail, PushRoutes.eventDetail(lifecycle.eventId()));
    }

    private static PushMessage cancelledMessage(long eventId, String heading) {
        return new PushMessage(
                "Event cancelled: " + heading, "This event has been called off.", PushRoutes.eventDetail(eventId));
    }

    private static PushMessage claimedMessage(long eventId, String heading) {
        return new PushMessage("You're in ✓", "You've got a spot at " + heading + ".", PushRoutes.eventDetail(eventId));
    }
}
