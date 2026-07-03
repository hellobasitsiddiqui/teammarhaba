-- V17__late_cancellation — lightweight late-cancellation strike counter + per-event window (TM-414)
--
-- The lightweight slice of the cancellation policy (TM-414): un-RSVPing inside the cancellation
-- window (default 24h before start) is a "late cancellation" and bumps a single running counter on
-- the user. This is deliberately NOT the full reliability-points economy (ledger, signed deltas,
-- thresholds, downgrade enforcement, no-show) — that stays deferred as TM-409, which will wrap a
-- ledger + thresholds around this same counter without a further migration. Flyway owns the DDL;
-- Hibernate validate-only, so the User / Event entities must match these columns exactly.
--
--   users.late_cancel_count        Running tally of late cancellations by this account. A plain
--                                  strike counter — never decremented here (no on-time credit /
--                                  restoration; that is TM-409). NOT NULL DEFAULT 0 backfills every
--                                  existing account to zero.
--   events.cancellation_window_hours  Per-event override of the cancellation window, in whole hours
--                                  before start_at. NULL = inherit — CancellationPolicy then falls
--                                  back to the per-city default and finally the app default (24h),
--                                  the same event → city → app-default order as the location-reveal
--                                  window (V15 / TM-408). Additive + nullable: no existing row moves.
ALTER TABLE users  ADD COLUMN late_cancel_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN cancellation_window_hours INTEGER;
