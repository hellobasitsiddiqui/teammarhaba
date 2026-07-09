-- V25__admin_message_recall — admin can recall (unsend) a message they already sent (TM-473 / epic TM-432)
--
-- Version PRE-ASSIGNED as V25 (main is at V24). Do NOT auto-pick "next free" — this migration is owned
-- by TM-473 and must stay V25 even if a sibling adds a later version, so the recall column addition has
-- a stable, reviewable place in the history.
--
-- WHAT RECALL DOES (see AdminMessageService.recall): an admin pulls a sent message back — it is marked
-- recalled here, and the durable per-recipient in-app copies it created (the ADMIN_MESSAGE notification
-- rows keyed by source_ref = 'admin_message:<id>', which back BOTH the in-app inbox/panel AND the
-- notification bell — the same store since TM-452/TM-453) are deleted. Recall is admin-gated + audited
-- (ADMIN_MESSAGE_RECALLED). It is best-effort on push: an OS-tray push that already fired can't be
-- un-sent; recall only removes the in-app copies.
--
-- WHY THIS IS AN ALLOWED MUTATION on an otherwise append-only header:
-- admin_message (V23) is append-only BY DESIGN — the campaign DEFINITION (who/what/target/count) is
-- immutable and single-write, mirroring audit_events / notification_broadcasts. Recall does NOT rewrite
-- any of that; it stamps a SEPARATE, terminal, one-way "recalled" marker (like Notification.markSeen /
-- markRead set-if-null timestamps). So the definition stays immutable and the only new state is
-- "this campaign was later recalled, by whom, when" — which the sent-history view surfaces as RECALLED.
--
--   recalled_at  When the message was recalled; NULL = still live (the vast majority of rows). Set once,
--                never rewritten (AdminMessage.markRecalled is a one-way set-if-null).
--   recalled_by  Firebase UID of the admin who recalled it; NULL until recalled. Attributed like actor_uid.
--
-- Both columns are nullable and default NULL, so every existing row is valid unchanged and this is a
-- backward-compatible, forward-only change. Hibernate runs validate-only, so the AdminMessage entity's
-- new recalledAt/recalledBy fields must match these columns exactly.
ALTER TABLE admin_message ADD COLUMN recalled_at TIMESTAMPTZ;
ALTER TABLE admin_message ADD COLUMN recalled_by VARCHAR(128);

-- Sent-history reads may filter/segment on recall state ("show recalled") — a partial index keeps that
-- a cheap indexed scan while costing almost nothing for the common all-live table (only recalled rows
-- are indexed).
CREATE INDEX idx_admin_message_recalled_at ON admin_message (recalled_at) WHERE recalled_at IS NOT NULL;
