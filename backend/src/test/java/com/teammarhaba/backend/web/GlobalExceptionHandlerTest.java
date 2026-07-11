package com.teammarhaba.backend.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.EmailVerificationService;
import com.teammarhaba.backend.auth.FirebaseAccountStateService;
import com.teammarhaba.backend.common.InvalidListQueryException;
import com.teammarhaba.backend.user.UserAdminService;
import com.teammarhaba.backend.user.UserService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Verifies the global RFC 7807 mappings: validation -> 400, not-found -> 404,
 * conflict -> 409, and an unmapped exception -> a generic 500 that never leaks the
 * underlying message or a stack trace. Security filters are disabled
 * ({@code addFilters = false}) so the test exercises the error model directly, not the
 * default-deny auth chain (TM-79) — these test routes aren't part of the permit-list.
 */
@WebMvcTest
@AutoConfigureMockMvc(addFilters = false)
@Import(GlobalExceptionHandlerTest.TestController.class)
class GlobalExceptionHandlerTest {

    @Autowired
    private MockMvc mockMvc;

    // The web slice loads every @RestController; MeController (TM-112) needs a UserService, an
    // EmailVerificationService (TM-165) and a FirebaseAccountStateService (TM-164), and — since TM-170 —
    // a TermsProperties (the current-terms-version config; @ConfigurationPropertiesScan doesn't run in a
    // @WebMvcTest slice, so it must be supplied here), UserAdminController (TM-111) needs a
    // UserAdminService, AuditController (TM-137) needs an AuditService, and EmailCodeController (TM-234)
    // needs an EmailCodeService and, since TM-247, an EmailCodeRateLimiter — none supplied by a
    // @WebMvcTest. These mocks satisfy that wiring; never called, since the tests only hit /test routes.
    @MockitoBean
    private UserService userService;

    @MockitoBean
    private com.teammarhaba.backend.config.TermsProperties termsProperties;

    @MockitoBean
    private com.teammarhaba.backend.auth.EmailCodeService emailCodeService;

    @MockitoBean
    private com.teammarhaba.backend.auth.EmailCodeRateLimiter emailCodeRateLimiter;

    @MockitoBean
    private EmailVerificationService emailVerificationService;

    @MockitoBean
    private FirebaseAccountStateService accountStateService;

    @MockitoBean
    private UserAdminService userAdminService;

    @MockitoBean
    private AuditService auditService;

    // DeviceController (TM-283) needs a DeviceTokenService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.device.DeviceTokenService deviceTokenService;

    // PushAdminController (TM-363) needs a BroadcastService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.notify.BroadcastService broadcastService;

    // AdminMessageController (TM-441) needs an AdminMessageService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.messaging.AdminMessageService adminMessageService;

    // EventAdminController (TM-392) needs an EventAdminService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.event.EventAdminService eventAdminService;

    // AlertController + AlertAdminController (TM-243) need an AlertService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.alert.AlertService alertService;

    // EventController (TM-393) needs the event query + RSVP services — supply them so the web
    // slice can load.
    @MockitoBean
    private com.teammarhaba.backend.event.EventQueryService eventQueryService;

    @MockitoBean
    private com.teammarhaba.backend.event.EventRsvpService eventRsvpService;

    // EventAdminController (TM-408) also needs a LocationRevealPolicy — supply it so the slice loads.
    @MockitoBean
    private com.teammarhaba.backend.event.LocationRevealPolicy locationRevealPolicy;

    // EventAdminController (TM-523) also resolves the booking-cutoff + cancellation-window policies for
    // the admin projection — supply them so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.event.BookingCutoffPolicy bookingCutoffPolicy;

    @MockitoBean
    private com.teammarhaba.backend.event.CancellationPolicy cancellationPolicy;

    // NotificationController (TM-454) needs a NotificationFeedService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.notify.NotificationFeedService notificationFeedService;

    // MessageReactionController (TM-461) needs a MessageReactionService — supply it so the web slice
    // can load. ConversationReadService (TM-436) also depends on it for the thread-messages reaction
    // summary, but that bean is mocked below, so only the controller's direct dependency matters here.
    @MockitoBean
    private com.teammarhaba.backend.chat.MessageReactionService messageReactionService;

    // ConversationController (TM-436) needs a ConversationReadService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.chat.ConversationReadService conversationReadService;

    // ConversationController's POST (TM-447) needs a MessagePostService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.chat.MessagePostService messagePostService;

    // ChatSeedController (TM-587, the non-prod test seed hook) needs a ChatSeedService — supply it so the
    // web slice can load. That controller is @ConditionalOnProperty(app.test-seed.enabled) + @Profile
    // ("!prod"); this slice runs on the default `dev` profile where the flag is on, so it IS loaded here.
    @MockitoBean
    private com.teammarhaba.backend.testsupport.ChatSeedService chatSeedService;

    // ChatModerationAdminController (TM-449) needs a ChatModerationService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.chat.ChatModerationService chatModerationService;

    // ConversationStreamController (TM-464) needs a ChatStreamService (the live SSE hub) — supply it so
    // the web slice can load. Its other dependency, ConversationReadService, is already mocked above.
    @MockitoBean
    private com.teammarhaba.backend.chat.ChatStreamService chatStreamService;

    // ConversationController's mute/leave/rejoin (TM-471) needs a ConversationMembershipService — supply
    // it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.chat.ConversationMembershipService conversationMembershipService;

    // ConversationController's edit/delete-own-message (TM-467) needs a MessageAuthorService — supply it
    // so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.chat.MessageAuthorService messageAuthorService;

    // ConversationTypingController (TM-465) needs a TypingSignalService — supply it so the web slice can
    // load. Its other collaborators (ConversationReadService, ChatStreamService) are already mocked above.
    @MockitoBean
    private com.teammarhaba.backend.chat.TypingSignalService typingSignalService;

    // MembershipController (TM-474) needs a MembershipService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.membership.MembershipService membershipService;

    // EventController's /entitlement route (TM-476) needs an EntitlementService — supply it so the web
    // slice can load.
    @MockitoBean
    private com.teammarhaba.backend.membership.EntitlementService entitlementService;

    // EventController's /checkout routes (TM-477) need a CheckoutService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.membership.CheckoutService checkoutService;

    // OrderController's /me/orders route (TM-481) needs an OrderQueryService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.membership.OrderQueryService orderQueryService;

    // PaymentWebhookController's /payments/revolut/webhook route (TM-478) needs a PaymentWebhookService —
    // supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.payments.PaymentWebhookService paymentWebhookService;

    // SubscriptionController + SubscriptionAdminController (TM-620) need a SubscriptionService — supply
    // it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.membership.SubscriptionService subscriptionService;

    // LinkPreviewController (TM-470) needs a LinkPreviewService — supply it so the web slice can load.
    @MockitoBean
    private com.teammarhaba.backend.linkpreview.LinkPreviewService linkPreviewService;

    @Test
    void validationErrorReturns400ProblemDetail() throws Exception {
        mockMvc.perform(post("/test/echo")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.errors[0].field").value("name"));
    }

    @Test
    void notFoundReturns404() throws Exception {
        mockMvc.perform(get("/test/missing"))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Resource not found"))
                .andExpect(jsonPath("$.detail").value("widget 42 not found"));
    }

    @Test
    void conflictReturns409() throws Exception {
        mockMvc.perform(get("/test/conflict"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.title").value("Conflict"))
                .andExpect(jsonPath("$.status").value(409));
    }

    @Test
    void invalidListQueryReturns400() throws Exception {
        mockMvc.perform(get("/test/badlist"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Invalid request"))
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.detail").value("Unknown sort property 'ssn'."));
    }

    @Test
    void optimisticLockConflictReturns409() throws Exception {
        mockMvc.perform(get("/test/stale"))
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Conflict"))
                .andExpect(jsonPath("$.status").value(409));
    }

    @Test
    void unexpectedReturns500WithoutLeakingDetails() throws Exception {
        mockMvc.perform(get("/test/boom"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.title").value("Internal server error"))
                .andExpect(jsonPath("$.detail").value("An unexpected error occurred."))
                .andExpect(jsonPath("$.trace").doesNotExist());
    }

    @RestController
    @RequestMapping("/test")
    static class TestController {

        record Body(@NotBlank String name) {}

        @PostMapping("/echo")
        void echo(@Valid @RequestBody Body body) {
            // no-op: the @Valid binding is what we exercise
        }

        @GetMapping("/missing")
        void missing() {
            throw new ResourceNotFoundException("widget 42 not found");
        }

        @GetMapping("/conflict")
        void conflict() {
            throw new DataIntegrityViolationException("duplicate key");
        }

        @GetMapping("/stale")
        void stale() {
            throw new ObjectOptimisticLockingFailureException("users", 1L);
        }

        @GetMapping("/badlist")
        void badlist() {
            throw new InvalidListQueryException("Unknown sort property 'ssn'.");
        }

        @GetMapping("/boom")
        void boom() {
            throw new IllegalStateException("secret internal detail");
        }
    }
}
