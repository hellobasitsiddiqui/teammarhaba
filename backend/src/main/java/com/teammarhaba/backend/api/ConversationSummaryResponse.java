package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationType;
import com.teammarhaba.backend.chat.Message;
import java.time.Instant;

/**
 * One row in the caller's conversation list (TM-436) — the shape the app's single "chat" section
 * renders per thread: what kind of thread it is, a human title, a one-line last-message preview, the
 * caller's unread count, and (for an event chat) which event it belongs to. A DTO, never the JPA
 * entity, so the HTTP contract is decoupled from the {@link Conversation} mapping and stays
 * reviewable in {@code openapi.json}.
 *
 * <p><b>Derived title</b> — a thread has no stored name; the title is derived per {@link
 * ConversationType}: an {@code EVENT_GROUP} borrows its event's heading (resolved through {@code
 * EventRepository}; a soft-deleted/missing event falls back to a generic label), and an {@code
 * ADMIN_BROADCAST} is the fixed {@link #ADMIN_BROADCAST_TITLE}. The service computes it and passes it
 * in — this DTO never reaches back into the event aggregate.
 *
 * <p><b>Unread</b> is the count of live messages created after the caller's {@code last_read_at}
 * cursor (a never-read member sees every live message as unread); it is computed per-caller by the
 * service, so the same thread can carry a different {@code unreadCount} for two members.
 *
 * <p><b>Ordering key</b> — {@code lastActiveAt} is the thread's most-recent activity: the last live
 * message's instant, or the thread's own creation instant while it has no messages yet. The list is
 * sorted by it (most-recently-active first), and it is surfaced so a client can show "· 3m" without a
 * second call.
 *
 * @param id                the thread's surrogate id (used by the messages / mark-read routes)
 * @param type              whether this is an {@code EVENT_GROUP} or an {@code ADMIN_BROADCAST}
 * @param title             the derived, display-ready thread title (see class doc)
 * @param eventId           the event this group chat belongs to; {@code null} for an admin broadcast
 * @param lastMessagePreview a short snippet of the newest live message (capped at {@link
 *                          #MAX_PREVIEW_LENGTH}); {@code null} while the thread is silent
 * @param lastMessageAt     when that newest live message was posted; {@code null} while silent
 * @param unreadCount       live messages newer than the caller's read cursor (see class doc)
 * @param lastActiveAt      the thread's last-activity instant — the list's sort key (see class doc)
 * @param notificationsMuted whether the caller has self-muted THIS thread's push (TM-471) — the row
 *                          still shows (they see the thread), just flagged so the UI can mark it muted
 * @param left              whether the caller has self-left this thread (TM-471) while still attending;
 *                          the row is kept so the list can offer a rejoin affordance, but it renders as
 *                          a de-emphasised "you left — rejoin" row rather than an openable thread
 */
public record ConversationSummaryResponse(
        Long id,
        ConversationType type,
        String title,
        Long eventId,
        String lastMessagePreview,
        Instant lastMessageAt,
        long unreadCount,
        Instant lastActiveAt,
        boolean notificationsMuted,
        boolean left) {

    /** The fixed title for an {@code ADMIN_BROADCAST} thread — the "from TeamMarhaba" channel. */
    public static final String ADMIN_BROADCAST_TITLE = "Circle";

    /** Fallback title for an {@code EVENT_GROUP} whose event is missing/soft-deleted. */
    public static final String EVENT_GROUP_FALLBACK_TITLE = "Event chat";

    /** Cap on the last-message preview length; longer bodies are truncated with an ellipsis. */
    public static final int MAX_PREVIEW_LENGTH = 140;

    /**
     * Assemble a list row from its parts. {@code title} and {@code unreadCount} are computed by the
     * service (they need the event aggregate / the caller's cursor); {@code lastMessage} is the
     * thread's newest live message ({@code null} while silent) and drives both the preview and
     * {@code lastMessageAt}; {@code lastActiveAt} is the pre-computed sort key; {@code
     * notificationsMuted}/{@code left} are the caller's own self-service membership flags (TM-471).
     */
    public static ConversationSummaryResponse of(
            Conversation conversation,
            String title,
            Message lastMessage,
            long unreadCount,
            Instant lastActiveAt,
            boolean notificationsMuted,
            boolean left) {
        return new ConversationSummaryResponse(
                conversation.getId(),
                conversation.getType(),
                title,
                conversation.getEventId(),
                lastMessage == null ? null : preview(lastMessage.getBody()),
                lastMessage == null ? null : lastMessage.getCreatedAt(),
                unreadCount,
                lastActiveAt,
                notificationsMuted,
                left);
    }

    /** Truncate a message body to {@link #MAX_PREVIEW_LENGTH}, appending an ellipsis when clipped. */
    private static String preview(String body) {
        if (body == null || body.length() <= MAX_PREVIEW_LENGTH) {
            return body;
        }
        return body.substring(0, MAX_PREVIEW_LENGTH) + "…";
    }
}
