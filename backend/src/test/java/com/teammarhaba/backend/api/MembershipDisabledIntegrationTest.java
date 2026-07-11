package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.TestcontainersConfiguration;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.SubscriptionRenewalScheduler;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The prod-off guard for the SERVER-SIDE membership flag (TM-623). This boots the context with
 * {@code app.membership.enabled=false} — <em>exactly what production runs today</em> (deploy.yml sets
 * {@code MEMBERSHIP_ENABLED=false} explicitly) — and proves over real HTTP that the money-moving
 * surface does not exist:
 *
 * <ul>
 *   <li>{@code POST /me/subscription/checkout} and {@code POST /me/subscription/cancel} are 404 for
 *       an authenticated caller — previously any Firebase user could curl them into creating REAL
 *       provider orders while the web flag was "off" (the deploy-blocker finding).</li>
 *   <li>Switching INTO a paid tier is 403; the free-tier switch and every read remain available.</li>
 *   <li>The off-session charging scheduler bean is not created at all — no tick can ever fire.</li>
 *   <li>The payment provider is never touched by any of it (the mock records zero interactions).</li>
 * </ul>
 *
 * <p>Its own context (a distinct property source from {@code AbstractIntegrationTest}) so it can't
 * reuse the flag-on cached context the rest of the suite shares.
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
@TestPropertySource(properties = {"app.membership.enabled=false", "app.subscriptions.enabled=true"})
@AutoConfigureMockMvc
class MembershipDisabledIntegrationTest {

    @Autowired
    private ApplicationContext context;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    /** The payment seam, mocked — and expected to record ZERO interactions while the flag is off. */
    @MockitoBean
    private PaymentProvider payments;

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    @Test
    void subscriptionCheckoutIs404WhileTheFlagIsOff() throws Exception {
        mockMvc.perform(post("/api/v1/me/subscription/checkout")
                        .with(caller("uid-flag-off-checkout"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isNotFound());
        Mockito.verifyNoInteractions(payments); // no provider customer, no provider order — no money path
    }

    @Test
    void subscriptionCancelIs404WhileTheFlagIsOff() throws Exception {
        mockMvc.perform(post("/api/v1/me/subscription/cancel").with(caller("uid-flag-off-cancel")))
                .andExpect(status().isNotFound());
    }

    @Test
    void paidTierSwitchIs403WhileTheFlagIsOff() throws Exception {
        mockMvc.perform(post("/api/v1/me/membership/tier")
                        .with(caller("uid-flag-off-tier"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void readsStayAvailableWhileTheFlagIsOff() throws Exception {
        // The gate covers money movement only: subscription state + membership reads keep working, so
        // the app can always render honestly whatever the flag says.
        mockMvc.perform(get("/api/v1/me/subscription").with(caller("uid-flag-off-read")))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/me/membership").with(caller("uid-flag-off-read")))
                .andExpect(status().isOk());
    }

    @Test
    void renewalSchedulerBeanDoesNotExistWhileTheFlagIsOff() {
        // SUBSCRIPTIONS_ENABLED=true alone (see @TestPropertySource) must NOT boot the charging
        // scheduler: the membership flag is the coupled kill switch, so a feature rollback stops
        // off-session charging with it.
        assertThat(context.getBeanNamesForType(SubscriptionRenewalScheduler.class))
                .as("the off-session charging scheduler must not exist while app.membership.enabled is off")
                .isEmpty();
    }

    // ------------------------------------------------------------------ direct join verbs (TM-625)

    @Test
    void rsvpOnAPremiumEventIsUngatedWhileTheFlagIsOff() throws Exception {
        // While the paid feature is OFF there is no paid path at all, so the RSVP verb keeps its exact
        // pre-membership behaviour: a premium event joins directly, no entitlement gate fires, and the
        // payment provider is never touched. (With the flag ON the same request is a 402 — proven by
        // EventRsvpPaidGateIntegrationTest against the flag-on context.)
        Event event = premiumEvent();

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-flag-off-rsvp")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        Mockito.verifyNoInteractions(payments);
    }

    @Test
    void claimOnAPremiumEventIsUngatedWhileTheFlagIsOff() throws Exception {
        // Same legacy contract for the claim verb: a waitlisted member promotes into a premium event
        // without any payment gate while the feature is off.
        Event event = premiumEvent();
        Long userId = users.save(new User("uid-flag-off-claim", "uid-flag-off-claim@example.com", "Member"))
                .getId();
        attendance.save(new EventAttendance(event.getId(), userId, AttendanceState.WAITLISTED));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(caller("uid-flag-off-claim")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        Mockito.verifyNoInteractions(payments);
    }

    @Test
    void refundSweepSchedulerBeanDoesNotExistWhileTheFlagIsOff() {
        // The REFUND_DUE retry sweeper (TM-625) moves money too (provider refunds), so like the renewal
        // scheduler it requires BOTH app.subscriptions.enabled AND app.membership.enabled to be
        // explicitly true. This context runs subscriptions.enabled=true with membership off, so it is
        // specifically the membership half of the pair keeping the bean out here (TM-629). The rollback
        // stops only the SCHEDULERS: the always-open webhook confirm paths can still produce (and
        // inline-attempt) refunds while the flag is off — those rows wait for the sweep to resume.
        assertThat(context.getBeanNamesForType(com.teammarhaba.backend.membership.RefundSweepScheduler.class))
                .as("the refund sweeper must not exist while app.membership.enabled is off")
                .isEmpty();
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out. */
    private Event premiumEvent() {
        Instant now = Instant.now();
        Long creatorId = users.save(
                        new User("uid-flag-off-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
        Event event = new Event(
                "Flag off " + UUID.randomUUID(),
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now);
        event.setPricePence(1500);
        event.setPremium(true);
        return events.save(event);
    }
}
