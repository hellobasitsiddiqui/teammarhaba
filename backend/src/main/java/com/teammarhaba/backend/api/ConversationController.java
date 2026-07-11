package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ConversationMembershipService;
import com.teammarhaba.backend.chat.ConversationReadService;
import com.teammarhaba.backend.chat.MessageAuthorService;
import com.teammarhaba.backend.chat.MessagePostService;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
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
 *   <li>{@code PATCH /conversations/{id}/messages/{messageId}} — edit your OWN message (TM-467):
 *       owner-scoped (a non-author is a {@code 403}), only while the thread is open ({@code 409}
 *       closed) and only within the ~5-minute edit window ({@code 409} once locked). Rewrites the body
 *       + stamps {@code editedAt}, returns the edited message, and re-renders it live over the SSE
 *       transport (TM-464) — no push.</li>
 *   <li>{@code DELETE /conversations/{id}/messages/{messageId}} — delete your OWN message (TM-467):
 *       owner-scoped (a non-author is a {@code 403}), allowed anytime. Soft-deletes it (so it drops
 *       out of the timeline like an admin moderation removal) and drops it live over SSE.</li>
 *   <li>{@code POST /conversations/{id}/read} — advance the caller's read cursor; returns the fresh
 *       cursor + recomputed unread count.</li>
 *   <li>{@code POST /conversations/{id}/mute} · {@code /unmute} · {@code /leave} · {@code /rejoin} —
 *       member self-service over the caller's OWN membership (TM-471): silence / restore this thread's
 *       push, and leave / rejoin the thread — all WITHOUT changing the caller's event RSVP. Each
 *       returns the caller's fresh membership state ({@code ConversationMembershipResponse}). Distinct
 *       from admin moderation and from un-RSVPing the event; owner-scoped, so a non-member / kicked
 *       member / unknown thread is a uniform {@code 403}.</li>
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
    private final MessageAuthorService authorMessages;
    private final ConversationMembershipService memberships;

    ConversationController(
            ConversationReadService conversations,
            MessagePostService posts,
            MessageAuthorService authorMessages,
            ConversationMembershipService memberships) {
        this.conversations = conversations;
        this.posts = posts;
        this.authorMessages = authorMessages;
        this.memberships = memberships;
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

    /**
     * The caller's aggregate unread across all their threads (TM-582) — one number for the Chat-tab
     * badge (TM-439). A distinct, un-paged route (not a field on the paged list) so the badge is
     * correct even when the caller has more than one page of threads: summing the list's per-thread
     * {@code unreadCount} only ever saw the first page and undercounted. Caller-scoped like the list.
     */
    @GetMapping("/me/conversations/unread-total")
    UnreadTotalResponse unreadTotal(@AuthenticationPrincipal VerifiedUser caller) {
        return new UnreadTotalResponse(conversations.unreadTotal(caller));
    }

    /**
     * The thread's mentionable roster (TM-469) — its active members except the caller, each as
     * {@code (userId, displayName, role)} — the candidate list the composer's @mention autocomplete
     * draws from. Members-only ({@code 403} otherwise), so it can't be used to probe threads the caller
     * isn't in.
     */
    @GetMapping("/conversations/{id}/members")
    List<ConversationMemberResponse> members(
            @AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return conversations.roster(caller, id);
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

    /**
     * Edit the caller's OWN message (TM-467). Owner-scoped in the service — a non-author is a {@code 403}
     * — and additionally gated on the thread being open ({@code 409} closed) and the edit being within
     * the ~5-minute window ({@code 409} once locked); a message that isn't a live message of this thread
     * is a {@code 404}. The replacement body is validated (non-blank, ≤ 500) before it gets here. Returns
     * the edited message (with its {@code editedAt} now set) and re-renders it live over SSE (TM-464).
     */
    @PatchMapping("/conversations/{id}/messages/{messageId}")
    ConversationMessageResponse editMessage(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @PathVariable Long messageId,
            @Valid @RequestBody EditMessageRequest body) {
        return authorMessages.editOwnMessage(caller, id, messageId, body.body());
    }

    /**
     * Delete the caller's OWN message (TM-467). Owner-scoped in the service — a non-author is a {@code
     * 403} — and allowed anytime (no open-thread / window gate); a message that isn't a live message of
     * this thread is a {@code 404}. Soft-deletes it (it drops out of the timeline) and drops it live over
     * SSE. Returns a thin acknowledgement ({@link RemovedMessageResponse}).
     */
    @DeleteMapping("/conversations/{id}/messages/{messageId}")
    RemovedMessageResponse deleteMessage(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @PathVariable Long messageId) {
        return authorMessages.deleteOwnMessage(caller, id, messageId);
    }

    /** Advance the caller's read cursor for the thread; returns the fresh cursor + unread count. */
    @PostMapping("/conversations/{id}/read")
    MarkReadResponse markRead(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return conversations.markRead(caller, id);
    }

    /**
     * Self-mute this thread's push (TM-471): the caller stays an active, visible member (can read +
     * post) but the new-message fan-out skips them. Owner-scoped; returns the caller's fresh membership
     * state. A non-member / kicked member / unknown thread is a {@code 403}.
     */
    @PostMapping("/conversations/{id}/mute")
    ConversationMembershipResponse mute(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return memberships.mute(caller, id);
    }

    /** Un-mute this thread's push (TM-471) — the inverse of {@link #mute}. Owner-scoped. */
    @PostMapping("/conversations/{id}/unmute")
    ConversationMembershipResponse unmute(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return memberships.unmute(caller, id);
    }

    /**
     * Self-leave this thread (TM-471): hide/exit it while the caller's event RSVP is unchanged (still
     * GOING). Owner-scoped; the organiser can't leave their own thread ({@code 409}). Returns the
     * caller's fresh membership state.
     */
    @PostMapping("/conversations/{id}/leave")
    ConversationMembershipResponse leave(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return memberships.leave(caller, id);
    }

    /**
     * Self-rejoin a thread the caller had left (TM-471) — available while they still attend the event
     * ({@code 409} otherwise). Owner-scoped; returns the caller's fresh membership state.
     */
    @PostMapping("/conversations/{id}/rejoin")
    ConversationMembershipResponse rejoin(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return memberships.rejoin(caller, id);
    }
}
