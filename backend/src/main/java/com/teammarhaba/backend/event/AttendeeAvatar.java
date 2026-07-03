package com.teammarhaba.backend.event;

import com.teammarhaba.backend.user.User;

/**
 * One entry in the event-detail attendee-avatar strip (TM-393): the minimum needed to render a
 * face — id (client list key) and display name (initials / placeholder art are derived client-side;
 * there is no stored avatar image yet). Always resolved through the {@code User} aggregate, whose
 * {@code @SQLRestriction} hides soft-deleted accounts — a tombstoned attendee silently drops out of
 * the strip. Deliberately excludes email and every other profile field: this is a member-visible
 * surface.
 *
 * @param id          the attendee's {@code users.id}
 * @param displayName the attendee's profile name (may be {@code null} — client shows a placeholder)
 */
public record AttendeeAvatar(Long id, String displayName) {

    public static AttendeeAvatar from(User user) {
        return new AttendeeAvatar(user.getId(), user.getDisplayName());
    }
}
