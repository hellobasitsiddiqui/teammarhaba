package com.teammarhaba.backend.api;

import java.time.Instant;

/**
 * The result of marking a thread read (TM-436) — returned by {@code POST
 * /conversations/{id}/read} so the client can update the thread's unread badge straight from the
 * response, without a follow-up list call.
 *
 * <p>{@code lastReadAt} is the member's read cursor after the call — advanced forward-only to a
 * DB-sourced instant (the newest live message's {@code created_at}, or the DB clock for a silent
 * thread; TM-580), so it shares one clock with message timestamps. {@code unreadCount} is the
 * caller's unread count recomputed against that fresh cursor — so it is {@code 0} unless a genuinely
 * new message landed during the mark-read, regardless of any app/DB clock skew.
 *
 * @param conversationId the thread that was marked read
 * @param lastReadAt     the member's read cursor after the mark-read (never {@code null} here)
 * @param unreadCount    the caller's unread count recomputed against the fresh cursor
 */
public record MarkReadResponse(Long conversationId, Instant lastReadAt, long unreadCount) {}
