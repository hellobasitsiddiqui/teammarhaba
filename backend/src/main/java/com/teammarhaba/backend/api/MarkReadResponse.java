package com.teammarhaba.backend.api;

import java.time.Instant;

/**
 * The result of marking a thread read (TM-436) — returned by {@code POST
 * /conversations/{id}/read} so the client can update the thread's unread badge straight from the
 * response, without a follow-up list call.
 *
 * <p>{@code lastReadAt} is the member's read cursor after the call (advanced to "now", forward-only),
 * and {@code unreadCount} is the caller's unread count recomputed against that fresh cursor — so it
 * is {@code 0} unless a new message landed in the same instant the cursor was stamped.
 *
 * @param conversationId the thread that was marked read
 * @param lastReadAt     the member's read cursor after the mark-read (never {@code null} here)
 * @param unreadCount    the caller's unread count recomputed against the fresh cursor
 */
public record MarkReadResponse(Long conversationId, Instant lastReadAt, long unreadCount) {}
