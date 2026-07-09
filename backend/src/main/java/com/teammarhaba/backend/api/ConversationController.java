package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ConversationReadService;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
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
 *       (oldest→newest), paged; members-only, excludes moderation-removed messages.</li>
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

    ConversationController(ConversationReadService conversations) {
        this.conversations = conversations;
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

    /** Advance the caller's read cursor for the thread; returns the fresh cursor + unread count. */
    @PostMapping("/conversations/{id}/read")
    MarkReadResponse markRead(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return conversations.markRead(caller, id);
    }
}
