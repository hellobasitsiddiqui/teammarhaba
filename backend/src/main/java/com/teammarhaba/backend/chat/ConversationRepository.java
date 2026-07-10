package com.teammarhaba.backend.chat;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link Conversation} (TM-435) — the shared thread root.
 *
 * <p>The lookup that matters downstream is {@link #findByEventId(Long)}: a group chat is the
 * event's single thread (the partial-unique index on {@code event_id} guarantees at most one), so
 * both the read API (TM-436) and the push fan-out (TM-437) resolve an event to its thread this way.
 * It returns an {@link Optional} precisely because that uniqueness makes "0 or 1" the only possible
 * answer — an {@code EVENT_GROUP} thread is created lazily on first use, so absence is normal.
 */
public interface ConversationRepository extends JpaRepository<Conversation, Long> {

    /**
     * The group thread for an event, if one exists. At most one row can match (the partial-unique
     * {@code event_id} index), so this is a genuine {@code Optional}, not a "first of many".
     */
    Optional<Conversation> findByEventId(Long eventId);

    /** Whether an event already has a group thread — the create-lazily guard for the fan-out. */
    boolean existsByEventId(Long eventId);

    /**
     * A user's personal {@code ADMIN_BROADCAST} channel (TM-588), if one exists. Keyed by
     * {@code (type, owner_user_id)}; the partial-unique index {@code uq_conversation_broadcast_owner}
     * makes this a genuine {@code Optional} (0 or 1). The admin-broadcast bridge
     * ({@code AdminBroadcastChatBridge}) resolves each recipient's channel this way, creating it lazily
     * on their first broadcast and reusing it thereafter.
     */
    Optional<Conversation> findByTypeAndOwnerUserId(ConversationType type, Long ownerUserId);
}
