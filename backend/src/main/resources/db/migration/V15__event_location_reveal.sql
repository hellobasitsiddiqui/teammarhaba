-- V15__event_location_reveal — per-event inputs for the location-reveal policy (TM-408)
--
-- The exact venue of an event (location_text address, map_url, online_url) is a privacy-sensitive
-- detail: the public events list/detail withhold it until now >= start_at − revealHours, exposing
-- only a coarse city hint + the reveal timestamp before then (enforcement lives in
-- EventQueryService; the resolver is LocationRevealPolicy). This migration adds the two additive,
-- nullable inputs that policy resolves over — nothing here changes existing rows or the exact
-- columns themselves. Flyway owns the DDL; Hibernate validate-only, so the Event entity must match.
--
--   location_reveal_hours  Per-event override of the reveal window, in whole hours before start_at.
--                          NULL = inherit (fall back to the per-city default, then the app default
--                          of 24h — see app.location-reveal.* and LocationRevealProperties).
--   city                   Optional coarse locality (e.g. "London"). Two jobs: it is the only
--                          location hint the public API exposes before reveal, and it keys the
--                          config-driven per-city default map. NULL = no hint / no per-city default.
ALTER TABLE events ADD COLUMN location_reveal_hours INTEGER;
ALTER TABLE events ADD COLUMN city                  VARCHAR(120);
