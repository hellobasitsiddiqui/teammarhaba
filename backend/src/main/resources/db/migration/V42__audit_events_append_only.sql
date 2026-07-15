-- V42__audit_events_append_only — enforce audit-log immutability at the DB level (TM-724)
--
-- Background: V4 created audit_events as an "append-only" log, but that guarantee was APPLICATION
-- CONVENTION ONLY (the entity exposes no mutators, the repository declares no update/delete). Nothing
-- stopped the DB role the app connects as from issuing an UPDATE or DELETE — via a bug, a stray
-- migration, an ad-hoc psql session, or a compromised path — silently rewriting or erasing history.
-- That is exactly the tamper-resistance an audit log exists to provide, so it must hold at the DB tier.
--
-- Why a trigger (not REVOKE): the app connects as the schema OWNER in dev/test (see V4's note), and a
-- table owner BYPASSES table privileges — so `REVOKE UPDATE, DELETE ... FROM <owner>` would be a no-op.
-- A BEFORE UPDATE/DELETE trigger fires for EVERY writer including the owner and even a superuser (unless
-- session_replication_role is deliberately set to 'replica'/'local'), so it enforces append-only under
-- the app's single DB role regardless of ownership. INSERT and SELECT are untouched — the log stays
-- fully writable-forward and readable, only mutation and deletion of existing rows are blocked.
--
-- NOTE: this is a NEW forward migration (V4 is applied and must never be edited — CI guard TM-648).

CREATE OR REPLACE FUNCTION audit_events_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

-- TRUNCATE bypasses row-level triggers, so guard it separately with a statement-level trigger.
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_mutation();
