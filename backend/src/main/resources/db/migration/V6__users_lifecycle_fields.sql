-- V6__users_lifecycle_fields — account-lifecycle flags on accounts (TM-163)
--
-- Beyond identity and the user-editable profile (TM-162), accounts now record where the user is in
-- the onboarding / legal lifecycle, so the app can gate first-run onboarding and terms acceptance
-- and track a (self-attested) age check.
--
--   onboarding_completed    Has the user finished first-run onboarding? NOT NULL, defaults to false
--                           so every existing and new row has a concrete state. Flipped to true by
--                           POST /api/v1/me/onboarding-complete. Mapped to a Java boolean primitive,
--                           so the column is BOOLEAN NOT NULL (Hibernate validate-only requires the
--                           DDL type to match the entity exactly).
--   terms_accepted_version  Which terms version the user accepted (free text, e.g. "2026-06-01"),
--                           or NULL if they never have. Set by POST /api/v1/me/accept-terms.
--   terms_accepted_at       When they accepted that version (TIMESTAMPTZ), or NULL. Mapped to a Java
--                           Instant; written alongside terms_accepted_version in one transition.
--   age_verified            Has the user attested their age? NOT NULL, defaults to false. Self-
--                           attested for now (TM-163) — real ID verification is out of scope. Tied to
--                           the age field (TM-162): set true only once an age is on record. Mapped to
--                           a Java boolean primitive, so the column is BOOLEAN NOT NULL.
ALTER TABLE users ADD COLUMN onboarding_completed   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN terms_accepted_version VARCHAR(64);
ALTER TABLE users ADD COLUMN terms_accepted_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN age_verified           BOOLEAN NOT NULL DEFAULT false;
