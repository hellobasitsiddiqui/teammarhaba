-- V5__users_profile_fields — real profile details for accounts (TM-162 / epic root B1)
--
-- Extends `users` beyond identity (uid/email/display_name) with the self-service profile fields
-- edited via PATCH /api/v1/me. All are nullable and start empty, so existing rows backfill
-- cleanly — except notification_pref, which is NOT NULL DEFAULT 'EMAIL' (every account has a
-- sensible default channel). Stored as a string enum (EMAIL/PUSH/BOTH), matching how `role` is
-- mapped; Hibernate runs validate-only, so the `User` entity must match these columns exactly.
--
-- Column sizing: phone is kept generous + free-form (lenient validation in the app, not the DB);
-- timezone holds an IANA zone id (e.g. "Europe/London"); locale holds a BCP-47 tag (e.g. "en-GB").
--
-- HOT FILE (users + Flyway) — coordinated with the other B-tickets: this is V5; lifecycle fields
-- (TM-163), the Firebase-state column (TM-164), and avatar URL (TM-166) take the next free Vn.
ALTER TABLE users ADD COLUMN first_name        VARCHAR(100);
ALTER TABLE users ADD COLUMN last_name         VARCHAR(100);
ALTER TABLE users ADD COLUMN city              VARCHAR(120);
ALTER TABLE users ADD COLUMN age               INTEGER;
ALTER TABLE users ADD COLUMN phone             VARCHAR(32);
ALTER TABLE users ADD COLUMN notification_pref VARCHAR(16) NOT NULL DEFAULT 'EMAIL';
ALTER TABLE users ADD COLUMN timezone          VARCHAR(64);
ALTER TABLE users ADD COLUMN locale            VARCHAR(35);
