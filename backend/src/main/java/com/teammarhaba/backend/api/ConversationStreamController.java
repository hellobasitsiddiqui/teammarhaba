package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ChatStreamService;
import com.teammarhaba.backend.chat.ConversationReadService;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * The live-chat subscription endpoint (TM-464) — the client's half of the real-time transport. It
 * opens a long-lived Server-Sent-Events stream over which the server pushes new messages for a single
 * thread as they are posted, so an open app renders them live instead of polling. The {@code /api/v1}
 * prefix is applied by {@link ApiV1Config}; the actual streaming/fan-out is owned by
 * {@link ChatStreamService} (see its class doc for the SSE-vs-WebSocket choice and the Cloud Run
 * single-instance caveat).
 *
 * <p><b>Auth on connect (an AC).</b> This is an ordinary authenticated {@code /api/v1} route, so the
 * existing security chain (TM-79) verifies the caller's Firebase bearer token before the handler runs
 * — an anonymous/expired token is the uniform {@code 401}, exactly like every other API call. There
 * is no bespoke socket handshake to secure.
 *
 * <p><b>A client subscribes only to threads it is a member of (an AC).</b> Before any stream is
 * opened, {@link ConversationReadService#assertMember} re-applies the same membership gate the read
 * API uses: a non-member, a kicked ({@code REMOVED}) member, and an unknown/foreign thread are all a
 * uniform {@code 403} (thrown synchronously, before the async stream starts, so it maps to a normal
 * error response — the id can't be probed). Only once membership is proven does the request go async
 * and the stream open.
 *
 * <p><b>Delivery contract.</b> The stream is a pure latency optimisation layered on store-and-forward
 * (durable write + FCM push + fetch-on-open). A dropped/timed-out stream loses nothing: the client
 * reconnects and re-syncs the thread over the read API (TM-436), and every message was already
 * persisted and pushed. See {@link ChatStreamService} for why nothing is ever delivered <em>only</em>
 * over the socket.
 */
@RestController
public class ConversationStreamController {

    private final ConversationReadService conversations;
    private final ChatStreamService streams;

    ConversationStreamController(ConversationReadService conversations, ChatStreamService streams) {
        this.conversations = conversations;
        this.streams = streams;
    }

    /**
     * Open a live SSE stream for thread {@code id}. Emits an {@code open} confirmation frame
     * immediately, then a {@code message} event per newly-posted message; a {@code :keep-alive}
     * comment holds the connection between messages. Members-only ({@code 403} otherwise), auth
     * required ({@code 401} otherwise).
     *
     * <p>No {@code produces} constraint is declared: the app ignores the {@code Accept} header and
     * defaults negotiation to JSON ({@code WebJsonConfig}, TM-126), so a {@code produces =
     * text/event-stream} mapping could never be matched (it would 406 on the JSON default). Instead the
     * {@link SseEmitter} return value handler sets {@code Content-Type: text/event-stream} on the
     * response itself and streams past content negotiation entirely.
     *
     * @param caller the verified principal (never client-supplied) — identity for the membership gate
     * @param id     the conversation to subscribe to
     * @return the open {@link SseEmitter}; Spring MVC keeps the response streaming until it completes
     */
    @GetMapping("/conversations/{id}/stream")
    SseEmitter stream(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        // Gate first (synchronous): only a member of this thread may subscribe. Throws AccessDeniedException
        // (-> 403) before the request goes async, so a non-member never opens a stream.
        conversations.assertMember(caller, id);
        return streams.open(id);
    }
}
