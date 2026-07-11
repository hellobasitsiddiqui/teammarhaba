package com.teammarhaba.backend.membership;

import java.time.Instant;

/**
 * The JSON view of a checkout {@link Order} (TM-477) — the receipt returned to the client, decoupled from
 * the JPA entity (no {@code version}/{@code updatedAt} leak, and the response stays a stable wire
 * contract). Carries {@code createdAt} — the DB-authoritative order timestamp — so the caller's
 * "my tickets / purchases" list (TM-481) can show and sort by when each order was placed; it is the one
 * timestamp meaningful to the receipt (unlike {@code updatedAt}/{@code version}, which stay internal).
 *
 * @param id          the order's surrogate id
 * @param eventId     the event this order is for
 * @param amountPence what the commitment costs in pence (minor units, GBP); {@code 0} for FREE/INCLUDED
 * @param status      where the order stands ({@code PENDING|CONFIRMED|CANCELLED|REFUND_DUE})
 * @param createdAt   when the order was placed (DB {@code DEFAULT now()}, read back on insert via
 *                    {@code @Generated} — TM-629); non-null for every persisted order, so a FRESH
 *                    checkout response carries the same timestamp shape as an idempotent repeat or
 *                    {@code GET /me/orders}
 */
public record OrderView(Long id, Long eventId, int amountPence, OrderStatus status, Instant createdAt) {

    static OrderView from(Order order) {
        return new OrderView(
                order.getId(), order.getEventId(), order.getAmountPence(), order.getStatus(), order.getCreatedAt());
    }
}
