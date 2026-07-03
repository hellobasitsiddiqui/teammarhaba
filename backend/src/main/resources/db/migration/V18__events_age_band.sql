-- V16__events_age_band — per-event age-group eligibility band (TM-415 / events epic)
--
-- Events can target an age group. A user may only RSVP / join the waitlist / claim a spot when
-- their self-reported age (users.age, TM-162) falls within the band, widened by a fixed ±tolerance
-- grace on each edge (app.age-gate.tolerance-years, default 2 — an APP-LEVEL constant, never
-- per-event, so no admin can weaken the hard rule for one event). The guard is server-side
-- (AgeEligibilityPolicy); these columns only carry the band. Both nullable and independent: both
-- NULL = open to all ages (no restriction — the common case). Flyway owns the DDL; Hibernate runs
-- validate-only, so the Event entity must match this exactly.
--
--   age_min  Youngest targeted age, inclusive, before the ±tolerance grace. NULL = no lower bound.
--   age_max  Oldest targeted age, inclusive, before the ±tolerance grace. NULL = no upper bound.
--
-- The CHECK is defence in depth behind the admin-layer validation (age_min ≤ age_max when both set;
-- both non-negative): the DB can never hold an inverted or negative band.
ALTER TABLE events ADD COLUMN age_min INTEGER;
ALTER TABLE events ADD COLUMN age_max INTEGER;
ALTER TABLE events ADD CONSTRAINT ck_events_age_band CHECK (
    (age_min IS NULL OR age_min >= 0)
    AND (age_max IS NULL OR age_max >= 0)
    AND (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
);
