-- V3__users_soft_delete_and_version — soft-delete + optimistic concurrency for accounts (TM-114 / 2.5.2)
--
-- Two cross-cutting data conventions, applied to the first entity (users):
--   deleted_at  Soft-delete marker (NULL = active). Removing an account tombstones the row
--               instead of hard-deleting, so it stays recoverable (UserService.restore) and its
--               history survives. Standard reads exclude tombstones (entity @SQLRestriction).
--   version     Optimistic-lock counter for @Version. A concurrent stale write fails with a 409
--               instead of silently overwriting a newer one (no last-writer-wins).
--
-- firebase_uid keeps its existing global UNIQUE: a returning user's sign-in REACTIVATES their
-- tombstoned row (UserService.provision) rather than inserting a duplicate, so there is at most
-- one row per uid. Existing rows backfill to version 0 / deleted_at NULL (active) via the defaults.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN version    BIGINT NOT NULL DEFAULT 0;
