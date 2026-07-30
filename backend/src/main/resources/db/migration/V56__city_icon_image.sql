-- V56__city_icon_image — an UPLOADED icon image for a catalogue city (TM-1166)
--
-- TM-1089 (V54) gave each city an OPTIONAL emoji glyph (icon_emoji) + a big empty-state image
-- (image_path). The admin cities console (TM-1166) lets an admin upload TWO images per city: the big
-- empty-state image (already modelled as image_path) AND a smaller ICON image shown beside the city
-- name. This migration adds the icon-image column; icon_emoji is KEPT as an optional fallback glyph
-- (a city may carry an uploaded icon image, a plain emoji, or neither).
--
--   icon_image_path  Storage path of the uploaded icon image (e.g. "city-icon-images/7"), served via
--                    downloadUrlForPath — the twin of image_path but for the small name-beside icon.
--                    NULLABLE by design: a city without an uploaded icon is valid (it falls back to
--                    icon_emoji, or to no glyph). Same VARCHAR(500) cap as image_path.
--
-- Flyway owns this DDL; Hibernate runs validate-only, so CityCatalogue must gain the matching field.
ALTER TABLE city_catalogue
    ADD COLUMN icon_image_path VARCHAR(500);
