package com.teammarhaba.backend.chat;

import java.time.Duration;
import java.util.Collection;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * The live-while-online chat transport hub (TM-464, epic Event Chat wave-3) — an <b>in-memory,
 * per-instance registry of open Server-Sent-Events streams</b>, keyed by conversation id. It is the
 * live sibling of the store-and-forward path: {@link NewMessageNotifier} (TM-437) already pushes to
 * <em>offline</em> members over FCM, and this hub streams the same message to the <em>connected</em>
 * members of a thread so an open app sees it appear without a poll.
 *
 * <h2>Why SSE, not WebSocket (the transport choice)</h2>
 *
 * The live chat need is <b>one-way</b>: the server tells connected clients "a new message landed".
 * The reverse direction (posting) already has a plain REST endpoint ({@code POST
 * /conversations/{id}/messages}, TM-447), so there is nothing to send <em>up</em> the socket. SSE is
 * therefore the simplest transport that satisfies the AC:
 *
 * <ul>
 *   <li>it is ordinary HTTP {@code text/event-stream} — it rides the <b>existing Firebase-bearer auth
 *       chain unchanged</b> (the connect request is authenticated exactly like every other {@code
 *       /api/v1} call; see {@code ConversationStreamController}), where a raw WebSocket upgrade would
 *       need a separate auth handshake;</li>
 *   <li>the browser reconnects automatically, which is precisely the graceful-fallback behaviour the
 *       AC wants (see below);</li>
 *   <li>no new protocol, dependency, or filter — a {@link SseEmitter} is core Spring MVC.</li>
 * </ul>
 *
 * WebSocket only earns its extra complexity once we need low-latency client→server signals
 * (typing/presence heartbeats); that is deferred (see the scaling note).
 *
 * <h2>Cloud Run reality — this is a single-instance fan-out (the load-bearing caveat)</h2>
 *
 * The app runs on Cloud Run, which <b>horizontally scales across stateless instances</b>. This
 * registry lives in <b>one JVM's heap</b>, so it only reaches the streams <em>terminated on the same
 * instance</em>. If instance A holds Alice's open stream and Bob's {@code POST} is routed to instance
 * B, B's {@link #broadcast} sees an empty local registry and Alice gets <b>nothing over the socket on
 * that hop</b>. Two things keep that correct rather than lossy:
 *
 * <ol>
 *   <li><b>The socket is never the system of record.</b> Every message is durably written (TM-435)
 *       and also fanned out over FCM (TM-437) before this broadcast runs, so a member who missed the
 *       live event still gets the push and the message on their next {@code fetch-on-open} / reconnect
 *       re-sync via the read API (TM-436). This hub is a pure latency optimisation — "no message is
 *       only ever delivered over the socket" (an explicit AC).</li>
 *   <li><b>Cross-instance fan-out is deliberately deferred.</b> Making a live event reach a member on
 *       <em>any</em> instance needs a shared bus — publish each new message to Cloud Pub/Sub (or
 *       Redis pub/sub) and have every instance re-broadcast to its local streams. That backbone (plus
 *       durable presence) is its own follow-up, <b>TM-505 "realtime scaling &amp; backbone"</b>; this
 *       ticket ships the minimal working slice and does not build it. Until then the live path is
 *       fully correct on a single instance (or with session affinity / {@code min==max==1}) and
 *       degrades to store-and-forward when a message and a stream land on different instances.</li>
 * </ol>
 *
 * <p>The other Cloud Run limit — the per-request timeout (default 5 min, max 60 min) caps how long
 * one stream can stay open — is handled by {@link #STREAM_TIMEOUT} (set below the platform cap) plus
 * the {@link #heartbeat()} keep-alive; when a stream times out the client simply reconnects and
 * re-syncs, so a capped connection is invisible to the user.
 *
 * <h2>Thread-safety</h2>
 *
 * Streams are opened on request threads and closed from container callbacks and the heartbeat, all
 * concurrently, so the registry is a {@link ConcurrentHashMap} of {@link CopyOnWriteArraySet}s: the
 * set tolerates iteration (broadcast/heartbeat) racing with add/remove (open/close) without locking,
 * which suits a small, read-mostly, churn-light per-thread membership.
 */
@Service
public class ChatStreamService {

    private static final Logger log = LoggerFactory.getLogger(ChatStreamService.class);

    /**
     * How long a single SSE stream is held open before the server completes it and the client
     * reconnects. Kept well under Cloud Run's request cap (default 5 min, max 60 min) so the platform
     * never severs it mid-frame; the client's automatic reconnect + read-API re-sync makes the
     * recycle invisible. A timed-out stream is not an error — it is the expected lifecycle.
     */
    static final long STREAM_TIMEOUT = Duration.ofMinutes(4).toMillis();

    /**
     * Keep-alive cadence. Idle HTTP connections are dropped by proxies/load balancers well before the
     * stream timeout, so the {@link #heartbeat()} writes an SSE comment ({@code :keep-alive}) to every
     * open stream on this interval — traffic that keeps the pipe warm without firing a client event.
     * It also prunes any stream that has died since (a write throws), so dead entries never accumulate.
     */
    private static final long HEARTBEAT_INTERVAL_MS = 20_000L;

    /** The SSE event name carrying a newly-created chat message (the payload is a ConversationMessageResponse). */
    public static final String EVENT_MESSAGE = "message";

    /** The event name of the initial confirmation frame sent the instant a stream opens. */
    private static final String EVENT_OPEN = "open";

    /**
     * conversation id → the set of streams currently open <em>on this instance</em> for that thread.
     * A {@link CopyOnWriteArraySet} so a broadcast can iterate while opens/closes mutate concurrently.
     * Empty sets are pruned by the heartbeat, so a quiet thread leaves no residue.
     */
    private final Map<Long, Collection<SseEmitter>> streamsByConversation = new ConcurrentHashMap<>();

    /**
     * Open a live stream for {@code conversationId} and register it for broadcasts. The caller
     * ({@code ConversationStreamController}) has already authenticated the request and gated it on
     * thread membership, so this method is transport-only: it never re-checks access.
     *
     * <p>An initial {@link #EVENT_OPEN} frame is sent immediately so the client can confirm the
     * subscription is live (and so a proxy sees bytes right away). If the client has already vanished,
     * the failed send simply deregisters the stream — a no-op subscription.
     *
     * @param conversationId the thread the caller is a member of
     * @return the open {@link SseEmitter} for the controller to return to Spring MVC
     */
    public SseEmitter open(long conversationId) {
        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT);
        register(conversationId, emitter);
        try {
            // A first frame confirms the stream end-to-end and flushes headers through any proxy.
            emitter.send(SseEmitter.event()
                    .name(EVENT_OPEN)
                    .data(Map.of("conversationId", conversationId), MediaType.APPLICATION_JSON));
        } catch (Exception e) {
            // The client hung up between connect and this first write — drop the just-registered stream.
            remove(conversationId, emitter);
        }
        return emitter;
    }

    /**
     * Register {@code emitter} under {@code conversationId} and wire its lifecycle callbacks so it
     * deregisters itself the moment the container completes, times out, or errors it. Package-private
     * so a unit test can register a fake/mock emitter without going through the servlet stack.
     */
    void register(long conversationId, SseEmitter emitter) {
        streamsByConversation
                .computeIfAbsent(conversationId, key -> new CopyOnWriteArraySet<>())
                .add(emitter);
        // Any terminal state removes the stream from the registry so broadcasts never touch a dead one.
        emitter.onCompletion(() -> remove(conversationId, emitter));
        emitter.onError(error -> remove(conversationId, emitter));
        emitter.onTimeout(() -> {
            emitter.complete(); // completing fires onCompletion, which also removes — but be explicit
            remove(conversationId, emitter);
        });
    }

    /**
     * Broadcast {@code data} as a named SSE event to every stream currently open <em>on this
     * instance</em> for {@code conversationId}. This is the live half of the new-message fan-out: it
     * is invoked from the post seam ({@link MessagePostService}) right after the durable write + FCM
     * fan-out, so a connected member sees the message appear instantly while an offline one still gets
     * the push. A stream that rejects the write (client gone / already completed) is dropped in place;
     * that member re-syncs over the read API on reconnect, so a broken pipe is never fatal.
     *
     * @return how many streams the event was delivered to (0 when none are open here — the common
     *     case on an instance that holds no subscriber for this thread)
     */
    public int broadcast(long conversationId, String eventName, Object data) {
        Collection<SseEmitter> streams = streamsByConversation.get(conversationId);
        if (streams == null || streams.isEmpty()) {
            return 0; // nobody connected here — the offline path (push + fetch-on-open) still delivers
        }
        int delivered = 0;
        for (SseEmitter emitter : streams) {
            try {
                emitter.send(SseEmitter.event().name(eventName).data(data, MediaType.APPLICATION_JSON));
                delivered++;
            } catch (Exception e) {
                // IOException (client gone) or IllegalStateException (stream already completed): drop it.
                dropQuietly(streams, emitter);
            }
        }
        log.debug("Live broadcast '{}' to conversation {}: delivered to {} stream(s).", eventName, conversationId, delivered);
        return delivered;
    }

    /** How many streams are open on this instance for {@code conversationId} (0 if none) — for tests / observability. */
    public int connectionCount(long conversationId) {
        Collection<SseEmitter> streams = streamsByConversation.get(conversationId);
        return streams == null ? 0 : streams.size();
    }

    /**
     * Keep every open stream warm and prune dead ones (TM-464). Proxies drop idle HTTP connections
     * long before {@link #STREAM_TIMEOUT}, so an SSE comment is written to each stream on
     * {@link #HEARTBEAT_INTERVAL_MS}; a comment is invisible to the client's event handlers but is
     * enough traffic to hold the connection. Like every {@code @Scheduled} job here this runs per
     * instance over that instance's own streams (see {@code SchedulingConfig}) and has no side effects
     * beyond keep-alive/cleanup, so it needs no cross-instance coordination.
     */
    @Scheduled(fixedRate = HEARTBEAT_INTERVAL_MS)
    void heartbeat() {
        streamsByConversation.forEach((conversationId, streams) -> {
            for (SseEmitter emitter : streams) {
                try {
                    emitter.send(SseEmitter.event().comment("keep-alive"));
                } catch (Exception e) {
                    dropQuietly(streams, emitter);
                }
            }
            // A thread nobody is connected to any more leaves no residual key.
            streams.remove(null); // no-op guard; sets never hold null, keeps intent explicit
            if (streams.isEmpty()) {
                streamsByConversation.remove(conversationId, streams);
            }
        });
    }

    /** Complete + forget a stream, swallowing any error from an already-dead emitter. */
    private void dropQuietly(Collection<SseEmitter> streams, SseEmitter emitter) {
        streams.remove(emitter);
        try {
            emitter.complete();
        } catch (Exception ignored) {
            // Already completed/errored — nothing to do.
        }
    }

    /** Remove {@code emitter} from {@code conversationId}'s set (called from the lifecycle callbacks). */
    private void remove(long conversationId, SseEmitter emitter) {
        Collection<SseEmitter> streams = streamsByConversation.get(conversationId);
        if (streams != null) {
            streams.remove(emitter);
        }
    }
}
