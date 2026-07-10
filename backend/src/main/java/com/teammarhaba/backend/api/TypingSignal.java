package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.User;

/**
 * The wire payload of a live <b>typing indicator</b> SSE frame (TM-465, epic Event Chat) — the
 * {@code typing} event {@link com.teammarhaba.backend.chat.ChatStreamService#EVENT_TYPING} carries to
 * the thread's other connected members. It is the live sibling of {@link ConversationMessageResponse},
 * but for an <b>ephemeral</b> signal: it is <em>never persisted</em>, rides the socket only, and
 * expires client-side a few seconds after the last keystroke — there is nothing stored to re-sync, so
 * a reconnect simply starts fresh with no typists.
 *
 * <p>It carries just enough for the receiver to render and aggregate "<em>X (and Y) is typing…</em>":
 *
 * <ul>
 *   <li>{@code userId} — the typist's stable id, the <b>aggregation key</b> the client de-duplicates and
 *       expires per-person on (so two frames from the same typist refresh one entry, not two);</li>
 *   <li>{@code name} — the typist's display name for the label (the client falls back to a generic
 *       "Someone" when it is {@code null}/blank, so a nameless account still reads sensibly);</li>
 *   <li>{@code typing} — {@code true} for "started/still typing" (the debounced heartbeat), {@code false}
 *       for an explicit "stopped" (sent when the composer is cleared or the message is sent) so the
 *       indicator can clear immediately rather than waiting out the expiry.</li>
 * </ul>
 *
 * <p>The typist is excluded from their own broadcast at the transport
 * ({@link com.teammarhaba.backend.chat.ChatStreamService#broadcastExcluding}), so a client never
 * receives — and never has to filter — its own typing signal.
 *
 * @param userId the typist's user id (the client's per-person aggregation + expiry key)
 * @param name   the typist's display name, or {@code null} (the client renders "Someone")
 * @param typing {@code true} = started/continuing to type; {@code false} = explicitly stopped
 */
public record TypingSignal(Long userId, String name, boolean typing) {

    /** Build the signal for {@code user} with the given typing state — the shape broadcast over SSE. */
    public static TypingSignal of(User user, boolean typing) {
        return new TypingSignal(user.getId(), user.getDisplayName(), typing);
    }
}
