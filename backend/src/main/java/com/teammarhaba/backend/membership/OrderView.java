package com.teammarhaba.backend.membership;

/**
 * The JSON view of a checkout {@link Order} (TM-477) — the receipt returned to the client, decoupled from
 * the JPA entity (no {@code version}/timestamps leak, and the response stays a stable wire contract).
 *
 * @param id          the order's surrogate id
 * @param eventId     the event this order is for
 * @param amountPence what the commitment costs in pence (minor units, GBP); {@code 0} for FREE/INCLUDED
 * @param status      where the order stands ({@code PENDING|CONFIRMED|CANCELLED|REFUND_DUE})
 */
public record OrderView(Long id, Long eventId, int amountPence, OrderStatus status) {

    static OrderView from(Order order) {
        return new OrderView(order.getId(), order.getEventId(), order.getAmountPence(), order.getStatus());
    }
}
