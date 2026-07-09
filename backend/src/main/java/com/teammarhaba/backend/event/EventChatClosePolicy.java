package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.EventChatCloseProperties;
import com.teammarhaba.backend.config.LayeredHours;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * The single resolver for an event group chat's close/lock window (TM-446): how many hours
 * <em>after</em> the event ends its thread auto-closes (goes read-only), when that instant is, and
 * whether it has passed. It mirrors {@link BookingCutoffPolicy} / {@link LocationRevealPolicy} and
 * shares the same three-tier fallback via {@link LayeredHours}, so the layered-config logic is
 * written once.
 *
 * <p><b>Fallback order</b> — per-event override ({@link Event#getChatCloseHours()}) → per-city
 * default ({@link EventChatCloseProperties#hoursForCity}) → app default
 * ({@link EventChatCloseProperties#defaultHours()}). Unlike the reveal/cutoff policies, the app
 * default can be <em>absent</em>: when nothing is configured at any tier the window is empty, which
 * means <b>never close</b> — the shipped behaviour. A {@code null} override means "inherit".
 *
 * <p><b>Reference point</b> — the window is measured from the event's effective end:
 * {@link Event#getEndAt()} when set, else {@link Event#getStartAt()} for an open-ended event (no
 * {@code endAt}). So a 24h window on an event ending at 18:00 closes its chat at 18:00 the next day.
 *
 * <p><b>Enforcement</b> — the actual soft-close (stamping {@code conversation.closed_at}) and the
 * read-only check live in {@link EventChatLifecycleService}; this component only answers "what is the
 * window and has it elapsed", exactly as {@code LocationRevealPolicy} is the resolver the read/admin
 * surfaces consult.
 */
@Component
public class EventChatClosePolicy {

    private final EventChatCloseProperties properties;

    public EventChatClosePolicy(EventChatCloseProperties properties) {
        this.properties = properties;
    }

    /**
     * The close window for this event in whole hours after its effective end, resolved override →
     * city → app default. {@link OptionalInt#empty()} = never close (nothing configured at any tier).
     */
    public OptionalInt closeHoursFor(Event event) {
        Integer resolved = LayeredHours.resolveNullable(
                event.getChatCloseHours(), properties.hoursForCity(event.getCity()), properties.defaultHours());
        return resolved == null ? OptionalInt.empty() : OptionalInt.of(resolved);
    }

    /**
     * The instant the thread auto-closes: {@code effectiveEnd + closeHours}, where the effective end
     * is {@link Event#getEndAt()} (or {@link Event#getStartAt()} for an open-ended event).
     * {@link Optional#empty()} = never closes (the app default).
     */
    public Optional<Instant> closesAt(Event event) {
        OptionalInt hours = closeHoursFor(event);
        if (hours.isEmpty()) {
            return Optional.empty();
        }
        Instant effectiveEnd = event.getEndAt() != null ? event.getEndAt() : event.getStartAt();
        return Optional.of(effectiveEnd.plus(hours.getAsInt(), ChronoUnit.HOURS));
    }

    /**
     * Whether the thread is closed at {@code now}: {@code true} once {@code now >= closesAt} (closed
     * exactly at the boundary instant, still open a nanosecond before — the same boundary semantics
     * as {@link BookingCutoffPolicy#isPastCutoff}). A never-closing event ({@link #closesAt} empty)
     * is always {@code false}.
     */
    public boolean isClosedAt(Event event, Instant now) {
        return closesAt(event).map(at -> !now.isBefore(at)).orElse(false);
    }

    /**
     * Whether an app-wide close window is configured ({@code app.event-chat-close.default-hours} is
     * set). When {@code false} — the shipped default — a thread can only ever close via its own
     * per-event {@link Event#getChatCloseHours()} override or a per-city default. The close sweep
     * (TM-578) reads this to keep never-closing events out of its candidate batch entirely: if the
     * app default closes <em>everything</em>, every past-ended thread is a candidate; if it doesn't,
     * only events that opt in (override or city) are.
     */
    public boolean appDefaultConfigured() {
        return properties.defaultHours() != null;
    }

    /**
     * The cities (already normalized: trimmed + lower-cased) that carry a per-city close default —
     * i.e. whose events auto-close even with no per-event override and no app default. The close
     * sweep's candidate query (TM-578) uses this to include those events; it is empty in the shipped
     * config, where closing is override-only.
     */
    public Set<String> citiesWithCloseWindow() {
        return properties.cityHours().keySet();
    }
}
