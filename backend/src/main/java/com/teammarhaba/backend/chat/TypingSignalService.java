package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.TypingSignal;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;

/**
 * The event-chat <b>typing indicator</b> signal path (TM-465, epic Event Chat wave-2) — the
 * client→server half of "X is typing…". It is the transient companion to the durable write path
 * ({@link MessagePostService}): where a posted message is persisted, pushed and broadcast, a typing
 * signal is <b>ephemeral</b> — it is <em>never</em> written to the database, never pushed, and only
 * fanned out over the live SSE transport to members currently connected to the thread. There is nothing
 * to re-sync: a member who wasn't connected simply never saw it, and a reconnect starts with no typists.
 *
 * <h2>Why a lightweight POST, not a socket message</h2>
 *
 * SSE (TM-464) is one-way (server→client), so the client can't push a typing signal <em>up</em> the
 * stream. Rather than introduce a WebSocket just for this, the client signals with an ordinary
 * authenticated POST ({@code POST /conversations/{id}/typing}), <b>debounced</b> client-side to at most
 * one call every few seconds while composing (never per-keystroke). The server then fans the signal back
 * <em>down</em> the existing SSE streams to the thread's other members. This reuses the whole existing
 * auth + membership stack unchanged and adds no new transport.
 *
 * <h2>The gate (per the AC)</h2>
 *
 * Signalling is <b>member-gated</b> exactly like subscribing to the stream: {@link
 * ConversationReadService#assertMember} re-applies the read gate, so a non-member, a kicked
 * ({@link MuteState#REMOVED}) member, a self-left member and an unknown/foreign thread are all a uniform
 * {@code 403} ({@link AccessDeniedException}) — a typing POST can't be used to probe which thread ids
 * exist, and only a member the thread is visible to can announce typing. (A {@link MuteState#READ_ONLY}
 * muted member may still signal: typing is a read-side presence signal, not a posted message — mirroring
 * how a read-only member may still react.)
 *
 * <h2>Fan-out — to OTHERS, never the sender (per the AC)</h2>
 *
 * The signal is broadcast over {@link ChatStreamService#broadcastExcluding} with the caller's own uid
 * excluded, so it reaches every OTHER connected member of the thread but is never echoed back to the
 * typist's own stream (a client must not render "you are typing"). Like every live broadcast this is
 * best-effort and single-instance (see {@link ChatStreamService}); a member not reached live simply
 * doesn't see the indicator — which, for a transient hint, is entirely lossless.
 *
 * <p><b>Identity is always the verified caller.</b> The typist is resolved from the {@link VerifiedUser}
 * principal via {@link UserService#provision}, never a client-supplied id, so the broadcast can only ever
 * name the caller themselves.
 */
@Service
public class TypingSignalService {

    private final ConversationReadService conversations;
    private final UserService users;
    private final ChatStreamService streams;

    TypingSignalService(ConversationReadService conversations, UserService users, ChatStreamService streams) {
        this.conversations = conversations;
        this.users = users;
        this.streams = streams;
    }

    /**
     * Signal that the verified caller is (or has stopped) typing in thread {@code conversationId}, and
     * broadcast that transient {@code typing} event over SSE to the thread's OTHER connected members.
     * Nothing is persisted. Member-gated: a non-member / kicked / self-left member and an unknown thread
     * are all a uniform {@code 403}.
     *
     * @param caller         the verified principal — the typist (identity is never client-supplied)
     * @param conversationId the thread being typed in
     * @param typing         {@code true} = started/continuing to type; {@code false} = explicitly stopped
     * @throws AccessDeniedException {@code 403} if the caller is not an active member of the thread
     */
    public void signal(VerifiedUser caller, Long conversationId, boolean typing) {
        // Gate first: only a member the thread is visible to may announce typing (same rule as the stream
        // subscription). Throws AccessDeniedException (-> 403) for a non-member / kicked / unknown thread.
        conversations.assertMember(caller, conversationId);

        // Resolve the typist's identity + display name for the label. provision() is just-in-time and, for
        // an already-signed-in caller, a plain read of their existing row.
        User typist = users.provision(caller);

        // Fan out to the thread's OTHER connected members, excluding the typist's own stream (by uid) so a
        // client never receives — and never has to filter — its own typing signal. Best-effort + ephemeral.
        streams.broadcastExcluding(
                conversationId, ChatStreamService.EVENT_TYPING, TypingSignal.of(typist, typing), caller.uid());
    }
}
