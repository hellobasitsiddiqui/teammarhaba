-- V33__conversation_broadcast_owner — the per-user "from TeamMarhaba" broadcast channel (TM-588)
--
-- TM-445 renders admin broadcasts in the chat section (ADMIN_BROADCAST threads, system messages), but
-- nothing on the backend ever CREATES or POPULATES such a thread — TM-441 delivered admin messaging
-- purely as ADMIN_MESSAGE notifications (bell + push), so the chat render had no real data to drive
-- off. TM-588 bridges the admin-send path into the chat model: every recipient of a broadcast gets it
-- persisted as a system Message in an ADMIN_BROADCAST Conversation they are a member of.
--
-- The membership model chosen is a per-user PERSONAL broadcast channel: each recipient has (at most)
-- ONE ADMIN_BROADCAST thread — their own "from TeamMarhaba" channel — into which every broadcast
-- targeted at them is appended as a further system message. This is what the read side already assumes
-- ("a handful of event chats plus THE broadcast channel, not an unbounded feed" — one bounded thread
-- per user, ConversationReadService.list) and it PRESERVES the admin-send's targeting: a message only
-- lands in the threads of the users the campaign actually resolved to, unlike a single shared thread
-- (where every member would see every broadcast, leaking a city/event-targeted message to everyone).
--
-- To key a user's single personal channel we add an owner_user_id to `conversation`. It is:
--   • NULL for an EVENT_GROUP thread (those are keyed by event_id) and for any owner-less
--     ADMIN_BROADCAST row (the no-arg Conversation.adminBroadcast() factory, used only by tests);
--   • the recipient's users(id) for a per-user broadcast channel (Conversation.adminBroadcast(userId)).
--
-- Flyway owns this DDL; Hibernate runs validate-only, so Conversation.ownerUserId must match this
-- column exactly (nullable, updatable=false).

-- The owner of a per-user ADMIN_BROADCAST channel. Plain FK id to users(id) (same convention as
-- event_id → events(id) and conversation_member.user_id → users(id)); ON DELETE CASCADE mirrors those,
-- though accounts are only ever soft-deleted in-app so in practice the FK never fires.
ALTER TABLE conversation
    ADD COLUMN owner_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE;

-- At most ONE ADMIN_BROADCAST thread per owner — a user's personal "from TeamMarhaba" channel is a
-- singleton, so the bridge (AdminBroadcastChatBridge) resolves it by (type, owner_user_id) and expects
-- Optional (0 or 1), lazily creating it on the user's first broadcast and reusing it thereafter. A
-- partial UNIQUE index enforces the singleton (and serves that lookup) without constraining EVENT_GROUP
-- rows or the owner-less test broadcast rows, both of which have a NULL owner_user_id and are exempt.
CREATE UNIQUE INDEX uq_conversation_broadcast_owner
    ON conversation (owner_user_id)
    WHERE type = 'ADMIN_BROADCAST' AND owner_user_id IS NOT NULL;

-- Widen message.body to hold a WHOLE admin broadcast. The chat message store (V27) capped body at
-- VARCHAR(4000) — ample for an event-chat post (bounded to 500 at the edge, PostMessageRequest) — but an
-- admin broadcast body is bounded at 5000 (AdminMessageRequest.MAX_BODY_LENGTH; admin_message.body and
-- notification.body are both VARCHAR(5000), V23). Now that the bridge persists that same body as a
-- system message, the shared column must accommodate the largest thing written into it, or a >4000-char
-- broadcast would fail to persist as a chat copy (a DataIntegrityViolation aborting the whole send).
-- Widening is lossless and touches no existing rows; event-chat posts stay bounded at 500 as before.
ALTER TABLE message ALTER COLUMN body TYPE VARCHAR(5000);
