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
 * @param emoji the reaction glyph (unicode emoji or {@code :shortcode:}); {@code null}/blank → the
 *              default like emoji. Bounded to the {@code message_reaction.emoji} column width.
 */
public record ReactionRequest(@Size(max = 32) String emoji) {}
