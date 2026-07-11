package com.teammarhaba.backend.chat;

import java.time.Duration;
import java.util.Collection;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
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

    /**
     * The SSE event name carrying an <b>edited</b> chat message (TM-467) — the author rewrote the body.
     * The payload is the edited {@link com.teammarhaba.backend.api.ConversationMessageResponse}, but a
     * connected client treats it as a PATCH (it applies only the new {@code body} + {@code editedAt} to
     * the message it already holds, preserving that message's reactions / receipt / reply quote) rather
     * than as a fresh bubble — which is why it rides its own event name instead of {@link #EVENT_MESSAGE}
     * (whose consumer upserts a whole row and would otherwise clobber those side-channels on an edit).
     * Like every live frame it is a pure latency optimisation: a client that misses it re-syncs the new
     * body over the read API on its next poll / reconnect.
     */
    public static final String EVENT_MESSAGE_EDITED = "message-edited";

    /**
     * The SSE event name carrying a <b>deleted</b> chat message (TM-467) — the author removed their own
     * message (a soft-delete, so it drops out of the timeline). The payload is a small
     * {@link com.teammarhaba.backend.api.RemovedMessageResponse} ({@code messageId} + {@code
     * conversationId}); a connected client drops that message from its open thread by id. Best-effort
     * like every live frame — a client that misses it simply stops seeing the message on its next
     * re-sync (the read filters {@code deleted_at IS NULL}).
     */
    public static final String EVENT_MESSAGE_DELETED = "message-deleted";

    /**
     * The SSE event name carrying a transient <b>typing indicator</b> (TM-465) — an ephemeral "X is
     * typing…" signal fanned out to the thread's other connected members. Unlike {@link #EVENT_MESSAGE}
     * it is <b>never persisted</b>: it rides the live socket only, expires client-side, and re-sync over
     * the read API never replays it (there is nothing stored to replay). The payload is a small
     * {@link com.teammarhaba.backend.api.TypingSignal} ({@code userId}, {@code name}, {@code typing}).
     */
    public static final String EVENT_TYPING = "typing";

    /** The event name of the initial confirmation frame sent the instant a stream opens. */
    private static final String EVENT_OPEN = "open";

    /**
     * conversation id → the set of streams currently open <em>on this instance</em> for that thread.
     * A {@link CopyOnWriteArraySet} so a broadcast can iterate while opens/closes mutate concurrently.
     * Empty sets are pruned by the heartbeat, so a quiet thread leaves no residue.
     */
    private final Map<Long, Collection<SseEmitter>> streamsByConversation = new ConcurrentHashMap<>();

    /**
     * emitter → the Firebase uid of the member who opened it, so a broadcast can <b>exclude a specific
     * member's own stream</b> (TM-465: a typing signal must reach the thread's OTHER members, never echo
     * back to the typist). A side map rather than a value on {@link #streamsByConversation} keeps the
     * message-broadcast path (which addresses every stream) untouched — owner tracking is purely additive
     * and only consulted by {@link #broadcastExcluding}. Entries are removed in lock-step with the emitter
     * ({@link #remove} / {@link #dropQuietly}) so a closed stream leaves no owner residue. A stream opened
     * without an owner (the legacy {@link #open(long)} path) simply isn't keyed here and is never excluded.
     */
    private final Map<SseEmitter, String> streamOwner = new ConcurrentHashMap<>();

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
        return open(conversationId, null);
    }

    /**
     * Open a live stream and register it under {@code ownerUid} so a later {@link #broadcastExcluding}
     * can skip this member's own stream (TM-465). Behaves exactly like {@link #open(long)} otherwise —
     * the owner is only ever consulted to exclude the typist from their own typing broadcast; message
     * broadcasts still reach it. {@code ownerUid} may be {@code null} (an anonymous/legacy open), in
     * which case the stream is never excluded.
     *
     * @param conversationId the thread the caller is a member of
     * @param ownerUid       the Firebase uid of the connecting member, or {@code null}
     * @return the open {@link SseEmitter} for the controller to return to Spring MVC
     */
    public SseEmitter open(long conversationId, String ownerUid) {
        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT);
        register(conversationId, emitter, ownerUid);
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
        register(conversationId, emitter, null);
    }

    /**
     * As {@link #register(long, SseEmitter)}, additionally recording {@code ownerUid} (when non-null) so
     * {@link #broadcastExcluding} can skip this member's own stream (TM-465). Package-private so a unit
     * test can register a fake/mock emitter with an owner without going through the servlet stack.
     */
    void register(long conversationId, SseEmitter emitter, String ownerUid) {
        streamsByConversation
                .computeIfAbsent(conversationId, key -> new CopyOnWriteArraySet<>())
                .add(emitter);
        if (ownerUid != null) {
            streamOwner.put(emitter, ownerUid);
        }
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
        return broadcastExcluding(conversationId, eventName, data, null);
    }

    /**
     * Broadcast {@code data} as a named SSE event to every stream open <em>on this instance</em> for
     * {@code conversationId} <b>except</b> the one owned by {@code excludeUid} (TM-465). This is the
     * transport half of the typing indicator: the typing signal fans out to the thread's OTHER connected
     * members and is deliberately never echoed back to the typist's own stream, so a client never renders
     * "you are typing". A {@code null} {@code excludeUid} excludes nobody, so {@link #broadcast} is just
     * this with no exclusion. Delivery is otherwise identical to {@link #broadcast}: best-effort and
     * single-instance, a stream that rejects the write is dropped in place, and 0 open streams (the common
     * Cloud Run case) is a no-op.
     *
     * @param excludeUid the Firebase uid whose own stream must NOT receive this event, or {@code null} to
     *     deliver to everyone. Matched against the owner recorded at {@link #open(long, String)}.
     * @return how many streams the event was delivered to (excluding the sender's own)
     */
    public int broadcastExcluding(long conversationId, String eventName, Object data, String excludeUid) {
        Collection<SseEmitter> streams = streamsByConversation.get(conversationId);
        if (streams == null || streams.isEmpty()) {
            return 0; // nobody connected here — the offline path (push + fetch-on-open) still delivers
        }
        int delivered = 0;
        for (SseEmitter emitter : streams) {
            // Skip the sender's own stream(s): a typing signal must reach OTHERS, never echo to the typist.
            if (excludeUid != null && excludeUid.equals(streamOwner.get(emitter))) {
                continue;
            }
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
     * The Firebase uids of the members currently holding an open stream for {@code conversationId} on
     * this instance — the raw material for an {@code @here} mention (TM-469). Each open stream was
     * registered with its owner's uid at {@link #open(long, String)}; this returns the distinct set of
     * those uids (a member with two tabs open appears once), so {@link MentionNotifier} can map them to
     * user ids and treat them as "online here".
     *
     * <p><b>Same single-instance caveat as {@link #broadcast}.</b> This registry lives in one JVM's
     * heap, so on Cloud Run it only sees the streams terminated on <em>this</em> instance — {@code @here}
     * is therefore a best-effort "online right now, as this instance can see it", exactly like the live
     * broadcast. That is acceptable: {@code @here} is a convenience fan-out, and any member it misses
     * still receives the ordinary new-message push (TM-437) like everyone else. Durable cross-instance
     * presence is the deferred TM-505 realtime-backbone work; until then this is the honest slice.
     *
     * @param conversationId the thread whose connected members to report
     * @return the distinct owner uids currently connected here; empty when nobody is (the common case)
     */
    public Set<String> onlineOwnerUids(long conversationId) {
        Collection<SseEmitter> streams = streamsByConversation.get(conversationId);
        if (streams == null || streams.isEmpty()) {
            return Set.of();
        }
        Set<String> uids = new HashSet<>();
        for (SseEmitter emitter : streams) {
            String owner = streamOwner.get(emitter);
            if (owner != null) {
                uids.add(owner);
            }
        }
        return uids;
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
        streamOwner.remove(emitter); // forget the owner in lock-step so no residue survives the stream
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
        streamOwner.remove(emitter); // forget the owner in lock-step so no residue survives the stream
    }
}
