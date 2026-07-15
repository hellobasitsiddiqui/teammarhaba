-- V43__refund_attempt_cap — terminal reconciliation for the REFUND_DUE retry sweep (TM-726 / epic Membership)
--
-- The REFUND_DUE sweep (TM-625, V39) re-attempts the provider refund every hour until it succeeds — but
-- with NO terminal state: a refund that the provider will PERMANENTLY reject (the payment was already
-- refunded out of band, the order is too old to refund, the amount no longer matches) leaves the row
-- REFUND_DUE forever, so the sweep retries the same doomed full refund on every pass, indefinitely. That
-- is unbounded work and a debt that never reconciles.
--
-- This adds a bounded retry counter to each ledger. Each failed sweep attempt increments it; once it
-- crosses the cap the row moves to the new terminal status REFUND_ABANDONED — the refund could not be
-- issued automatically and needs a human, and the hourly sweep stops hammering a permanently-rejected
-- refund. REFUND_ABANDONED is a plain VARCHAR value in the existing status column (EnumType.STRING,
-- "add values, never rename"), so no type change — only the two new counter columns are DDL.
--
-- refund_attempts defaults 0 and is NOT NULL so existing REFUND_DUE rows start from a clean count and the
-- Order / SubscriptionCharge mappings can read it as a primitive int. Bumped only by the sweep, never by
-- the inline (best-effort) refund at issue time — the inline attempt is not part of the bounded budget.
ALTER TABLE orders
    ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0 CHECK (refund_attempts >= 0);

ALTER TABLE subscription_charges
    ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0 CHECK (refund_attempts >= 0);
