-- V21__events_price_premium — admin-set event price + premium flag (TM-475 / membership)
--
-- Two new event attributes the membership entitlement + feed checkout read: what an event costs
-- and whether it is gated as premium. The admin sets both on the event create/edit form; both
-- carry a default so every existing row (and any create that omits them) is well-defined. Flyway
-- owns this DDL; Hibernate runs validate-only, so the Event entity must match these columns exactly.
--
--   price_pence  Ticket price in MINOR UNITS (pence) of a single implied currency, GBP. Storing an
--                integer number of pence — not a float/NUMERIC of pounds — is the house money
--                convention chosen here (TM-475): it is exact (no binary-float rounding), sums
--                cleanly, and maps 1:1 onto what a checkout/payment provider charges. £5.00 = 500.
--                NOT NULL DEFAULT 500 backfills every existing event to the £5 default and is the
--                app-omitted-value backstop. The CHECK is defence in depth behind the admin-layer
--                `price >= 0` bean validation: the DB can never hold a negative price.
--   is_premium   Whether the event is gated as premium (bool). NOT NULL DEFAULT false: existing and
--                new events are non-premium unless an admin marks them so.
ALTER TABLE events ADD COLUMN price_pence INTEGER NOT NULL DEFAULT 500;
ALTER TABLE events ADD COLUMN is_premium  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD CONSTRAINT ck_events_price_pence_nonneg CHECK (price_pence >= 0);
