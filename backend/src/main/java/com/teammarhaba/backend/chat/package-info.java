/**
 * Conversation + message data model — the shared chat foundation (TM-435, {@code group-foundation},
 * wave-0 root of the Event Chat epics).
 *
 * <p>This package owns the one durable structure that <strong>both</strong> admin broadcasts (epic
 * TM-432) and event group chat (epic TM-433) persist into, so the app's single "chat" section reads
 * every thread — an admin "from TeamMarhaba" broadcast and a per-event group conversation — out of
 * the same three tables:
 *
 * <ul>
 *   <li>{@link com.teammarhaba.backend.chat.Conversation} — one thread, either an
 *       {@code EVENT_GROUP} (tied to one event) or an {@code ADMIN_BROADCAST} (no event).
 *   <li>{@link com.teammarhaba.backend.chat.ConversationMember} — a person's membership of a thread:
 *       their {@link com.teammarhaba.backend.chat.MemberRole role},
 *       {@link com.teammarhaba.backend.chat.MuteState mute state}, and read cursor
 *       ({@code lastReadAt}) that drives the unread count.
 *   <li>{@link com.teammarhaba.backend.chat.Message} — one posted message ({@code senderId} null =
 *       a system / admin "from TeamMarhaba" message), soft-deletable for moderation.
 * </ul>
 *
 * <p><strong>Scope (wave-0):</strong> the data model only — Flyway migration
 * {@code V27__conversation_message_model}, the entities, and the repositories exposing the lookups
 * the read API (TM-436) and the push fan-out (TM-437) build on: conversations for a user, a thread's
 * paged timeline, a thread's members / active recipients, and unread support via {@code lastReadAt}.
 * There are no REST endpoints here (those are TM-436), so no OpenAPI surface.
 *
 * <p>Flyway owns the schema; Hibernate runs validate-only, so each entity mapping matches its table
 * exactly. People are held as plain FK ids to {@code users.id} (never JPA associations) and resolved
 * through {@code UserRepository}, the same convention as {@code event_attendance} — keeping these
 * child tables decoupled from the {@code User}/{@code Event} aggregates' soft-delete restrictions.
 */
package com.teammarhaba.backend.chat;
