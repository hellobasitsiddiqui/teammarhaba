-- V59__widen_series_template_and_series_occurrence_uq — align series template caps with the
-- create-series API contract + harden occurrence indexing (TM-1183 code-review fixes)
--
-- Two forward-only fixes on the recurring-events model (V57 created event_series, V58 added the
-- events → series reference columns). Widening a VARCHAR is a metadata-only change in Postgres (no
-- table rewrite, no lock pain); Hibernate's validate mode does not check VARCHAR lengths, so the
-- EventSeries entity mapping is unaffected. Forward-only: V57 is NOT edited (it may already be
-- applied in some environments) — this migration corrects it in place, mirroring the V12 fix that
-- widened events.description to match its own API cap.
--
-- 1) [MAJOR] template_description cap mismatch. V57 created event_series.template_description as
--    VARCHAR(4000), but CreateSeriesRequest validates `description` at @Size(max = 5000) — the same
--    5000-char contract events.description carries after V12. A 4001..5000-char description passes
--    bean validation and then blows up at INSERT (500). Widen the column so the DB cap matches the
--    DTO cap. AUDIT of the other template_* columns against their CreateSeriesRequest @Size caps
--    (V57 vs DTO): template_heading VARCHAR(255) ≥ heading @Size(120) ✓; template_location_text
--    VARCHAR(500) = locationText @Size(500) ✓; template_city VARCHAR(120) = city @Size(120) ✓;
--    template_image_path VARCHAR(512) = imagePath @Size(512) ✓. Only template_description is
--    narrower than its DTO cap, so it is the only column widened here.
ALTER TABLE event_series ALTER COLUMN template_description TYPE VARCHAR(5000);

-- 2) [NIT] Occurrence-index uniqueness hardening. V58 added events.series_id + occurrence_index but
--    no uniqueness guard, so a future roll-forward scheduler (TM-792) that re-generates a batch could
--    silently create a duplicate (series_id, occurrence_index) pair. A partial unique index scoped to
--    real occurrences (series_id IS NOT NULL) makes a duplicate occurrence a DB error rather than a
--    silent double. One-off events (series_id NULL) are exempt, and a detached occurrence keeps its
--    stale occurrence_index on a NULL series_id — that pair is not indexed, which is acceptable (a
--    detached occurrence no longer tracks the series, so index collisions among detached rows carry
--    no meaning). Left deliberately un-over-engineered per the ticket.
CREATE UNIQUE INDEX idx_events_series_occurrence_uq
    ON events (series_id, occurrence_index)
    WHERE series_id IS NOT NULL;
