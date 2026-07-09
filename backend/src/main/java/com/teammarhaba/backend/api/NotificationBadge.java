package com.teammarhaba.backend.api;

/**
 * The two counts behind the notification bell (TM-454) for the caller's admin/system notifications
 * (the notification store, TM-452):
 *
 * <ul>
 *   <li>{@code unseen} — notifications the user hasn't yet opened the panel on. This is the
 *       <b>bell badge</b>: it's what a mark-seen clears (opening the bell), so it drops to {@code 0}
 *       the moment the panel is viewed.
 *   <li>{@code unread} — notifications the user hasn't opened/tapped individually. Survives a
 *       mark-seen (seeing the list isn't reading an item) and only drops as each item is marked read.
 * </ul>
 *
 * <p><b>Scope note (TM-454).</b> The full ticket's badge is "chat unread + unseen admin/system"; the
 * chat half rides the conversation model (TM-435 / TM-436) and is delivered by the sibling
 * notifications ticket. This DTO is the admin/system half — the notification store's contribution —
 * which a client sums with the chat-unread count to get the combined bell number.
 *
 * @param unseen count of unseen notifications (the bell badge; {@code seen_at is null})
 * @param unread count of unread notifications ({@code read_at is null})
 */
public record NotificationBadge(long unseen, long unread) {}
