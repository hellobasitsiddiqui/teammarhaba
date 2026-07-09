package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.messaging.AdminMessage;
import com.teammarhaba.backend.messaging.AdminMessageRepository;
import com.teammarhaba.backend.messaging.TargetType;
import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
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
 * The admin send API (TM-441, epic TM-432) end-to-end through the real security chain + Postgres, with
 * the {@link PushSender} seam swapped for an in-context recording fake (so no real FCM). Covers the ACs:
 *
 * <ul>
 *   <li><b>admin-gated / one-way</b> — anonymous → 401, USER → 403 (a recipient can never send; an
 *       admin message is a durable notification with no reply endpoint, so the channel is one-way);
 *   <li><b>length caps + one-target-type</b> — Bean-Validation 400s (blank/over-cap title/body,
 *       zero or multiple target types), an off-list deep-link 400, and an empty resolution 400;
 *   <li><b>targeting</b> — user / city / event audiences resolve to the right recipients;
 *   <li><b>membership</b> — one durable {@code ADMIN_MESSAGE} inbox row per recipient, cross-linked to
 *       the campaign by {@code source_ref = admin_message:<id>}, carrying the full (up-to-5000-char)
 *       body; a push respects opt-out while the inbox does not;
 *   <li><b>audit</b> — exactly one {@code admin_message} header row and one {@code ADMIN_MESSAGE_SENT}
 *       audit row per send.
 * </ul>
 */
@AutoConfigureMockMvc
@Import(AdminMessageControllerIntegrationTest.RecordingSenderConfig.class)
class AdminMessageControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private DeviceTokenRepository tokens;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private NotificationRepository notifications;

    @Autowired
    private AdminMessageRepository adminMessages;

    @Autowired
    private AuditRepository audits;

    @Autowired
    private RecordingPushSender sender;

    @BeforeEach
    void resetSender() {
        sender.reset();
    }

    // --- principals --------------------------------------------------------------------------------

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

    // --- seeding -----------------------------------------------------------------------------------

    /** A push-eligible ({@code notificationPref = PUSH}) active account, optionally in a city. */
    private long seedUser(String uid, String city) {
        return seedUser(uid, city, NotificationPref.PUSH);
    }

    private long seedUser(String uid, String city, NotificationPref pref) {
        User u = new User(uid, uid + "@example.com", uid);
        u.setCity(city);
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String token) {
        tokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    private long seedEvent(String heading) {
        Instant now = Instant.now();
        long creator = seedUser(heading + "-creator", null);
        return events.saveAndFlush(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        creator,
                        now))
                .getId();
    }

    private void attend(long eventId, long userId) {
        attendance.saveAndFlush(new EventAttendance(eventId, userId, AttendanceState.GOING));
    }

    // --- request bodies ----------------------------------------------------------------------------

    private static String jsonArray(List<Long> ids) {
        return ids.stream().map(String::valueOf).reduce((a, b) -> a + "," + b).orElse("");
    }

    private static String userBody(List<Long> ids, String title, String body, String deepLink) {
        String dl = deepLink == null ? "" : ",\"deepLink\":\"" + deepLink + "\"";
        return "{\"title\":\"" + title + "\",\"body\":\"" + body + "\",\"userIds\":[" + jsonArray(ids) + "]" + dl + "}";
    }

    private Notification onlyAdminNotification(long userId) {
        List<Notification> rows = notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .toList();
        assertThat(rows).hasSize(1);
        return rows.get(0);
    }

    // --- authorization / one-way -------------------------------------------------------------------

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(1L), "Hi", "There", null)))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminCannotSendSoTheChannelIsOneWay() throws Exception {
        // A recipient (regular USER) can never post an admin message — the endpoint is admin-only, so
        // the ADMIN_BROADCAST channel is one-way (enforced server-side by the security gate).
        long target = seedUser("one-way-target", null);
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(regularUser("plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(target), "Hi", "There", null)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));

        // Nothing was persisted or pushed by the rejected send.
        assertThat(onlyAdminNotificationCount(target)).isZero();
        assertThat(sender.sentTokens()).isEmpty();
    }

    private long onlyAdminNotificationCount(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .count();
    }

    // --- validation (400) --------------------------------------------------------------------------

    @Test
    void noTargetTypeIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Hi\",\"body\":\"There\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='exactlyOneTargetType')]").exists());
    }

    @Test
    void combiningTwoTargetTypesIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Hi\",\"body\":\"There\",\"userIds\":[1],\"cities\":[\"London\"]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='exactlyOneTargetType')]").exists());
    }

    @Test
    void blankTitleIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"  \",\"body\":\"There\",\"userIds\":[1]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='title')]").exists());
    }

    @Test
    void overCapBodyIs400() throws Exception {
        String body = "x".repeat(AdminMessageRequest.MAX_BODY_LENGTH + 1);
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-v"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(1L), "Hi", body, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='body')]").exists());
    }

    @Test
    void unknownDeepLinkIs400NotServerError() throws Exception {
        long id = seedUser("route-target", null);
        seedToken(id, "tok-route");
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-r"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(id), "Hi", "There", "#/not-a-route")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));

        // The off-list route short-circuits before any resolve, persist or send.
        assertThat(sender.sentTokens()).isEmpty();
        assertThat(onlyAdminNotificationCount(id)).isZero();
    }

    @Test
    void audienceResolvingToNobodyIs400() throws Exception {
        long before = adminMessages.count();
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-empty"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Hi\",\"body\":\"There\",\"cities\":[\"Nowheresville\"]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));

        // A send to nobody persists no campaign header.
        assertThat(adminMessages.count()).isEqualTo(before);
        assertThat(sender.sentTokens()).isEmpty();
    }

    // --- targeting + membership + audit ------------------------------------------------------------

    @Test
    void userTargetDeliversInboxAndPushAndAuditsOnce() throws Exception {
        long before = adminMessages.count();
        long alice = seedUser("send-alice", null);
        long bob = seedUser("send-bob", null);
        seedToken(alice, "tok-alice");
        seedToken(bob, "tok-bob");

        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-send"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(alice, bob), "Meetup Friday", "See you at 7", "#/home")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.targetType").value("USER"))
                .andExpect(jsonPath("$.recipientCount").value(2))
                .andExpect(jsonPath("$.notified").value(2))
                .andExpect(jsonPath("$.pushTargeted").value(2))
                .andExpect(jsonPath("$.pushDelivered").value(2))
                .andExpect(jsonPath("$.pushSkipped").value(0));

        // One campaign header, attributed, with the right target + recipient count.
        assertThat(adminMessages.count()).isEqualTo(before + 1);
        AdminMessage campaign =
                adminMessages.findByActorUidOrderByCreatedAtDesc("admin-send").get(0);
        assertThat(campaign.getTargetType()).isEqualTo(TargetType.USER);
        assertThat(campaign.getRecipientCount()).isEqualTo(2);
        assertThat(campaign.getTitle()).isEqualTo("Meetup Friday");

        // One durable ADMIN_MESSAGE inbox row per recipient, cross-linked to the campaign, not sticky.
        String sourceRef = "admin_message:" + campaign.getId();
        for (long userId : List.of(alice, bob)) {
            Notification row = onlyAdminNotification(userId);
            assertThat(row.getTitle()).isEqualTo("Meetup Friday");
            assertThat(row.getBody()).isEqualTo("See you at 7");
            assertThat(row.getDeepLink()).isEqualTo("#/home");
            assertThat(row.getSourceRef()).isEqualTo(sourceRef);
            assertThat(row.isSticky()).isFalse();
        }

        // Push reached every recipient's device.
        assertThat(sender.sentTokens()).containsExactlyInAnyOrder("tok-alice", "tok-bob");

        // Exactly one ADMIN_MESSAGE_SENT audit row, targeting the campaign, with the counts (never body).
        List<AuditEvent> auditRows =
                audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc("AdminMessage", String.valueOf(campaign.getId()));
        assertThat(auditRows).hasSize(1);
        AuditEvent audit = auditRows.get(0);
        assertThat(audit.getAction()).isEqualTo(AuditAction.ADMIN_MESSAGE_SENT);
        assertThat(audit.getActorUid()).isEqualTo("admin-send");
        assertThat(audit.getMetadata())
                .containsEntry("targetType", "USER")
                .containsEntry("route", "#/home")
                .containsKeys("recipientCount", "notified", "pushTargeted", "pushDelivered", "pushSkipped")
                .doesNotContainKey("body"); // the body is never in the audit metadata
    }

    @Test
    void cityTargetResolvesEveryMatchingActiveAccount() throws Exception {
        long londonerA = seedUser("city-a", "Bristol");
        long londonerB = seedUser("city-b", "bristol"); // case-insensitive match
        long elsewhere = seedUser("city-elsewhere", "Leeds");

        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-city"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Bristol\",\"body\":\"Local news\",\"cities\":[\"Bristol\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.targetType").value("CITY"))
                .andExpect(jsonPath("$.recipientCount").value(2))
                .andExpect(jsonPath("$.notified").value(2));

        assertThat(onlyAdminNotificationCount(londonerA)).isEqualTo(1);
        assertThat(onlyAdminNotificationCount(londonerB)).isEqualTo(1);
        assertThat(onlyAdminNotificationCount(elsewhere)).isZero();
    }

    @Test
    void eventTargetResolvesGoingAttendeesOnly() throws Exception {
        long eventId = seedEvent("event-send");
        long going = seedUser("evt-going", null);
        long notGoing = seedUser("evt-absent", null);
        attend(eventId, going);

        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-evt"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Event\",\"body\":\"Reminder\",\"eventIds\":[" + eventId + "]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.targetType").value("EVENT"))
                .andExpect(jsonPath("$.recipientCount").value(1))
                .andExpect(jsonPath("$.notified").value(1));

        assertThat(onlyAdminNotificationCount(going)).isEqualTo(1);
        assertThat(onlyAdminNotificationCount(notGoing)).isZero();
    }

    // --- length cap + push preview -----------------------------------------------------------------

    @Test
    void fullLongBodyIsStoredInTheInboxWhilePushIsATruncatedPreview() throws Exception {
        long id = seedUser("long-body", null);
        seedToken(id, "tok-long");
        String longBody = "y".repeat(AdminMessageRequest.MAX_BODY_LENGTH); // 5000 chars — the cap

        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-long"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(id), "Long", longBody, null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notified").value(1))
                .andExpect(jsonPath("$.pushDelivered").value(1));

        // The durable inbox row carries the WHOLE 5000-char body...
        Notification row = onlyAdminNotification(id);
        assertThat(row.getBody()).hasSize(AdminMessageRequest.MAX_BODY_LENGTH).isEqualTo(longBody);

        // ...but the transient push is a bounded preview (never the full 5000 chars — FCM payload limit).
        PushMessage pushed = sender.lastMessage();
        assertThat(pushed.body().length()).isLessThanOrEqualTo(500);
        assertThat(pushed.body()).endsWith("…");
    }

    // --- push opt-out (inbox is pref-independent) --------------------------------------------------

    @Test
    void pushRespectsOptOutButTheInboxDoesNot() throws Exception {
        long optedOut = seedUser("push-optout", null, NotificationPref.EMAIL); // EMAIL == push opt-out
        seedToken(optedOut, "tok-optout");
        long optedIn = seedUser("push-optin", null, NotificationPref.BOTH);
        seedToken(optedIn, "tok-optin");

        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin("admin-optout"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(List.of(optedOut, optedIn), "Hi", "There", null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notified").value(2)) // both get the inbox row
                .andExpect(jsonPath("$.pushTargeted").value(1)) // only the opted-in device is pushed
                .andExpect(jsonPath("$.pushSkipped").value(1)); // the opted-out recipient's push is skipped

        // Both got the durable inbox row; only the opted-in user's token was ever pushed.
        assertThat(onlyAdminNotificationCount(optedOut)).isEqualTo(1);
        assertThat(onlyAdminNotificationCount(optedIn)).isEqualTo(1);
        assertThat(sender.sentTokens()).containsExactly("tok-optin");
    }

    /**
     * Registers the recording {@link PushSender} in the context so no real FCM is ever called. {@code
     * @Primary} so it wins injection over the default {@code fcmPushSender}. Exposed as a bean so the
     * test can read what was sent and reset it between tests.
     */
    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }
    }

    /** A no-FCM {@link PushSender} that records every token + message it was asked to send. */
    static final class RecordingPushSender implements PushSender {
        private final List<String> sent = new ArrayList<>();
        private final List<PushMessage> messages = new ArrayList<>();
        private final Map<String, PushDelivery> outcomes = new ConcurrentHashMap<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            sent.add(token);
            messages.add(message);
            return outcomes.getOrDefault(token, PushDelivery.DELIVERED);
        }

        synchronized List<String> sentTokens() {
            return new ArrayList<>(sent);
        }

        synchronized PushMessage lastMessage() {
            return messages.get(messages.size() - 1);
        }

        synchronized void reset() {
            sent.clear();
            messages.clear();
            outcomes.clear();
        }
    }
}
