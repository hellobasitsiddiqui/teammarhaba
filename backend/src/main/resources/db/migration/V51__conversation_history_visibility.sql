-- V51__conversation_history_visibility — the "how much history a member sees" seam (TM-1055, chat-media foundation)
--
-- Phase-1 SEAM ONLY. This lays down a per-thread history_visibility flag on `conversation` and wires the
-- read path to be AWARE of it, with ZERO behaviour change: every existing and new thread is 'FULL', which
-- is exactly today's behaviour — a member reads the WHOLE thread timeline, pre-join messages included
-- (the TM-709 late-joiner guarantee). Phase 2 (see TM-468) adds the 'FROM_JOIN' variant + a history_cutoff_at
-- and the ConversationReadService filter that honours it; this migration deliberately ships neither, so the
-- seam can be extended later without re-opening the schema.
--
--   history_visibility  FULL | FROM_JOIN, VARCHAR via EnumType.STRING (same convention as
--                       conversation.type / conversation_member.mute / users.role). Values may be added but
--                       existing names must never be renamed/removed — old rows keep referencing them.
--                       NOT NULL DEFAULT 'FULL' backfills every existing thread to today's full-history
--                       behaviour and makes 'FULL' the default for every future thread, so nothing changes
--                       until Phase 2 starts setting 'FROM_JOIN' on threads that opt into join-scoped history.
--
-- Flyway owns this DDL; Hibernate runs validate-only, so Conversation.historyVisibility must match this
-- column exactly (VARCHAR(16), NOT NULL, EnumType.STRING).
ALTER TABLE conversation
    ADD COLUMN history_visibility VARCHAR(16) NOT NULL DEFAULT 'FULL';
