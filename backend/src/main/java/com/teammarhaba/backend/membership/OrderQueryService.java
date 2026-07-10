package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Read-only queries over the caller's checkout {@link Order orders} (TM-481) — the data behind the
 * "my tickets / purchases" screen. This slice adds no schema and no writes: it simply reads the orders
 * already recorded by checkout (TM-477) for whoever is signed in and returns them newest-first.
 *
 * <p><strong>Identity is always the verified caller, never the client.</strong> The {@link VerifiedUser}
 * principal is resolved to its account row through {@link UserService#provision} (the same JIT pattern as
 * membership enrolment, TM-474/TM-597) — so a brand-new account that has never checked anything out still
 * gets a clean empty list rather than a 404, and a caller can only ever see their own orders.
 */
@Service
public class OrderQueryService {

    private final OrderRepository orders;
    private final UserService users;

    public OrderQueryService(OrderRepository orders, UserService users) {
        this.orders = orders;
        this.users = users;
    }

    /**
     * The caller's own orders, newest first (TM-481). Runs read-only; {@link UserService#provision}
     * resolves (and, on a first-ever call, provisions) the account so the lookup never fails for a new
     * user — it just returns an empty list. Each {@link Order} is mapped to the wire-safe
     * {@link OrderView} (id / eventId / amountPence / status / createdAt), keeping the JPA entity and its
     * internal {@code version}/{@code updatedAt} out of the response.
     *
     * @param caller the verified principal from the Bearer token.
     * @return the caller's orders newest-first, or an empty list if they have none.
     */
    @Transactional(readOnly = true)
    public List<OrderView> listForCaller(VerifiedUser caller) {
        User user = users.provision(caller);
        return orders.findByUserIdOrderByCreatedAtDescIdDesc(user.getId()).stream()
                .map(OrderView::from)
                .toList();
    }
}
