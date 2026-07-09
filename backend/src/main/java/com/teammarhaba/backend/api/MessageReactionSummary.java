package com.teammarhaba.backend.api;

import java.util.List;

/**
 * A single message's full reaction summary (TM-461) — every distinct emoji on it, each with its
 * count and whether the caller reacted. Returned by the react / un-react toggle endpoints so the
 * client can repaint that message's chips from the authoritative post-toggle state without a reload,
 * and reused as the per-message {@code reactions} block inside the thread-messages projection.
 *
 * @param messageId the message the reactions belong to
 * @param reactions one entry per distinct emoji, oldest-reacted emoji first; empty if none
 */
public record MessageReactionSummary(Long messageId, List<EmojiReactionCount> reactions) {}
