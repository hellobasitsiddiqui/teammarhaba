-- V37__orders_payment_provider — carry the payment-provider order reference on a checkout order (TM-478)
--
-- The PAY checkout branch (TM-477) now creates a REAL payment order with a provider (Revolut sandbox,
-- TM-478) before returning "payment required". The order's PENDING → CONFIRMED transition, and the
-- held-back RSVP, are driven by the provider's webhook — which identifies the order by the provider's own
-- order id. So the local order must remember which provider it went to and that provider's order id, to:
--   1. match an inbound webhook back to the local order (the lookup key), and
--   2. reconcile / refund the money later (TM-478 refund flow, deferred).
--
-- Both columns are NULLABLE by design: FREE/INCLUDED orders (the £0 frictionless path) never touch a
-- payment provider, and every order that already exists predates this change — none of them has a
-- provider reference. Flyway owns the DDL; Hibernate validate-only, so Order must map these exactly.
--
--   provider           short provider identifier ('revolut'); which gateway holds the money. VARCHAR via
--                      the same EnumType.STRING-friendly convention as orders.status — a plain string, so
--                      a second provider (Stripe) needs no DB type change.
--   provider_order_id  the provider's PERMANENT order id (Revolut order UUID). The webhook match key and
--                      the handle used to retrieve/capture/refund. UNIQUE (partial, WHERE NOT NULL) so a
--                      provider order maps to at most one local order and a replayed webhook is idempotent;
--                      the many £0 orders keep a NULL here, which a partial unique index allows any number of.
ALTER TABLE orders ADD COLUMN provider          VARCHAR(32);
ALTER TABLE orders ADD COLUMN provider_order_id VARCHAR(255);

CREATE UNIQUE INDEX orders_provider_order_id_key
    ON orders (provider_order_id)
    WHERE provider_order_id IS NOT NULL;
