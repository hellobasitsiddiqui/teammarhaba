-- V12__widen_events_description — align the column cap with the admin events API (TM-392)
--
-- TM-391 created events.description as VARCHAR(4000); the admin events API (TM-392) validates
-- description at <= 5000 characters per the ticket's contract. Widen the column so the database
-- cap matches the API's bean validation — otherwise a 4001..5000-char description would pass
-- validation and then blow up as a 409 at the INSERT. Widening a VARCHAR is a metadata-only
-- change in Postgres (no table rewrite, no lock pain); Hibernate's validate mode does not check
-- VARCHAR lengths, so the entity mapping is unaffected.
ALTER TABLE events ALTER COLUMN description TYPE VARCHAR(5000);
