package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.OrderQueryService;
import com.teammarhaba.backend.membership.OrderView;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's checkout orders under {@code /api/v1/me/orders} (TM-481; the {@code /api/v1} prefix is
 * applied by {@link ApiV1Config}) — the "my tickets / purchases" history behind the membership screen.
 * Reaching it requires a valid Firebase {@code Bearer} token; an anonymous/invalid token gets the uniform
 * RFC 7807 {@code 401} from the security chain (default-deny). Identity always comes from the verified
 * {@link VerifiedUser} principal, never the client, so a caller can only ever read their own orders.
 *
 * <ul>
 *   <li>{@code GET /me/orders} — the caller's orders newest-first (TM-481): each carries the event, the
 *       amount in pence, the status ({@code PENDING|CONFIRMED|CANCELLED|REFUND_DUE}) and when it was
 *       placed. Read-only — this slice adds no schema and reads the orders checkout (TM-477) recorded; a
 *       caller with no purchases gets an empty list, never a 404.</li>
 * </ul>
 */
@RestController
public class OrderController {

    private final OrderQueryService orders;

    OrderController(OrderQueryService orders) {
        this.orders = orders;
    }

    /** The caller's own orders, newest first. Empty list when they have never checked anything out. */
    @GetMapping("/me/orders")
    List<OrderView> myOrders(@AuthenticationPrincipal VerifiedUser caller) {
        return orders.listForCaller(caller);
    }
}
