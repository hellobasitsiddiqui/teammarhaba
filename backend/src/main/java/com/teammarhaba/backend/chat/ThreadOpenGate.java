package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Clock;
import java.time.Instant;

/**
 * The single resolver of "is this chat thread still writable right now?" (TM-857 — consolidates the
 * {@code requireOpenThread} logic that {@link MessagePostService}, {@link MessageReactionService} and
 * {@link MessageAuthorService} each used to copy-paste, so post / react / edit can never drift apart on
 * the close window).
 *
 * <p>Deliberately a plain collaborator, not a Spring bean: each of the three services already injects
 * (and its test constructor pins) {@code events} / {@code lifecycle} / {@code clock}, so each builds
 * one of these from those same fields. That shares the implementation without disturbing the existing
 * fixed-{@link Clock} test constructors.
 *
 * <p>The rule mirrors TM-446: for an {@code EVENT_GROUP} thread it delegates to {@link
 * EventChatLifecycleService#isThreadReadOnly} — the one resolver of "manually soft-closed, or past the
 * per-event close-time policy" — resolving the backing event at the injected {@link Clock}. A
 * soft-deleted / missing event (its {@code findById} empty under the entity's {@code @SQLRestriction})
 * has no live chat and reads as closed. A non-event (admin-broadcast) thread has no close policy, so it
 * falls back to the plain {@link Conversation#isClosed()} soft-close flag.
 *
 * <p>Each caller still owns how it <em>resolves</em> the {@link Conversation} (some already hold it,
 * some re-read it and differ on the not-found response) and its own action-specific 409 wording — only
 * the shared close-window decision lives here.
 */
public class ThreadOpenGate {

    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final Clock clock;

    public ThreadOpenGate(EventRepository events, EventChatLifecycleService lifecycle, Clock clock) {
        this.events = events;
        this.lifecycle = lifecycle;
        this.clock = clock;
    }

    /**
     * Whether {@code conversation} is closed (read-only) right now — an event thread past its close
     * window / manually closed (soft-deleted or missing event reads as closed), or a non-event thread
     * with its soft-close flag set.
     */
    public boolean isClosed(Conversation conversation) {
        Long eventId = conversation.getEventId();
        if (eventId != null) {
            Instant now = clock.instant();
            return events
                    .findById(eventId)
                    .map(event -> lifecycle.isThreadReadOnly(event, now))
                    .orElse(true); // soft-deleted / missing event → no live chat
        }
        return conversation.isClosed();
    }

    /**
     * Throw a {@link ConflictException} carrying {@code closedMessage} when {@code conversation} is
     * closed; a no-op while it is open. The caller supplies the action-specific wording (post / react /
     * edit) so the 409 reads naturally for what was attempted.
     */
    public void requireOpen(Conversation conversation, String closedMessage) {
        if (isClosed(conversation)) {
            throw new ConflictException(closedMessage);
        }
    }
}
