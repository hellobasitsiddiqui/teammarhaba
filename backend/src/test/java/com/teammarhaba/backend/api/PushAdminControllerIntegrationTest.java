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
import com.teammarhaba.backend.user.NotificationPref;
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

    /**
     * Seed a push-eligible ({@code notificationPref = PUSH}) active account. Seeding as PUSH is
     * deliberate: {@code notificationPref} defaults to {@code EMAIL} (the push opt-out) for every
     * account, so a would-be recipient must opt in for the TM-364 opt-out rail to let the send through.
     */
    private long seedUser(String uid) {
        return seedUser(uid, NotificationPref.PUSH);
    }

    private long seedUser(String uid, NotificationPref pref) {
        User u = new User(uid, uid + "@example.com", null);
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String token) {
        tokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    /**
     * Hand an existing (globally-unique) token to a new owner — the same idempotent-upsert re-point a
     * real re-registration does ({@link DeviceToken#refresh}), so no duplicate row is created.
     */
    private void handToken(String token, long newUserId) {
        DeviceToken existing = tokens.findByToken(token).orElseThrow();
        existing.refresh(newUserId, DevicePlatform.ANDROID, Instant.now());
        tokens.saveAndFlush(existing);
    }

    /** Suspend an account ({@code enabled = false}) — {@code setEnabled} is package-private, so reflect. */
    private void disable(long userId) {
        User u = users.findById(userId).orElseThrow();
        setUserField(u, "enabled", false);
        users.saveAndFlush(u);
    }

    /** Soft-delete (tombstone) an account so the entity's {@code @SQLRestriction} hides it. */
    private void softDelete(long userId) {
        User u = users.findById(userId).orElseThrow();
        setUserField(u, "deletedAt", Instant.now());
        users.saveAndFlush(u);
    }

    private static void setUserField(User user, String name, Object value) {
        try {
            var field = User.class.getDeclaredField(name);
            field.setAccessible(true);
            field.set(user, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
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
                        .with(admin("admin-multi"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(id), "Broadcast", "To all your devices", "#/home")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.requested").value(1))
                .andExpect(jsonPath("$.sent").value(1))
                .andExpect(jsonPath("$.skipped").value(0))
                .andExpect(jsonPath("$.targeted").value(3))
                .andExpect(jsonPath("$.delivered").value(3))
                .andExpect(jsonPath("$.dedupedTokens").value(0))
                .andExpect(jsonPath("$.skippedOptedOut").value(0))
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
                        .with(admin("admin-mixed"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(real, noDevices, ghost), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.requested").value(3))
                .andExpect(jsonPath("$.sent").value(1))
                .andExpect(jsonPath("$.skipped").value(2))
                .andExpect(jsonPath("$.skippedNotFound").value(1))
                .andExpect(jsonPath("$.delivered").value(1))
                .andExpect(jsonPath("$.recipients.length()").value(3))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + real + ")].outcome").value("SENT"))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + noDevices + ")].outcome").value("NO_DEVICES"))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + ghost + ")].outcome").value("SKIPPED_NOT_FOUND"));

        // Only the real user's token was ever attempted.
        assertThat(sender.sentTokens()).containsExactly("tok-real");
    }

    // --- Safety rails (TM-364) -------------------------------------------------------------------

    @Test
    void optedOutRecipientIsSkippedAndNeverPushed() throws Exception {
        long optedOut = seedUser("opted-out", NotificationPref.EMAIL); // EMAIL == push opt-out
        seedToken(optedOut, "tok-optout"); // has a device, but opted out of push
        long optedIn = seedUser("opted-in", NotificationPref.BOTH);
        seedToken(optedIn, "tok-optin");

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-optout"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(optedOut, optedIn), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sent").value(1))
                .andExpect(jsonPath("$.skipped").value(1))
                .andExpect(jsonPath("$.skippedOptedOut").value(1))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + optedOut + ")].outcome").value("SKIPPED_OPTED_OUT"))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + optedIn + ")].outcome").value("SENT"));

        // The opted-out user's token was never handed to the sender; only the opted-in user's was.
        assertThat(sender.sentTokens()).containsExactly("tok-optin");
    }

    @Test
    void disabledRecipientIsSkippedAndNeverPushed() throws Exception {
        long suspended = seedUser("suspended");
        seedToken(suspended, "tok-suspended");
        disable(suspended);

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-disabled"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(suspended), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sent").value(0))
                .andExpect(jsonPath("$.skipped").value(1))
                .andExpect(jsonPath("$.skippedDisabled").value(1))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + suspended + ")].outcome").value("SKIPPED_DISABLED"));

        assertThat(sender.sentTokens()).isEmpty();
    }

    @Test
    void softDeletedRecipientIsExcludedAndTokenNeverLeaked() throws Exception {
        long gone = seedUser("soft-deleted");
        seedToken(gone, "tok-ghost"); // token row survives the soft-delete (cascade is hard-delete only)
        softDelete(gone);

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-softdel"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(gone), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sent").value(0))
                .andExpect(jsonPath("$.skipped").value(1))
                .andExpect(jsonPath("$.skippedNotFound").value(1))
                .andExpect(jsonPath("$.recipients[?(@.userId==" + gone + ")].outcome").value("SKIPPED_NOT_FOUND"));

        // The retained device-token row must NOT be pushed — resolution goes through User, not tokens.
        assertThat(sender.sentTokens()).isEmpty();
    }

    @Test
    void handedDownDeviceTokenIsPushedOnceAcrossASelectionOfBothUsers() throws Exception {
        // A device token is globally UNIQUE (device_tokens_token_key), so a handed-down phone's token
        // lives on exactly one row: re-registering it re-points that row to the new owner (upsert),
        // rather than duplicating it. Here "tok-shared" starts on A, is handed to B, and both users are
        // then selected — it must reach the sender exactly once (now as B's device), never twice.
        long userA = seedUser("handed-a");
        long userB = seedUser("handed-b");
        seedToken(userA, "tok-own-a");
        seedToken(userB, "tok-own-b");
        seedToken(userA, "tok-shared");
        handToken("tok-shared", userB); // upsert-style handoff: the unique row moves from A to B

        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-handed"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(List.of(userA, userB), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sent").value(2))
                .andExpect(jsonPath("$.targeted").value(3)) // own-a + own-b + shared (once), not 4
                .andExpect(jsonPath("$.delivered").value(3));

        // The handed-down token was delivered exactly once across the whole broadcast (never double-sent).
        assertThat(sender.sentTokens())
                .containsExactlyInAnyOrder("tok-own-a", "tok-own-b", "tok-shared");
        assertThat(sender.sentTokens().stream().filter("tok-shared"::equals).count()).isEqualTo(1);
    }

    @Test
    void emptyRecipientsIsRejected() throws Exception {
        // Belt-and-braces: the DTO @NotEmpty makes this a validation 400; the service also guards it.
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-empty"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userIds\":[],\"title\":\"Hi\",\"body\":\"There\"}"))
                .andExpect(status().isBadRequest());

        assertThat(sender.sentTokens()).isEmpty();
    }

    @Test
    void secondBroadcastFromSameAdminInsideCooldownIsRejectedWith429() throws Exception {
        long id = seedUser("cooldown-target");
        seedToken(id, "tok-cd");
        String content = body(List.of(id), "Hi", "There", null);

        // First send from this admin succeeds and records the (process-local, real-clock) cooldown window.
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-cooldown"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(content))
                .andExpect(status().isOk());

        // A second send from the SAME admin immediately after is refused with 429 (well inside 30s).
        mockMvc.perform(post("/api/v1/admin/push/broadcast")
                        .with(admin("admin-cooldown"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(content))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.title").value("Too many requests"));

        // The token was delivered once (the first send only) — the blocked resubmit didn't re-push.
        assertThat(sender.sentTokens()).containsExactly("tok-cd");
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
