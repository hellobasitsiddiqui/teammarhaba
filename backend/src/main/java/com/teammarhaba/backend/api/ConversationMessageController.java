package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.MessageReactionService;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The thread-messages read projection under {@code /api/v1/conversations/{conversationId}/messages}
 * (TM-461; the {@code /api/v1} prefix is applied by {@link ApiV1Config}). This is the F2 / C2 read
 * path each message rides with its reaction summary — the timeline of a thread's live messages,
 * newest-first, each carrying its {@code emoji → count} tally and a per-emoji "did the caller react"
 * flag ({@link ThreadMessageResponse}).
 *
 * <p><b>Member-gated:</b> the caller must be a non-removed member of the thread (else {@code 403}); an
 * unknown thread is a {@code 404}. A closed thread stays readable — the soft-close freezes writes, not
 * history. Identity is the verified {@link VerifiedUser} principal; an anonymous/invalid token gets the
 * uniform {@code 401} from the security chain.
 *
 * <p>Order is fixed newest-first (only {@code page}/{@code size} are caller-tunable — no {@code sort}
 * param, so an unknown sort query is simply ignored, never a {@code 400}), paged via the shared list
 * convention ({@link PageRequests}).
 */
@RestController
public class ConversationMessageController {

    /** Fixed timeline order: newest-first, {@code id} the deterministic same-{@code createdAt} tiebreak. */
    private static final Sort NEWEST_FIRST = Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id"));

    private final MessageReactionService reactions;

    ConversationMessageController(MessageReactionService reactions) {
        this.reactions = reactions;
    }

    /** A page of a thread's live messages, newest-first, each with its reaction summary. */
    @GetMapping("/conversations/{conversationId}/messages")
    PageResponse<ThreadMessageResponse> messages(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long conversationId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return reactions.threadMessages(
                caller, conversationId, PageRequests.of(page, size, null, Set.of(), NEWEST_FIRST));
    }
}
