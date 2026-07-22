package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Size;

/**
 * The body of a react request (TM-461): which emoji to attach to the message.
 *
 * <p><b>{@code emoji} is optional.</b> When it is {@code null} or blank — including a request with no
 * body at all — the reaction defaults to the app's like glyph
 * ({@link com.teammarhaba.backend.chat.MessageReactionService#DEFAULT_EMOJI}). That is how a "like"
 * works: the client's double-tap is a default-emoji react through this one mechanism, with no
 * separate like concept. The un-react endpoint takes the emoji as a query param the same way (omit it
 * to remove the default like).
 *
 * @param emoji the reaction glyph; {@code null}/blank → the default like emoji. Bounded here to the
 *              {@code message_reaction.emoji} column width as a cheap first check; the react (add) path
 *              additionally enforces a server-side allow-list of the canonical picker emojis and a
 *              per-user-per-message cap (TM-989,
 *              {@link com.teammarhaba.backend.chat.MessageReactionService#react}) — a non-allowed glyph
 *              or an over-cap distinct reaction is a {@code 400}.
 */
public record ReactionRequest(@Size(max = 32) String emoji) {}
