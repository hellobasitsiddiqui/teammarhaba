-- V42__event_chat_announcements — admin announcement messages + the idempotent event opening message (TM-710, epic Event Chat)
--
-- Two additive slices, no destructive DDL (Flyway owns this; Hibernate runs validate-only, so the
-- Message / Event entity mappings must match these columns exactly):
--
-- 1) message.kind — what a chat message IS, orthogonal to who sent it (attendee vs announcement).
--    Every existing message is an ordinary attendee post, so the column is NOT NULL with a
--    DEFAULT 'ATTENDEE' that backfills the whole back-catalogue in one statement. An admin/host
--    announcement (the auto-posted opening message, or an admin-sent announcement) carries
--    'ANNOUNCEMENT'; the client renders it visually distinct. Stored as the enum name() (EnumType.STRING,
--    matching events.status) so the DB value is stable + readable. A CHECK backstops the two legal
--    values at the DB layer even if the app layer regresses.
--
-- 2) events.opening_message + events.opening_message_posted_at — the optional per-event opening message
--    (blank/NULL = none) and its one-shot idempotency guard. When an event's group chat first opens
--    (the lazy thread creation on the first GOING landing — EventChatLifecycleService), a configured
--    opening_message is auto-posted ONCE as an ANNOUNCEMENT and opening_message_posted_at is stamped in
--    the same transaction. The stamp is the idempotency guard: the auto-post only fires when
--    opening_message IS NOT NULL AND opening_message_posted_at IS NULL, so a re-open / redeploy /
--    replayed thread-create can never duplicate it. Both nullable (an opening message is optional; the
--    stamp is null until the first open); TEXT for the message (no fixed cap here — the API caps it).

ALTER TABLE message
    ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'ATTENDEE';

ALTER TABLE message
    ADD CONSTRAINT message_kind_check CHECK (kind IN ('ATTENDEE', 'ANNOUNCEMENT'));

ALTER TABLE events
    ADD COLUMN opening_message TEXT,
    ADD COLUMN opening_message_posted_at TIMESTAMPTZ;
