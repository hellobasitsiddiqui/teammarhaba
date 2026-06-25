package com.teammarhaba.backend.notify;

/**
 * The user-visible content of a single push notification (TM-284, epic TM-277). Kept transport-neutral
 * (a {@code title} + {@code body}) so the {@link PushSender} seam can map it onto FCM today and onto
 * any future transport without the calling services knowing about the wire format.
 *
 * @param title the short headline shown on the notification
 * @param body  the longer line beneath the title
 */
public record PushMessage(String title, String body) {

    public PushMessage {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("Push title must not be blank.");
        }
        if (body == null || body.isBlank()) {
            throw new IllegalArgumentException("Push body must not be blank.");
        }
    }
}
