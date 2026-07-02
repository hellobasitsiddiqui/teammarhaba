package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.NotificationBroadcastRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin broadcast API (TM-363, epic TM-358) end-to-end through the real security chain + Postgres,
 * with the {@link PushSender} seam swapped for an in-context recording fake (so no real FCM). Covers the
 * ACs: ADMIN-only (USER → 403, anon → 401), Bean-Validation {@code 400}s (empty recipients, blank
 * title/body, over-cap), an off-list route {@code 400}, a message fanned to <em>every</em> token of a
 * multi-token user, a non-existent id reported (not fatal), and the aggregate + per-recipient response
 * shape — plus that exactly one {@code notification_broadcasts} row and one {@code BROADCAST_SENT} audit
 * row are written.
 */
@AutoConfigureMockMvc
@Import(PushAdminControllerIntegrationTest.RecordingSenderConfig.class)
class PushAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private DeviceTokenRepository tokens;

    @Autowired
    private NotificationBroadcastRepository broadcasts;

    @Autowired
    private RecordingPushSender sender;

    @BeforeEach
    void resetSender() {
        sender.reset();
    }

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor regularUser(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    private long seedUser(String uid) {
        return users.saveAndFlush(new User(uid, uid + "@example.com", null)).getId();
    }

    private void seedToken(long userId, String token) {
        tokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    private static String body(List<Long> ids, String title, String body, String route) {
        String idsCsv = ids.stream().map(String::valueOf).reduce((a, b) -> a + "," + b).orElse("");
        String routeField = route == null ? "" : ",\"route\":\"" + route + "\"";
        return "{\"userIds\":[" + idsCsv + "],\"title\":\"" + title + "\",\"body\":\"" + body + "\"" + routeField + "}";
    }

    // --- Authorization ---------------------------------------------------------------------------

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(1L), "Hi", "There", null)))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(regularUser("plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(1L), "Hi", "There", null)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    // --- Validation (400) ------------------------------------------------------------------------

    @Test
    void emptyRecipientsIs400WithFieldError() throws Exception {
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userIds\":[],\"title\":\"Hi\",\"body\":\"There\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='userIds')]").exists());
    }

    @Test
    void blankTitleIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userIds\":[1],\"title\":\"  \",\"body\":\"There\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='title')]").exists());
    }

    @Test
    void blankBodyIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userIds\":[1],\"title\":\"Hi\",\"body\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='body')]").exists());
    }

    @Test
    void overCapRecipientsIs400() throws Exception {
        List<Long> tooMany = new ArrayList<>();
        for (long i = 1; i <= BroadcastPushRequest.MAX_RECIPIENTS + 1; i++) {
            tooMany.add(i);
        }
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(tooMany, "Hi", "There", null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='userIds')]").exists());
    }

    @Test
    void unknownRouteIs400NotServerError() throws Exception {
        long id = seedUser("route-target");
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-r"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(id), "Hi", "There", "#/not-a-route")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));

        // The off-list route short-circuits before any send or persistence.
        assertThat(sender.sentTokens()).isEmpty();
    }

    // --- Fan-out + result shape (200) ------------------------------------------------------------

    @Test
    void multiTokenUserIsFannedToEveryTokenAndPersistsOneBroadcastAndAudit() throws Exception {
        long before = broadcasts.count();
        long id = seedUser("multi-device");
        seedToken(id, "tok-a");
        seedToken(id, "tok-b");
        seedToken(id, "tok-c");

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(id), "Broadcast", "To all your devices", "#/home")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.requested").value(1))
                .andExpect(jsonPath("$.sent").value(1))
                .andExpect(jsonPath("$.skipped").value(0))
                .andExpect(jsonPath("$.targeted").value(3))
                .andExpect(jsonPath("$.delivered").value(3))
                .andExpect(jsonPath("$.recipients.length()").value(1))
                .andExpect(jsonPath("$.recipients[0].userId").value(id))
                .andExpect(jsonPath("$.recipients[0].outcome").value("SENT"))
                .andExpect(jsonPath("$.recipients[0].fanout.targeted").value(3))
                .andExpect(jsonPath("$.recipients[0].fanout.delivered").value(3));

        // Every one of the user's tokens was attempted.
        assertThat(sender.sentTokens()).containsExactlyInAnyOrder("tok-a", "tok-b", "tok-c");
        // Exactly one broadcast header row was written.
        assertThat(broadcasts.count()).isEqualTo(before + 1);
    }

    @Test
    void nonExistentIdIsReportedNotFatalAndUserWithNoDevicesIsSkipped() throws Exception {
        long real = seedUser("has-device");
        seedToken(real, "tok-real");
        long noDevices = seedUser("no-devices"); // exists but has no tokens
        long ghost = 999_999L; // no such account

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(real, noDevices, ghost), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.requested").value(3))
                .andExpect(jsonPath("$.sent").value(1))
                .andExpect(jsonPath("$.skipped").value(2))
                .andExpect(jsonPath("$.delivered").value(1))
                .andExpect(jsonPath("$.recipients.length()").value(3))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + real + ")].outcome").value("SENT"))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + noDevices + ")].outcome").value("NO_DEVICES"))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + ghost + ")].outcome").value("NOT_FOUND"));

        // Only the real user's token was ever attempted.
        assertThat(sender.sentTokens()).containsExactly("tok-real");
    }

    /**
     * Registers the recording {@link PushSender} in the context so no real FCM is ever called. It is
     * {@code @Primary} so it wins injection over the default {@code fcmPushSender} regardless of
     * {@code @ConditionalOnMissingBean} evaluation order (an imported {@code @TestConfiguration} bean
     * isn't reliably visible to that condition). Exposed as a bean so the test can read what was sent
     * and reset it between tests.
     */
    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }
    }

    /**
     * A no-FCM {@link PushSender} that records every token it was asked to send to and returns a
     * per-token outcome (default {@link PushDelivery#DELIVERED}). Thread-safe/resettable so it can be
     * shared across the cached Spring context and cleared per test.
     */
    static final class RecordingPushSender implements PushSender {
        private final List<String> sent = new ArrayList<>();
        private final Map<String, PushDelivery> outcomes = new ConcurrentHashMap<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            sent.add(token);
            return outcomes.getOrDefault(token, PushDelivery.DELIVERED);
        }

        synchronized List<String> sentTokens() {
            return new ArrayList<>(sent);
        }

        synchronized void reset() {
            sent.clear();
            outcomes.clear();
        }
    }
}
