-- V57__events_series_reference — link events to their recurring series (TM-789 / recurring events v1)
--
-- The events → event_series reference (V56 created the series table). Three columns, all additive and
-- back-compatible: a one-off event (the common case, and every legacy event) keeps series_id NULL and
-- is unaffected. Flyway owns this DDL; Hibernate runs validate-only, so the Event entity must match.
--
--   series_id         Nullable FK to event_series(id). NULL = a one-off event created directly; non-null
--                     = this event is one occurrence of that series. ON DELETE SET NULL: were a series
--                     ever hard-deleted (retire is soft, via status/deleted_at), its occurrences simply
--                     detach rather than cascade-deleting real events with attendees/history — mirrors
--                     the events.venue_id ON DELETE SET NULL convention (V41).
--   occurrence_index  Zero-based position of this occurrence within its series; NULL for a one-off. The
--                     engine (TM-790) stamps it as it materialises occurrences.
--   series_detached   Whether this occurrence has been edited away from the series template and no
--                     longer tracks template edits (a 3b edit-scope capability). NOT NULL DEFAULT false;
--                     v1 never flips it. Present now so 3b lands without a schema change.
ALTER TABLE events ADD COLUMN series_id BIGINT REFERENCES event_series (id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN occurrence_index INTEGER;
ALTER TABLE events ADD COLUMN series_detached BOOLEAN NOT NULL DEFAULT false;

-- Occurrence lookups by series (the engine/console listing a series' events) filter on series_id; index it.
CREATE INDEX idx_events_series_id ON events (series_id);
