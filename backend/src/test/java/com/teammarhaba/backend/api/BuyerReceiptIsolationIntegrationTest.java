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
 * Buyer receipt isolation (TM-738 P1 {@code oneBuyerCannotReadAnotherBuyersReceipt}, TM-760): one buyer can
 * never read another buyer's order/receipt.
 *
 * <p>Characterization test for the EXISTING scoping guarantee. A receipt has no dedicated
 * {@code GET /me/orders/{id}} endpoint — the receipt screen is entirely list-derived: it is built client-side
 * from the caller-scoped {@code GET /api/v1/me/orders} list ({@code OrderQueryService.listForCaller}, which
 * resolves the DB user off the verified principal, never the client). So "buyer A cannot read buyer B's
 * receipt" reduces, at the API boundary, to: B's order id never appears in A's list (and vice-versa) — there
 * is no other addressable path to a foreign order. {@code MyOrdersIntegrationTest.returnsOnlyTheCallersOwnOrders}
 * proves one direction against disjoint events; this class hardens it to the tighter, harder case: <em>two
 * different buyers with orders against the SAME shared event</em>, and asserts <em>mutual</em> isolation so a
 * regression that leaked by event id (rather than user id) would be caught. Orders are seeded through the
 * repository (the checkout write path is TM-477's own test); this class proves only the read scoping.
 */
@AutoConfigureMockMvc
class BuyerReceiptIsolationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrderRepository orders;

    // ------------------------------------------------------------------ mutual isolation on a shared event

    @Test
    void neitherBuyerCanSeeTheOthersOrderForTheSameEvent() throws Exception {
        // Two distinct buyers who both purchased against the SAME event — the tight case where a scoping bug
        // that keyed off event id instead of user id would leak one buyer's receipt to the other.
        Long buyerA = users.save(new User("uid-iso-a", "uid-iso-a@example.com", "Buyer A")).getId();
        Long buyerB = users.save(new User("uid-iso-b", "uid-iso-b@example.com", "Buyer B")).getId();

        Event sharedEvent = standardEvent();
        Long orderA = seedOrder(buyerA, sharedEvent, 500, OrderStatus.CONFIRMED).getId();
        Long orderB = seedOrder(buyerB, sharedEvent, 1500, OrderStatus.CONFIRMED).getId();

        // Buyer A sees ONLY their own order — never buyer B's, even though both hang off the same event.
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-iso-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(orderA))
                .andExpect(jsonPath("$[0].amountPence").value(500))
                .andExpect(jsonPath("$[?(@.id == " + orderB + ")]").isEmpty());

        // Buyer B likewise sees ONLY their own — the isolation is mutual, not a one-way filter.
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-iso-b")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(orderB))
                .andExpect(jsonPath("$[0].amountPence").value(1500))
                .andExpect(jsonPath("$[?(@.id == " + orderA + ")]").isEmpty());
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
        return users.save(new User("uid-iso-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event to hang orders off. */
    private Event standardEvent() {
        return saveEvent(e -> e.setStartAt(Instant.now().plus(2, ChronoUnit.DAYS)));
    }

    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Isolation " + UUID.randomUUID(),
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
