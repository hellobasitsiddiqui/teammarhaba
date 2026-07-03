package com.teammarhaba.backend.event;

import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

/**
 * Event reminder fan-out (TM-394, events epic): pushes the {@link ReminderMilestone#T_MINUS_24H}
 * and {@link ReminderMilestone#T_MINUS_1H} nudges to an event's {@code GOING} attendees, driven by
 * the {@link EventReminderScheduler} tick.
 *
 * <p><strong>Who gets one.</strong> Recipients are the event's {@link AttendanceState#GOING} rows
 * only (waitlisted users hold no slot — nothing to remind), resolved <em>through</em>
 * {@link UserRepository} and gated by the same rails as the admin broadcast ({@code
 * BroadcastService}, TM-364): a soft-deleted/unknown account is dropped by the entity's
 * {@code @SQLRestriction}, a suspended one ({@code enabled == false}) is skipped, and
 * {@code notificationPref} is honoured exactly like broadcast does — only {@code PUSH}/{@code
 * BOTH} receive (EMAIL, the default, <em>is</em> the push opt-out). Tokens are de-duplicated
 * across attendees and delivered through the shared {@link PushNotificationService#sendToTokens}
 * seam, so FCM handling, {@code UNREGISTERED} pruning and outcome classification stay in one
 * place; the token table is never resolved directly from attendance rows.
 *
 * <p><strong>When it fires.</strong> A milestone is due when all of these hold at tick time
 * {@code now}:
 *
 * <ul>
 *   <li>the event is {@link EventStatus#PUBLISHED} — a cancelled event never reminds (filtered in
 *       the scan query <em>and</em> re-checked just before the send, so a cancellation racing the
 *       tick still wins), and a soft-deleted one is invisible to the scan;</li>
 *   <li>{@code fireAt = startAt - offset} has passed, but the event has not started — a reminder
 *       is never sent after the start, however long the scheduler was down;</li>
 *   <li>{@code fireAt >= createdAt} — the milestone was still in the future when the event was
 *       created. This is the late-creation rule: an event created inside a reminder window gets
 *       only the still-future milestones (created 3h before start → only the 1h nudge; created
 *       30 minutes before → none), instead of a burst of instantly-"overdue" reminders on
 *       creation.</li>
 * </ul>
 *
 * <p><strong>At-most-once, cluster-wide.</strong> Each (event, milestone) sends at most once,
 * enforced by a <em>persisted</em> claim row ({@link EventReminderSend}) with a DB-unique pair —
 * the shared counterpart of the broadcast cooldown's documented process-local map: where that
 * guard is per-process (fine for its accidental-double-click purpose), reminders must hold across
 * restarts and multiple Cloud Run instances, so the claim races on a Postgres unique index
 * instead. The sequence is <em>claim → commit → send</em>: {@code saveAndFlush} runs in its own
 * short transaction (this method is deliberately not transactional, same reasoning as
 * {@code PushNotificationService} — a slow FCM fan-out must never sit inside a DB transaction,
 * and an uncommitted claim would be invisible to a racing instance). A loser's insert collides
 * ({@link DataIntegrityViolationException}) and skips; a crash after claim but before send drops
 * that one reminder rather than ever double-sending. Fan-out counts are back-filled onto the
 * claim row afterwards, best effort.
 *
 * <p><strong>Content.</strong> Title is the milestone prefix + the event heading; body is the
 * event's start rendered in the <em>event's own timezone</em> plus the location line. This is the one
 * deliberate exception to "the backend never renders local times" (TM-391's client-side rule):
 * push text is displayed verbatim by the OS with no client logic, so the server must localise
 * here, using the stored IANA zone. The location line is reveal-gated through {@link
 * EventPushLocation} (TM-416) — the exact venue only once the event's reveal window has opened,
 * honest placeholder copy before then, so a shorter-than-default reveal window can't leak the address
 * early. The deep link is the {@code #/events/{id}} detail route via the {@link PushRoutes#eventDetail
 * allow-listed route pattern} (TM-360 mechanism).
 *
 * <p><strong>Known limits</strong> (documented trade-offs, not bugs): a rescheduled event does not
 * re-arm milestones already claimed for it (the marker pins the pair, not the start time), and a
 * milestone unsent after long downtime simply sends late — still before start — possibly alongside
 * the next milestone.
 */
@Service
public class EventReminderService {

    private static final Logger log = LoggerFactory.getLogger(EventReminderService.class);

    /** Local start rendering, e.g. {@code "Sat 4 Jul, 19:00"} — day-month only; reminders are near-term. */
    private static final DateTimeFormatter LOCAL_START =
            DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.ENGLISH);

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final EventReminderSendRepository markers;
    private final UserRepository users;
    private final DeviceTokenRepository deviceTokens;
    private final PushNotificationService push;
    private final EventPushLocation pushLocation;
    private final Clock clock;

    @Autowired
    public EventReminderService(
            EventRepository events,
            EventAttendanceRepository attendance,
            EventReminderSendRepository markers,
            UserRepository users,
            DeviceTokenRepository deviceTokens,
            PushNotificationService push,
            EventPushLocation pushLocation) {
        this(events, attendance, markers, users, deviceTokens, push, pushLocation, Clock.systemUTC());
    }

    /** Test seam: inject a fixed/advanceable {@link Clock} (house pattern, as {@code BroadcastService}). */
    EventReminderService(
            EventRepository events,
            EventAttendanceRepository attendance,
            EventReminderSendRepository markers,
            UserRepository users,
            DeviceTokenRepository deviceTokens,
            PushNotificationService push,
            EventPushLocation pushLocation,
            Clock clock) {
        this.events = events;
        this.attendance = attendance;
        this.markers = markers;
        this.users = users;
        this.deviceTokens = deviceTokens;
        this.push = push;
        this.pushLocation = pushLocation;
        this.clock = clock;
    }

    /**
     * One scan tick: find PUBLISHED events starting within the {@link ReminderMilestone#SCAN_HORIZON},
     * work out which milestones are due and unclaimed, then claim-and-send each. Safe to call from
     * any number of instances concurrently — the persisted claim decides the single sender.
     *
     * @return how many reminders this call actually claimed and sent (for logs/tests)
     */
    public int remindDueEvents() {
        Instant now = clock.instant();
        List<Event> candidates =
                events.findStartingBetween(EventStatus.PUBLISHED, now, now.plus(ReminderMilestone.SCAN_HORIZON));
        if (candidates.isEmpty()) {
            return 0;
        }

        // One read for every existing claim over the whole candidate batch — the cheap pre-filter.
        // The insert race below remains the actual at-most-once guard.
        Map<Long, EnumSet<ReminderMilestone>> claimed = new HashMap<>();
        for (EventReminderSend marker :
                markers.findByEventIdIn(candidates.stream().map(Event::getId).toList())) {
            claimed.computeIfAbsent(marker.getEventId(), id -> EnumSet.noneOf(ReminderMilestone.class))
                    .add(marker.getMilestone());
        }

        int sent = 0;
        for (Event event : candidates) {
            for (ReminderMilestone milestone : ReminderMilestone.values()) {
                if (!isDue(event, milestone, now)) {
                    continue;
                }
                if (claimed.getOrDefault(event.getId(), EnumSet.noneOf(ReminderMilestone.class))
                        .contains(milestone)) {
                    continue; // already sent (this run of the pre-filter's knowledge)
                }
                if (remind(event, milestone, now)) {
                    sent++;
                }
            }
        }
        return sent;
    }

    /**
     * Due = the milestone's fire time has passed, the event hasn't started, and the milestone was
     * still in the future when the event was created (the late-creation rule). The scan query
     * already guarantees {@code startAt > now}; re-asserted here so this method is the whole truth.
     */
    private boolean isDue(Event event, ReminderMilestone milestone, Instant now) {
        Instant fireAt = milestone.fireAt(event.getStartAt());
        return !fireAt.isAfter(now) // due
                && event.getStartAt().isAfter(now) // never remind after start
                && !fireAt.isBefore(event.getCreatedAt()); // still-future at creation
    }

    /**
     * Claim, then send, one reminder. Returns {@code true} only when this call won the claim and
     * performed the fan-out (even if it then reached zero devices — the reminder is spent either way;
     * capacity to receive is the attendee's own opt-in/device state, exactly like broadcast).
     */
    private boolean remind(Event event, ReminderMilestone milestone, Instant now) {
        EventReminderSend marker = claim(event.getId(), milestone);
        if (marker == null) {
            return false; // a concurrent instance (or an earlier crashed run) holds the claim
        }

        // Re-check status right before sending: the claim is committed, so if a cancellation raced
        // this tick we simply leave the marker as a spent no-op rather than nudging for a dead event.
        Event current = events.findById(event.getId()).orElse(null);
        if (current == null || current.getStatus() != EventStatus.PUBLISHED) {
            log.info(
                    "Reminder {} for event {} claimed but skipped: event no longer PUBLISHED.",
                    milestone,
                    event.getId());
            return false;
        }

        PushFanout fanout = fanOut(current, milestone, now);
        marker.recordFanout(fanout);
        markers.save(marker); // best-effort back-fill; the claim itself is already durable
        log.info("Event {} reminder {} sent: {}", current.getId(), milestone, fanout);
        return true;
    }

    /**
     * Insert the claim row and commit ({@code saveAndFlush} runs in its own repository transaction —
     * there is deliberately no outer one). {@code null} means the DB-unique (event, milestone) pair
     * already exists: someone else sent (or is sending) this reminder.
     */
    private EventReminderSend claim(Long eventId, ReminderMilestone milestone) {
        try {
            return markers.saveAndFlush(new EventReminderSend(eventId, milestone));
        } catch (DataIntegrityViolationException alreadyClaimed) {
            log.debug("Reminder {} for event {} already claimed elsewhere; skipping.", milestone, eventId);
            return null;
        }
    }

    /**
     * Resolve the event's GOING attendees through {@code User} with the broadcast rails (soft-deleted
     * and suspended skipped, {@code notificationPref} honoured), de-duplicate their device tokens, and
     * deliver through the shared {@link PushNotificationService#sendToTokens} fan-out.
     */
    private PushFanout fanOut(Event event, ReminderMilestone milestone, Instant now) {
        List<EventAttendance> going =
                attendance.findByEventIdAndState(event.getId(), AttendanceState.GOING);
        if (going.isEmpty()) {
            return new PushFanout(0, 0, 0, 0);
        }

        // Resolve people THROUGH UserRepository (one batch read): the entity's @SQLRestriction drops
        // soft-deleted accounts even though their attendance + device_tokens rows survive a tombstone.
        Map<Long, User> byId =
                users.findAllById(going.stream().map(EventAttendance::getUserId).toList()).stream()
                        .collect(Collectors.toMap(User::getId, Function.identity()));

        // Union of eligible attendees' tokens, de-duplicated by value (shared/handed-down devices are
        // pushed once) — same shape as the broadcast fan-out. Insertion-ordered for stable behaviour.
        Set<String> tokens = new LinkedHashSet<>();
        for (EventAttendance a : going) {
            User user = byId.get(a.getUserId());
            if (user == null || !user.isEnabled() || !isPushEligible(user.getNotificationPref())) {
                continue; // not found/soft-deleted, suspended, or opted out of push — the TM-364 rails
            }
            for (DeviceToken device : deviceTokens.findByUserId(user.getId())) {
                tokens.add(device.getToken());
            }
        }
        if (tokens.isEmpty()) {
            return new PushFanout(0, 0, 0, 0);
        }
        return push.sendToTokens(tokens, message(event, milestone, now));
    }

    /** Push-eligible == the pref opted into push; EMAIL (the default) is the opt-out — as broadcast. */
    private static boolean isPushEligible(NotificationPref pref) {
        return pref == NotificationPref.PUSH || pref == NotificationPref.BOTH;
    }

    /**
     * The reminder content: milestone prefix + heading as the title; local start time + location line
     * as the body; the event-detail deep link (allow-listed pattern, TM-360 mechanism) as the route.
     *
     * <p>The location line is routed through {@link EventPushLocation} (TM-416): it is the exact venue
     * only once {@code now} has reached the event's reveal boundary, and honest placeholder copy
     * before then — so a short-reveal event never leaks its address via the T-24h reminder.
     */
    private PushMessage message(Event event, ReminderMilestone milestone, Instant now) {
        String localStart = LOCAL_START.withZone(zoneOf(event)).format(event.getStartAt());
        return new PushMessage(
                milestone.titlePrefix() + event.getHeading(),
                localStart + " · " + pushLocation.line(event, now),
                PushRoutes.eventDetail(event.getId()));
    }

    /** The event's own IANA zone; falls back to UTC if the stored id is somehow unparsable. */
    private static ZoneId zoneOf(Event event) {
        try {
            return ZoneId.of(event.getTimezone());
        } catch (RuntimeException invalid) {
            log.warn("Event {} has unparsable timezone '{}'; rendering start in UTC.",
                    event.getId(), event.getTimezone());
            return ZoneOffset.UTC;
        }
    }
}
