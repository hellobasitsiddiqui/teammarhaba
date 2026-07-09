package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ChatModerationService;
import jakarta.validation.Valid;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * App-admin thread moderation API under {@code /api/v1/admin/conversations} (TM-449, epic Event Chat)
 * — the backend the moderation UI calls to deal with spam or abuse in a chat thread. Like
 * {@link AdminMessageController} / {@link EventAdminController}, the whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}, so:
 *
 * <ul>
 *   <li>an anonymous caller is stopped with {@code 401} by the security chain;</li>
 *   <li>a non-admin ({@code USER}) — <b>including an event host</b>, who is only a <em>thread</em>
 *       {@code ADMIN}, never an <em>app</em> admin — gets a uniform {@code 403} (the AC: "app admins
 *       only … event hosts cannot").</li>
 * </ul>
 *
 * <p>Two moderation levers, both {@code POST} sub-actions on the thread (mirroring the
 * {@code /recall} / {@code /cancel} admin sub-action style rather than a {@code DELETE}, because
 * neither is a hard delete — the message row and the membership row are always kept):
 *
 * <ul>
 *   <li>{@code POST /admin/conversations/{conversationId}/messages/{messageId}/remove} — soft-delete a
 *       message so it drops out of every timeline read (the row is kept, never hard-deleted).</li>
 *   <li>{@code POST /admin/conversations/{conversationId}/members/{userId}/mute} — set a member's mute
 *       state (body {@link MuteMemberRequest}): {@code READ_ONLY} (can read, can't post), {@code
 *       REMOVED} (loses thread access; RSVP untouched) or {@code NONE} (reinstate).</li>
 * </ul>
 *
 * <p>A thin controller: it validates the body ({@code @Valid}) and delegates the mutation, the
 * belongs-to-thread checks and the audit to {@link ChatModerationService}. An unknown conversation /
 * message / member is a plain {@code 404} from the service (a trusted admin surface — no existence-leak
 * concern, unlike the member-facing read/post gate). Errors are RFC-7807
 * ({@code GlobalExceptionHandler}). Lives in the {@code api} package so it inherits the {@code /api/v1}
 * prefix ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/admin/conversations")
@PreAuthorize("hasRole('ADMIN')")
public class ChatModerationAdminController {

    private final ChatModerationService moderation;

    public ChatModerationAdminController(ChatModerationService moderation) {
        this.moderation = moderation;
    }

    /**
     * Remove (soft-delete) a message from a thread. The message must belong to {@code conversationId}
     * (else {@code 404}), so the path can't be used to remove another thread's message. Idempotent —
     * re-removing an already-removed message succeeds and returns the original {@code removedAt}. The
     * acting admin (from the verified token) is attributed on the audit row.
     */
    @PostMapping("/{conversationId}/messages/{messageId}/remove")
    public RemovedMessageResponse removeMessage(
            @PathVariable Long conversationId,
            @PathVariable Long messageId,
            @AuthenticationPrincipal VerifiedUser admin) {
        return RemovedMessageResponse.from(moderation.removeMessage(admin, conversationId, messageId));
    }

    /**
     * Set a thread member's mute / removal state. The user must be a member of {@code conversationId}
     * (else {@code 404}). Muting never touches the member's event RSVP — a {@code REMOVED} member is
     * still "going". The acting admin (from the verified token) is attributed on the audit row.
     */
    @PostMapping("/{conversationId}/members/{userId}/mute")
    public MemberMuteResponse muteMember(
            @PathVariable Long conversationId,
            @PathVariable Long userId,
            @RequestBody @Valid MuteMemberRequest request,
            @AuthenticationPrincipal VerifiedUser admin) {
        return MemberMuteResponse.from(moderation.muteMember(admin, conversationId, userId, request.state()));
    }
}
