package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ConversationReadService;
import com.teammarhaba.backend.chat.MessagePostService;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import jakarta.validation.Valid;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's chat read API (TM-436) — the read half of the conversation model (TM-435) the app's
 * single "chat" section renders. The {@code /api/v1} prefix is applied by {@link ApiV1Config}.
 *
 * <p>Every route requires a signed-in caller — an anonymous/invalid token gets the uniform RFC 7807
 * {@code 401} from the security chain (default-deny). Identity comes from the verified {@link
 * VerifiedUser} principal, never the client, so a caller only ever sees their own chat; the thread
 * and mark-read routes additionally require thread membership ({@code 403} otherwise — a non-member,
 * a kicked member, or an unknown thread are indistinguishable so ids can't be probed).
 *
 * <ul>
 *   <li>{@code GET /me/conversations} — the caller's threads, most-recently-active first, paged.
 *       Order is fixed (only {@code page}/{@code size} are caller-tunable).</li>
 *   <li>{@code GET /conversations/{id}/messages} — one thread's live messages, chronological
 *       (oldest→newest), paged; members-only, excludes moderation-removed messages, each with its
 *       reaction summary (TM-461).</li>
 *   <li>{@code POST /conversations/{id}/messages} — post a new message to the thread (TM-447);
 *       stricter than reading — only an active (non-removed, non-muted) member may post, and only
 *       while the thread is open (a closed / read-only thread is a {@code 409}). Returns the created
 *       message ({@code 201}) and fans a push out to the thread's other active members.</li>
 *   <li>{@code POST /conversations/{id}/read} — advance the caller's read cursor; returns the fresh
 *       cursor + recomputed unread count.</li>
 * </ul>
 */
@RestController
public class ConversationController {

    /**
     * Thread-timeline order: chronological (oldest→newest), with {@code id} as a deterministic
     * same-{@code createdAt} tiebreak. Fixed — the messages route binds only {@code page}/{@code
     * size} (no {@code Pageable}), so the order is not caller-overridable; an unknown query param such
     * as {@code ?sort=…} is simply ignored (still {@code 200}s), never a {@code 400}.
     */
    private static final Sort CHRONOLOGICAL = Sort.by(Sort.Order.asc("createdAt"), Sort.Order.asc("id"));

    private final ConversationReadService conversations;
    private final MessagePostService posts;

    ConversationController(ConversationReadService conversations, MessagePostService posts) {
        this.conversations = conversations;
        this.posts = posts;
    }

    /** The caller's conversation list, most-recently-active first. Only {@code page}/{@code size} tune it. */
    @GetMapping("/me/conversations")
    PageResponse<ConversationSummaryResponse> list(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        // The list sort ("most-recently-active first") is applied in-memory by the service, so no sort
        // is passed through here — page/size only, unsorted Pageable used just for the window bounds.
        return conversations.list(caller, PageRequests.of(page, size, null, Set.of(), Sort.unsorted()));
    }

    /** One thread's live messages, chronological and paged. Members-only ({@code 403} otherwise). */
    @GetMapping("/conversations/{id}/messages")
    PageResponse<ConversationMessageResponse> messages(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return conversations.messages(caller, id, PageRequests.of(page, size, null, Set.of(), CHRONOLOGICAL));
    }

    /**
     * Post a new message to the thread (TM-447). Member + open-thread gated in the service; the body is
     * validated (non-blank, ≤ 500 chars) before it gets here. An optional {@code replyToMessageId}
     * (TM-466) quotes an earlier message in the same thread — the service validates it names a live,
     * same-thread message ({@code 400} otherwise). Returns the created message ({@code 201}, carrying
     * the quoted-parent snippet when it's a reply), which also triggers the push fan-out to the thread's
     * other active members.
     */
    @PostMapping("/conversations/{id}/messages")
    @ResponseStatus(HttpStatus.CREATED)
    ConversationMessageResponse post(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @Valid @RequestBody PostMessageRequest body) {
        return posts.post(caller, id, body.body(), body.replyToMessageId());
    }

    /** Advance the caller's read cursor for the thread; returns the fresh cursor + unread count. */
    @PostMapping("/conversations/{id}/read")
    MarkReadResponse markRead(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return conversations.markRead(caller, id);
    }
}
