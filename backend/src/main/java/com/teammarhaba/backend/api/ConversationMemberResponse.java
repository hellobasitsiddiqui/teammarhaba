package com.teammarhaba.backend.api;

/**
 * One mentionable member of a thread (TM-469) — the wire shape the chat composer's @mention
 * autocomplete lists. Returned by {@code GET /conversations/{id}/members}; a DTO, never the JPA
 * {@code ConversationMember} entity, so the HTTP contract stays decoupled and reviewable in
 * {@code openapi.json}.
 *
 * <p><b>Who the roster contains.</b> The <em>active</em> ({@code MuteState.NONE}) members of the thread
 * <b>except the caller</b> — i.e. exactly the people the caller can @mention. The caller is dropped
 * server-side (you don't mention yourself, and the client never needs to know its own numeric id to
 * filter the list). Names are resolved through the user aggregate, so a tombstoned account never
 * appears.
 *
 * <p><b>{@code role}</b> is the member's thread role ({@code MEMBER} / {@code ADMIN} — the organiser is
 * {@code ADMIN}), surfaced so the client can badge the organiser and so a future host-only
 * {@code @everyone}/{@code @here} guardrail (TM-469, deferred) has the signal it needs without another
 * round-trip.
 *
 * @param userId      the member's {@code users.id} — the mention ref persisted-by-parsing the body
 * @param displayName the member's profile display name, as the composer inserts it into the body
 * @param role        the member's thread role ({@code MEMBER} / {@code ADMIN})
 */
public record ConversationMemberResponse(Long userId, String displayName, String role) {}
