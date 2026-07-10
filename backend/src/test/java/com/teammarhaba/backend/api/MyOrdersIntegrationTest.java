package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code GET /api/v1/me/orders} end to end (TM-481): the caller's "my tickets / purchases" history over a
 * real Postgres. Proves the endpoint returns the caller's orders newest-first with the full receipt shape
 * (event / amount / status / createdAt), scopes strictly to the signed-in caller, returns an empty list
 * for a caller with no purchases, and 401s an anonymous request. Orders are seeded directly through the
 * repository (the checkout write path is TM-477's own test); this class proves only the read endpoint.
 *
 * <p>The suite shares one database, so every case uses a unique caller uid and its own seeded events.
 */
@AutoConfigureMockMvc
class MyOrdersIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrderRepository orders;

    // ------------------------------------------------------------------ newest-first, full receipt shape

    @Test
    void listsTheCallersOrdersNewestFirstWithTheReceiptShape() throws Exception {
        Long userId = users.save(new User("uid-mo-list", "uid-mo-list@example.com", "Buyer")).getId();

        // Three orders for this caller, seeded oldest → newest. Distinct amounts/statuses so the field
        // mapping is unambiguous; distinct events because (user, event) is unique.
        Long oldest = seedOrder(userId, standardEvent(), 0, OrderStatus.CONFIRMED).getId();
        Long middle = seedOrder(userId, standardEvent(), 500, OrderStatus.PENDING).getId();
        Long newest = seedOrder(userId, standardEvent(), 1500, OrderStatus.CONFIRMED).getId();

        // Newest-first: the last-seeded (highest id) order comes back first; every receipt field is present.
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-mo-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[0].id").value(newest))
                .andExpect(jsonPath("$[0].amountPence").value(1500))
                .andExpect(jsonPath("$[0].status").value("CONFIRMED"))
                .andExpect(jsonPath("$[0].eventId").isNumber())
                .andExpect(jsonPath("$[0].createdAt").isNotEmpty())
                .andExpect(jsonPath("$[1].id").value(middle))
                .andExpect(jsonPath("$[1].amountPence").value(500))
                .andExpect(jsonPath("$[1].status").value("PENDING"))
                .andExpect(jsonPath("$[2].id").value(oldest))
                .andExpect(jsonPath("$[2].amountPence").value(0))
                .andExpect(jsonPath("$[2].status").value("CONFIRMED"));
    }

    // ------------------------------------------------------------------ scoped strictly to the caller

    @Test
    void returnsOnlyTheCallersOwnOrders() throws Exception {
        Long mine = users.save(new User("uid-mo-mine", "uid-mo-mine@example.com", "Mine")).getId();
        Long other = users.save(new User("uid-mo-other", "uid-mo-other@example.com", "Other")).getId();

        Long myOrder = seedOrder(mine, standardEvent(), 500, OrderStatus.CONFIRMED).getId();
        seedOrder(other, standardEvent(), 500, OrderStatus.CONFIRMED); // must never appear for `mine`

        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-mo-mine")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(myOrder));
    }

    // ------------------------------------------------------------------ empty list for a fresh caller

    @Test
    void returnsAnEmptyListForACallerWithNoOrders() throws Exception {
        // A brand-new caller (never checked anything out) is provisioned just-in-time and gets [], not a 404.
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-mo-empty")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }

    // ------------------------------------------------------------------ 401 for an anonymous request

    @Test
    void anonymousRequestGets401() throws Exception {
        mockMvc.perform(get("/api/v1/me/orders")).andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Order seedOrder(Long userId, Event event, int amountPence, OrderStatus status) {
        return orders.save(new Order(userId, event.getId(), amountPence, status, Instant.now()));
    }

    private Long creatorId() {
        return users.save(new User("uid-mo-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event to hang an order off (each order needs its own event: (user, event) is unique). */
    private Event standardEvent() {
        return saveEvent(e -> e.setStartAt(Instant.now().plus(2, ChronoUnit.DAYS)));
    }

    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Orders " + UUID.randomUUID(),
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId(),
                now);
        tweak.accept(event);
        return events.save(event);
    }
}
