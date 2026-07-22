package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.MessageReactionService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The message-reaction toggle under {@code /api/v1/messages/{messageId}/reactions} (TM-461; the
 * {@code /api/v1} prefix is applied by {@link ApiV1Config}). Two verbs form the toggle:
 *
 * <ul>
 *   <li>{@code POST /messages/{messageId}/reactions} — react (add the caller's emoji). The emoji is in
 *       the optional body; omit it (or send no body) to react with the default like emoji — that is how
 *       a "like" / double-tap works, no separate endpoint. Idempotent: reacting twice with the same
 *       emoji leaves one reaction.</li>
 *   <li>{@code DELETE /messages/{messageId}/reactions?emoji=…} — un-react (remove the caller's emoji).
 *       Omit {@code emoji} to remove the default like. Idempotent: removing an absent reaction is a no-op.</li>
 * </ul>
 *
 * <p>Both are <b>member-gated</b> by the service: the caller must be a non-removed member of the
 * message's thread and the thread must be open (else {@code 403} / {@code 409}); an unknown or
 * moderation-removed message is a {@code 404}. Identity is the verified {@link VerifiedUser} principal,
 * never the client — an anonymous/invalid token gets the uniform {@code 401} from the security chain.
 * Each verb returns the message's refreshed {@link MessageReactionSummary} so the client can repaint
 * that message's chips from the authoritative post-toggle state.
 */
@RestController
public class MessageReactionController {

    private final MessageReactionService reactions;

    MessageReactionController(MessageReactionService reactions) {
        this.reactions = reactions;
    }

    /** React with an emoji (body optional; omitted emoji → the default like). */
    @PostMapping("/messages/{messageId}/reactions")
    MessageReactionSummary react(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long messageId,
            @Valid @RequestBody(required = false) ReactionRequest body) {
        return reactions.react(caller, messageId, body == null ? null : body.emoji());
    }

    /** Un-react (remove this emoji; omitted emoji → the default like). */
    @DeleteMapping("/messages/{messageId}/reactions")
    MessageReactionSummary unreact(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long messageId,
            @RequestParam(required = false) @Size(max = 32) String emoji) {
        return reactions.unreact(caller, messageId, emoji);
    }
}
