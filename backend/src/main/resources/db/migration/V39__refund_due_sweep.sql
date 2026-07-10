-- V39__refund_due_sweep — indexes backing the REFUND_DUE retry sweep (TM-625 / epic Membership)
--
-- REFUND_DUE stops being a dead-end label and becomes a WORK QUEUE: a scheduled sweep
-- (RefundSweepScheduler → RefundSweepService, gated on the same MEMBERSHIP_ENABLED +
-- SUBSCRIPTIONS_ENABLED opt-in pair as the renewal scheduler) re-attempts the provider refund for
-- every order / subscription charge whose inline refund attempt failed, until it succeeds. Before
-- this, a single transient gateway error at refund time left captured money owed back forever with
-- no operation able to return it.
--
-- No columns change: the new SubscriptionCharge statuses introduced alongside (SUPERSEDED,
-- REFUND_DUE, REFUNDED — the resolvable record a superseded-but-unvoidable checkout order leaves
-- behind, TM-625) are plain values in the existing VARCHAR(32) status column, per the
-- EnumType.STRING convention ("add values, never rename").
--
-- The two partial indexes serve the sweep's scan ("every row still owing a refund, oldest first").
-- Partial on the one status value because REFUND_DUE rows are pathological and rare — the ledgers'
-- overwhelmingly CONFIRMED/PAID bulk never enters the index, so the hourly sweep stays a cheap
-- index-only probe instead of a growing table scan.
CREATE INDEX orders_refund_due_idx
    ON orders (id)
    WHERE status = 'REFUND_DUE';

CREATE INDEX subscription_charges_refund_due_idx
    ON subscription_charges (id)
    WHERE status = 'REFUND_DUE';
