package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter.SseEventBuilder;

/**
 * Unit tests for the live-chat SSE hub (TM-464) — the AC's <b>broadcast test</b> plus the registry
 * bookkeeping that keeps it correct. Pure Mockito over {@link ChatStreamService#register} (the
 * package-private test seam), so no servlet container is needed: mock {@link SseEmitter}s stand in for
 * real streams and we assert exactly which of them a broadcast writes to, and that a failing stream is
 * dropped rather than retried. The end-to-end path through the real HTTP stack (auth + membership gate
 * + a real {@link SseEmitter}) is covered by {@code ConversationStreamIntegrationTest}.
 */
class ChatStreamServiceTest {

    private static final long CONVERSATION_A = 100L;
    private static final long CONVERSATION_B = 200L;

    private final ChatStreamService service = new ChatStreamService();

    @Test
    void broadcastReachesEveryStreamOpenForTheConversation() throws IOException {
        SseEmitter first = mock(SseEmitter.class);
        SseEmitter second = mock(SseEmitter.class);
        service.register(CONVERSATION_A, first);
        service.register(CONVERSATION_A, second);

        int delivered = service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload");

        assertThat(delivered).isEqualTo(2);
        verify(first).send(any(SseEventBuilder.class));
        verify(second).send(any(SseEventBuilder.class));
    }

    @Test
    void broadcastExcludingReachesOtherMembersButNeverTheExcludedSender() throws IOException {
        // Two members connected to the same thread, each stream registered under its owner's uid. A typing
        // signal (TM-465) must reach the OTHER member but never echo back to the typist's own stream.
        SseEmitter sender = mock(SseEmitter.class);
        SseEmitter other = mock(SseEmitter.class);
        service.register(CONVERSATION_A, sender, "uid-sender");
        service.register(CONVERSATION_A, other, "uid-other");

        int delivered = service.broadcastExcluding(CONVERSATION_A, ChatStreamService.EVENT_TYPING, "typing", "uid-sender");

        assertThat(delivered).isEqualTo(1); // only the other member, not the sender
        verify(other).send(any(SseEventBuilder.class));
        verify(sender, never()).send(any(SseEventBuilder.class)); // the typist never hears their own typing
    }

    @Test
    void broadcastExcludingWithNoOwnerRecordedDeliversToEveryStream() throws IOException {
        // A stream opened without an owner (the legacy open(id) path) is never excluded — the uid simply
        // doesn't match, so a broadcast still reaches it. Guards the owner-tracking additive change.
        SseEmitter anonymous = mock(SseEmitter.class);
        service.register(CONVERSATION_A, anonymous); // no owner uid

        int delivered = service.broadcastExcluding(CONVERSATION_A, ChatStreamService.EVENT_TYPING, "typing", "uid-sender");

        assertThat(delivered).isEqualTo(1);
        verify(anonymous).send(any(SseEventBuilder.class));
    }

    @Test
    void broadcastIsScopedToItsConversationAndNeverLeaksToOthers() throws IOException {
        SseEmitter inThread = mock(SseEmitter.class);
        SseEmitter otherThread = mock(SseEmitter.class);
        service.register(CONVERSATION_A, inThread);
        service.register(CONVERSATION_B, otherThread);

        int delivered = service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload");

        assertThat(delivered).isEqualTo(1);
        verify(inThread).send(any(SseEventBuilder.class));
        verify(otherThread, never()).send(any(SseEventBuilder.class)); // a member of another thread hears nothing
    }

    @Test
    void broadcastToAConversationWithNoOpenStreamsDeliversToNobody() {
        // The common Cloud Run case: the poster's instance holds no subscriber for this thread. The
        // message still reaches members via push + fetch-on-open — this live hop is simply a no-op.
        assertThat(service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload")).isZero();
    }

    @Test
    void aStreamThatRejectsTheWriteIsDroppedFromTheRegistry() throws IOException {
        SseEmitter healthy = mock(SseEmitter.class);
        SseEmitter broken = mock(SseEmitter.class);
        doThrow(new IOException("client gone")).when(broken).send(any(SseEventBuilder.class));
        service.register(CONVERSATION_A, healthy);
        service.register(CONVERSATION_A, broken);

        int delivered = service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload");

        // Only the healthy stream counts; the broken one is completed + evicted so it is never retried.
        assertThat(delivered).isEqualTo(1);
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);
        verify(broken).complete();
    }

    @Test
    void openRegistersAStreamAndReportsTheConnectionCount() {
        assertThat(service.connectionCount(CONVERSATION_A)).isZero(); // nothing open yet

        SseEmitter emitter = service.open(CONVERSATION_A);

        assertThat(emitter).isNotNull();
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);
        assertThat(service.connectionCount(CONVERSATION_B)).isZero(); // an unrelated thread is unaffected
    }

    @Test
    void heartbeatDropsAStreamThatHasDiedSinceItConnected() throws IOException {
        SseEmitter dead = mock(SseEmitter.class);
        doThrow(new IOException("pipe closed")).when(dead).send(any(SseEventBuilder.class));
        service.register(CONVERSATION_A, dead);
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);

        service.heartbeat(); // keep-alive write fails -> the dead stream is pruned

        assertThat(service.connectionCount(CONVERSATION_A)).isZero();
        verify(dead).complete();
    }

    @Test
    void heartbeatNeverPrunesAConversationThatStillHasAnOpenStream() throws IOException {
        // TM-727 (the visible half of the race): the heartbeat prunes an EMPTY conversation set, but it
        // must never drop a set that still holds a live stream — doing so would silently detach that
        // member from every future broadcast. A healthy stream keeps its conversation registered across
        // any number of heartbeats.
        SseEmitter live = mock(SseEmitter.class);
        service.register(CONVERSATION_A, live);

        service.heartbeat();
        service.heartbeat();

        // Still registered and reachable — the prune left the non-empty set alone. (A delivered count of
        // 1 proves the broadcast found the stream; the emitter also saw the two keep-alive writes.)
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);
        assertThat(service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload")).isEqualTo(1);
    }

    @Test
    void aStreamRegisteringConcurrentlyWithHeartbeatPrunesIsNeverLost() throws InterruptedException {
        // TM-727 (the racy half): register() creates the per-conversation set and adds the emitter, while
        // heartbeat() drops any set it finds empty. Under the old computeIfAbsent-then-add, a heartbeat
        // could remove the just-created (still-empty-looking) set between those two steps and orphan the
        // stream. Both paths now mutate the mapped set under the map's per-key compute lock, so they are
        // mutually exclusive. Hammer register against a continuous heartbeat storm on the SAME churning
        // key; every stream that reports itself registered must remain reachable (never silently pruned).
        int rounds = 5_000;
        ExecutorService registrars = Executors.newFixedThreadPool(4);
        ExecutorService pruner = Executors.newSingleThreadExecutor();
        AtomicInteger lost = new AtomicInteger();
        var pruning = new java.util.concurrent.atomic.AtomicBoolean(true);
        try {
            pruner.execute(() -> {
                while (pruning.get()) {
                    service.heartbeat();
                }
            });
            CountDownLatch done = new CountDownLatch(rounds);
            for (int i = 0; i < rounds; i++) {
                long conversationId = 1_000L + (i % 8); // few keys → constant create/prune churn
                registrars.execute(() -> {
                    try {
                        SseEmitter emitter = mock(SseEmitter.class);
                        service.register(conversationId, emitter);
                        // The set we registered into must still be the live map value: a prune that raced
                        // us must not have detached our emitter. connectionCount reads the live map, so a
                        // 0 here means our just-added stream was orphaned.
                        if (service.connectionCount(conversationId) == 0) {
                            lost.incrementAndGet();
                        }
                    } finally {
                        done.countDown();
                    }
                });
            }
            assertThat(done.await(30, TimeUnit.SECONDS)).isTrue();
        } finally {
            pruning.set(false);
            registrars.shutdownNow();
            pruner.shutdownNow();
        }
        assertThat(lost.get()).as("streams orphaned by a heartbeat prune racing registration").isZero();
    }
}
