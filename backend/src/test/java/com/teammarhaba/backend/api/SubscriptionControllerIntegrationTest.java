package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.MembershipRepository;
import com.teammarhaba.backend.membership.SubscriptionCharge;
import com.teammarhaba.backend.membership.SubscriptionChargeRepository;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import com.teammarhaba.backend.membership.SubscriptionService;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me/subscription} + the admin read (TM-620), end-to-end against the real database
 * (V38 migration + entity mappings validated by the booted context) with the {@link PaymentProvider}
 * seam MOCKED — no live Revolut calls in CI (the sandbox handshake is the post-deploy smoke test).
 *
 * <p>Walks the whole lifecycle over HTTP: the none-state read, the Subscribe checkout (a PENDING
 * INITIAL charge + the widget token), the webhook-driven activation (via
 * {@link SubscriptionService#confirmCharge} — the exact call {@code PaymentWebhookService} makes),
 * the ACTIVE read, cancel (idempotent; tier kept to period end), and the admin state+history view
 * with its 403/401 gating.
 */
@AutoConfigureMockMvc
class SubscriptionControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private SubscriptionRepository subscriptions;

    @Autowired
    private SubscriptionChargeRepository charges;

    @Autowired
    private MembershipRepository memberships;

    @Autowired
    private UserRepository users;

    @Autowired
    private SubscriptionService subscriptionService;

    /** The payment seam, mocked: CI never talks to Revolut. Replaces the RevolutPaymentProvider bean. */
    @MockitoBean
    private PaymentProvider payments;

    @BeforeEach
    void stubProvider() {
        when(payments.name()).thenReturn("revolut");
        // any() (not anyString()) — a JIT-provisioned account's displayName is null at checkout time.
        when(payments.createCustomer(any(), any())).thenReturn("cust-it-1");
        when(payments.createOrderForCustomer(anyInt(), eq("GBP"), anyString(), eq("cust-it-1")))
                .thenReturn(new PaymentOrder("rev-it-order-1", "tok-it-1"));
        when(payments.findMerchantSavedPaymentMethod("cust-it-1")).thenReturn(Optional.of("pm-it-1"));
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private static RequestPostProcessor admin(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"),
                null,
                List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
    }

    @Test
    void neverSubscribedReadsTheNoneState() throws Exception {
        mockMvc.perform(get("/api/v1/me/subscription").with(caller("uid-sub-none")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.subscribed").value(false))
                .andExpect(jsonPath("$.tier").doesNotExist());
    }

    @Test
    void fullLifecycleCheckoutActivateReadCancel() throws Exception {
        var who = caller("uid-sub-life");

        // 1. Subscribe checkout: the locked price + the single-use widget token come back, and a
        //    PENDING INITIAL charge row is recorded carrying the provider order id (the webhook key).
        mockMvc.perform(post("/api/v1/me/subscription/checkout")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tier").value("MONTHLY"))
                .andExpect(jsonPath("$.amountPence").value(999))
                .andExpect(jsonPath("$.paymentToken").value("tok-it-1"))
                .andExpect(jsonPath("$.provider").value("revolut"));

        Long userId = users.findByFirebaseUid("uid-sub-life").orElseThrow().getId();
        SubscriptionCharge charge =
                charges.findByProviderOrderId("rev-it-order-1").orElseThrow();
        assertThat(charge.getUserId()).isEqualTo(userId);
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PENDING);
        assertThat(charge.getKind()).isEqualTo(SubscriptionCharge.Kind.INITIAL);
        // No subscription yet — the client paying the widget does not grant anything.
        assertThat(subscriptions.findByUserId(userId)).isEmpty();

        // 2. The verified settle webhook lands (PaymentWebhookService calls exactly this): the charge is
        //    PAID, the subscription is ACTIVE with the saved card, and the paid tier is GRANTED.
        subscriptionService.confirmCharge("rev-it-order-1");

        var subscription = subscriptions.findByUserId(userId).orElseThrow();
        assertThat(subscription.getSavedPaymentMethodRef()).isEqualTo("pm-it-1");
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("MONTHLY");

        mockMvc.perform(get("/api/v1/me/subscription").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.subscribed").value(true))
                .andExpect(jsonPath("$.tier").value("MONTHLY"))
                .andExpect(jsonPath("$.status").value("ACTIVE"))
                .andExpect(jsonPath("$.renewing").value(true))
                .andExpect(jsonPath("$.amountPence").value(999));

        // 3. A second checkout while ACTIVE is a 409 — no double-subscription.
        mockMvc.perform(post("/api/v1/me/subscription/checkout")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"DIAMOND\"}"))
                .andExpect(status().isConflict());

        // 4. Cancel: renewals stop, the tier is KEPT until the period end (no downgrade here).
        mockMvc.perform(post("/api/v1/me/subscription/cancel").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELED"))
                .andExpect(jsonPath("$.renewing").value(false));
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("MONTHLY");

        // 5. Cancel is idempotent.
        mockMvc.perform(post("/api/v1/me/subscription/cancel").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELED"));

        // 6. The admin view shows the state + the charge history for the account.
        mockMvc.perform(get("/api/v1/admin/users/" + userId + "/subscription")
                        .with(admin("admin-sub")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.subscription.subscribed").value(true))
                .andExpect(jsonPath("$.subscription.status").value("CANCELED"))
                .andExpect(jsonPath("$.charges[0].kind").value("INITIAL"))
                .andExpect(jsonPath("$.charges[0].status").value("PAID"))
                .andExpect(jsonPath("$.charges[0].amountPence").value(999));
    }

    @Test
    void checkoutRejectsTheFreeBaseTierWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/subscription/checkout")
                        .with(caller("uid-sub-free"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"PAY_PER_EVENT\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void cancelWithoutASubscriptionIs404() throws Exception {
        mockMvc.perform(post("/api/v1/me/subscription/cancel").with(caller("uid-sub-nocancel")))
                .andExpect(status().isNotFound());
    }

    @Test
    void adminSubscriptionViewIsAdminOnly() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users/1/subscription").with(caller("uid-sub-plain")))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/v1/admin/users/1/subscription")).andExpect(status().isUnauthorized());
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me/subscription")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/subscription/checkout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isUnauthorized());
    }
}
