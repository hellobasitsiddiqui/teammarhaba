-- V5__users_profile_fields — real profile details on accounts (TM-162)
--
-- Beyond identity (firebase_uid/email) and display_name, accounts now carry a small set of
-- user-editable profile fields. These are the FIRST adopter of the User Profile epic (B1 root).
-- All columns are NULLABLE: existing rows backfill to NULL (profile not yet filled in), and the
-- user supplies them later via PATCH /api/v1/me. Identity stays token-owned and is never here.
--
--   first_name/last_name  Free-text names.
--   city                  Free-text city.
--   age                   Integer; range (13–120) is enforced at the API boundary (bean validation),
--                         not as a CHECK, to keep the validation message uniform with other fields.
--                         Mapped to a Java Integer, so the column is INTEGER (Hibernate validate-only
--                         requires the DDL type to match the entity exactly).
--   phone                 Lenient free-text phone; format validated leniently at the API boundary.
--   notification_pref     EMAIL | PUSH | BOTH. NOT NULL, defaults to EMAIL so every account has a
--                         concrete preference. Stored as VARCHAR via Hibernate EnumType.STRING (same
--                         convention as users.role) so values can be added without a DB type change.
--   timezone              IANA timezone id (e.g. "Europe/London"); best-effort validated at the API.
--   locale                BCP-47 language tag (e.g. "en-GB"); best-effort validated at the API.
ALTER TABLE users ADD COLUMN first_name        VARCHAR(255);
ALTER TABLE users ADD COLUMN last_name         VARCHAR(255);
ALTER TABLE users ADD COLUMN city              VARCHAR(255);
ALTER TABLE users ADD COLUMN age               INTEGER;
ALTER TABLE users ADD COLUMN phone             VARCHAR(32);
ALTER TABLE users ADD COLUMN notification_pref VARCHAR(16) NOT NULL DEFAULT 'EMAIL';
ALTER TABLE users ADD COLUMN timezone          VARCHAR(64);
ALTER TABLE users ADD COLUMN locale            VARCHAR(35);
