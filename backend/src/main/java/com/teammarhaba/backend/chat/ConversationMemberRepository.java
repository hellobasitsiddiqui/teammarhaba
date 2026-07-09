package com.teammarhaba.backend.chat;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link ConversationMember} (TM-435) — memberships, read cursors and mute state.
 *
 * <p>The lookups the read API (TM-436) and fan-out (TM-437) need:
 *
 * <ul>
 *   <li>{@link #findByUserIdOrderByJoinedAtDesc(Long)} — <b>conversations for a user</b> (their
 *       thread list), served by the required {@code (user_id)} index.
 *   <li>{@link #findByConversationIdAndUserId(Long, Long)} — a single membership: the read API's
 *       access check and the place the read cursor ({@code lastReadAt}) is advanced.
 *   <li>{@link #findByConversationId(Long)} — <b>members of a conversation</b> (the read API's roster).
 *   <li>{@link #findByConversationIdAndMute(Long, MuteState)} — the <b>fan-out recipient set</b>:
 *       the active ({@code mute = NONE}) members a new-message push should reach.
 * </ul>
 */
public interface ConversationMemberRepository extends JpaRepository<ConversationMember, Long> {

    /** A user's thread list, newest membership first — "conversations for a user". */
    List<ConversationMember> findByUserIdOrderByJoinedAtDesc(Long userId);

    /** One membership by (conversation, user) — the access check + read-cursor update point. */
    Optional<ConversationMember> findByConversationIdAndUserId(Long conversationId, Long userId);

    /** Every member of a conversation — the thread roster. */
    List<ConversationMember> findByConversationId(Long conversationId);

    /**
     * Members of a conversation in a given mute state — called with {@link MuteState#NONE} to get
     * the fan-out recipient set (active members only; {@code READ_ONLY}/{@code REMOVED} are skipped).
     */
    List<ConversationMember> findByConversationIdAndMute(Long conversationId, MuteState mute);

    /** Whether a user is already a member of a conversation — the add-once guard. */
    boolean existsByConversationIdAndUserId(Long conversationId, Long userId);
}
