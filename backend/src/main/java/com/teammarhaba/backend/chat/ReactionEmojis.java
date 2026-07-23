package com.teammarhaba.backend.chat;

import java.util.Set;

/**
 * The server-side <b>allow-list</b> of reaction glyphs (TM-989) — the single source of truth for which
 * emojis a react (add) may persist. It mirrors the web client's canonical picker set,
 * {@code REACTION_EMOJIS} in {@code web/src/assets/chat-core.js}
 * ({@code ["👍", "❤️", "😂", "🎉", "🙌"]}), so the server accepts exactly what the client can offer and
 * nothing else.
 *
 * <p><b>Why an allow-list.</b> Before this, a reaction {@code emoji} was only length-bounded
 * ({@code @Size(max = 32)}) and trim-normalised — any thread member could persist thousands of
 * arbitrary {@code <=32}-char strings (each a distinct {@code UNIQUE (message_id, user_id, emoji)} row),
 * which the read path loads and every reader's UI renders as a pill: a text-spoofing and
 * storage/response-bloat vector. Constraining the add path to this fixed set closes both.
 *
 * <p><b>The default like is in the set.</b> {@link MessageReactionService#DEFAULT_EMOJI} (❤️) — the
 * glyph an emoji-less "like" resolves to — is a member of this allow-list, so a like is always allowed.
 *
 * <p><b>Add-path only.</b> This gate is applied when <em>adding</em> a reaction; un-react (remove) is
 * never gated on it, so a legacy row persisted before this allow-list existed can always be removed.
 */
final class ReactionEmojis {

    /**
     * The allowed reaction glyphs, mirroring the web client's {@code REACTION_EMOJIS} set exactly
     * (order preserved for readability; membership is what matters). ❤️ carries the emoji
     * variation selector, matching how the client and {@link MessageReactionService#DEFAULT_EMOJI}
     * store it.
     */
    static final Set<String> ALLOWED = Set.of("👍", "❤️", "😂", "🎉", "🙌");

    /**
     * The per-user, per-message cap on <b>distinct</b> reactions, deliberately set to the allow-list
     * size ({@link #ALLOWED}{@code .size()} = 5): a member may react with every allowed emoji on a
     * message, but no more — there is nothing legitimate beyond one of each. Exceeding it on the add
     * path is a {@code 400}.
     */
    static final int MAX_PER_USER_PER_MESSAGE = ALLOWED.size();

    private ReactionEmojis() {}
}
