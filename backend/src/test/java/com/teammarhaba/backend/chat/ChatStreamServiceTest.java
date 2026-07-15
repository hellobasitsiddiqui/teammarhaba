package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.io.IOException;
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
    void disconnectMemberCompletesTheRemovedMembersOwnStreamsAndLeavesOthers() throws IOException {
        // TM-730: a member removed by moderation (or who self-left) must stop receiving live frames at
        // once, not only when their stream times out. disconnectMember completes THAT member's streams
        // (both tabs) for the thread, and leaves every other member's stream open.
        SseEmitter removedTabA = mock(SseEmitter.class);
        SseEmitter removedTabB = mock(SseEmitter.class);
        SseEmitter otherMember = mock(SseEmitter.class);
        service.register(CONVERSATION_A, removedTabA, "uid-removed");
        service.register(CONVERSATION_A, removedTabB, "uid-removed");
        service.register(CONVERSATION_A, otherMember, "uid-other");

        int revoked = service.disconnectMember(CONVERSATION_A, "uid-removed");

        assertThat(revoked).isEqualTo(2); // both of the removed member's tabs
        verify(removedTabA).complete();
        verify(removedTabB).complete();
        verify(otherMember, never()).complete(); // an unrelated member keeps their stream

        // The removed member's streams are gone from the registry, so a later broadcast reaches only the
        // remaining member — the live leak (a kicked member still reading new messages) is closed.
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);
        int delivered = service.broadcast(CONVERSATION_A, ChatStreamService.EVENT_MESSAGE, "payload");
        assertThat(delivered).isEqualTo(1);
        verify(otherMember).send(any(SseEventBuilder.class));
        verify(removedTabA, never()).send(any(SseEventBuilder.class));
        verify(removedTabB, never()).send(any(SseEventBuilder.class));
    }

    @Test
    void disconnectMemberIsANoOpForAnUnknownOrNullUidAndAnEmptyThread() {
        SseEmitter member = mock(SseEmitter.class);
        service.register(CONVERSATION_A, member, "uid-present");

        // A uid that holds no stream here, a null uid (unresolvable account), and a thread with no streams
        // all revoke nothing and leave the present member's stream untouched.
        assertThat(service.disconnectMember(CONVERSATION_A, "uid-absent")).isZero();
        assertThat(service.disconnectMember(CONVERSATION_A, null)).isZero();
        assertThat(service.disconnectMember(CONVERSATION_B, "uid-present")).isZero();
        assertThat(service.connectionCount(CONVERSATION_A)).isEqualTo(1);
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
}
