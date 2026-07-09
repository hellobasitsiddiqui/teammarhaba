package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.MuteState;
import jakarta.validation.constraints.NotNull;

/**
 * The body of {@code POST /api/v1/admin/conversations/{conversationId}/members/{userId}/mute}
 * (TM-449) — an app admin choosing, per case, what to do with a thread member:
 *
 * <ul>
 *   <li>{@link MuteState#READ_ONLY} — mute: the member can still read but can no longer post;</li>
 *   <li>{@link MuteState#REMOVED} — full removal: the member loses thread access entirely (their
 *       event RSVP is untouched — they're still "going");</li>
 *   <li>{@link MuteState#NONE} — reinstate a previously muted / removed member.</li>
 * </ul>
 *
 * <p>{@code state} is required ({@code @NotNull}); an absent value is a Bean-Validation {@code 400}
 * and an unrecognised enum name is a {@code 400} from the message converter — both via the global
 * RFC-7807 handler. Jackson binds the enum from its {@code name()} (e.g. {@code "READ_ONLY"}).
 *
 * @param state the mute / removal state to apply to the member
 */
public record MuteMemberRequest(@NotNull MuteState state) {}
