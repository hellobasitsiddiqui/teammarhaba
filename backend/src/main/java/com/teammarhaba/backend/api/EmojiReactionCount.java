package com.teammarhaba.backend.api;

/**
 * One emoji's tally on a message (TM-461): how many members reacted with it, and whether the calling
 * member is one of them. The unit the reaction chips render from — one chip per distinct emoji, with
 * its count and a "highlighted because I reacted" flag.
 *
 * @param emoji the reaction glyph (unicode emoji or {@code :shortcode:}), as stored
 * @param count how many distinct members reacted to the message with this emoji ({@code >= 1})
 * @param mine  {@code true} if the calling member is among those who reacted with this emoji
 */
public record EmojiReactionCount(String emoji, long count, boolean mine) {}
