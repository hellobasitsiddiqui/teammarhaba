package com.teammarhaba.backend.api;

/**
 * The caller's single aggregate unread total across every thread they belong to (TM-582) — returned
 * by {@code GET /api/v1/me/conversations/unread-total} so the Chat-tab unread badge (TM-439) has one
 * server-authoritative number to paint.
 *
 * <p><b>Why a dedicated value.</b> The conversation list ({@code GET /me/conversations}) is paged and
 * carries only a per-thread {@code unreadCount}, so a client that summed the list undercounted once a
 * caller had more than one page of threads (it only ever saw the first page). This total spans <em>all</em>
 * the caller's non-removed memberships, so the badge is correct regardless of how many threads they are
 * in — while the list stays paged for rendering.
 *
 * <p>Computed per-caller against each membership's read cursor (a never-opened thread counts every live
 * message; a kicked/{@code REMOVED} membership contributes nothing), so the same threads yield a different
 * total for two people. See {@link com.teammarhaba.backend.chat.ConversationReadService#unreadTotal}.
 *
 * @param total the caller's total unread messages across all their threads (never negative; {@code 0}
 *              when everything is read or the caller has no threads)
 */
public record UnreadTotalResponse(long total) {}
