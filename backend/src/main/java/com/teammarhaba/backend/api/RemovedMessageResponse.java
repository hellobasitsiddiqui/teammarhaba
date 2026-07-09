package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Message;
import java.time.Instant;

/**
 * The result of an app admin removing a chat message (TM-449) — returned by {@code POST
 * /api/v1/admin/conversations/{conversationId}/messages/{messageId}/remove}. A thin acknowledgement,
 * not the message body: the message has been soft-deleted and now drops out of every timeline read,
 * so echoing its text back would be pointless. {@code removedAt} is the stamped soft-delete instant
 * ({@link Message#getDeletedAt()}), so a re-remove returns the original moment (the soft-delete is
 * first-moment-wins).
 *
 * @param messageId      the removed message's id
 * @param conversationId the thread it belonged to
 * @param removed        always {@code true} — the message is soft-deleted after this call
 * @param removedAt      the soft-delete instant (first-moment-wins across repeated removes)
 */
public record RemovedMessageResponse(long messageId, long conversationId, boolean removed, Instant removedAt) {

    /** Map a just-soft-deleted {@link Message} to its acknowledgement wire form. */
    public static RemovedMessageResponse from(Message message) {
        return new RemovedMessageResponse(
                message.getId(), message.getConversationId(), message.isDeleted(), message.getDeletedAt());
    }
}
