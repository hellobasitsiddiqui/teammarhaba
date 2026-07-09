package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import com.teammarhaba.backend.messaging.AdminMessage;
import com.teammarhaba.backend.messaging.AdminMessageRepository;
import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin message <b>recall</b> API ({@code POST /api/v1/admin/messages/{id}/recall}, TM-473, epic
 * TM-432) end-to-end through the real security chain + Postgres. Reuses the recording {@link
 * com.teammarhaba.backend.notify.PushSender} fake from {@link AdminMessageControllerIntegrationTest}
 * (same package) so a send's push fan-out never hits real FCM. Covers the ACs:
 *
 * <ul>
 *   <li><b>HYBRID recall (the owner's design decision, TM-473)</b> — when no recipient has seen it yet,
 *       recall <em>deletes</em> every {@code ADMIN_MESSAGE} row (clean vanish) and their unseen bell
 *       badge drops back to 0; when a recipient has <em>already seen</em> it, that row is instead
 *       <em>tombstoned</em> (kept + {@code recalledAt} stamped) and the feed API surfaces it
 *       {@code recalled} so the panel renders it struck-through — the unseen ones for the same campaign
 *       are still deleted;
 *   <li><b>sent-history marked recalled</b> — the campaign header is stamped {@code recalledAt}/
 *       {@code recalledBy} and the sent-history row reads {@code status = RECALLED};
 *   <li><b>admin-gated</b> — anonymous → 401, USER → 403;
 *   <li><b>scoped 404</b> — an unknown id, and another admin's message, are both a uniform 404 (no leak);
 *   <li><b>audited</b> — exactly one {@code ADMIN_MESSAGE_RECALLED} row per real recall;
 *   <li><b>recall-only + idempotent</b> — a second recall is a no-op ({@code removed = 0}, still one
 *       audit row); there is no edit endpoint.
 * </ul>
 */
@AutoConfigureMockMvc
@Import(AdminMessageControllerIntegrationTest.RecordingSenderConfig.class)
class AdminMessageRecallIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private DeviceTokenRepository tokens;

    @Autowired
    private NotificationRepository notifications;

    @Autowired
    private AdminMessageRepository adminMessages;

    @Autowired
    private AuditRepository audits;

    @Autowired
    private AdminMessageControllerIntegrationTest.RecordingPushSender sender;

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

    private long seedUser(String uid) {
        User u = new User(uid, uid + "@example.com", uid);
        u.setNotificationPref(NotificationPref.PUSH);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String token) {
        tokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    private static String userBody(List<Long> ids, String title, String body) {
        String csv = ids.stream().map(String::valueOf).reduce((a, b) -> a + "," + b).orElse("");
        return "{\"title\":\"" + title + "\",\"body\":\"" + body + "\",\"userIds\":[" + csv + "]}";
    }

    /** Send a message from {@code adminUid} to {@code recipients} via the real endpoint; return its id. */
    private long send(String adminUid, List<Long> recipients) throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin(adminUid))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(recipients, "Heads up", "The venue changed for tonight.")))
                .andExpect(status().isOk());
        return adminMessages.findByActorUidOrderByCreatedAtDesc(adminUid).get(0).getId();
    }

    private long adminMessageRows(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .count();
    }

    private List<Notification> adminMessageNotifications(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .toList();
    }

    /** Simulate the recipient opening their bell/panel: stamp their ADMIN_MESSAGE rows seen. */
    private void markAdminMessagesSeen(long userId) {
        for (Notification n : adminMessageNotifications(userId)) {
            n.markSeen(Instant.now());
            notifications.saveAndFlush(n);
        }
    }

    // --- the happy path: removes inbox + bell, marks recalled, audits ------------------------------

    @Test
    void recallRemovesInboxAndBellCopiesMarksRecalledAndAudits() throws Exception {
        long alice = seedUser("recall-alice");
        long bob = seedUser("recall-bob");
        seedToken(alice, "tok-alice");
        seedToken(bob, "tok-bob");

        long id = send("admin-recall", List.of(alice, bob));

        // Before recall: each recipient has the durable ADMIN_MESSAGE row AND an unseen bell badge.
        assertThat(adminMessageRows(alice)).isEqualTo(1);
        assertThat(adminMessageRows(bob)).isEqualTo(1);
        assertThat(notifications.countByUserIdAndSeenAtIsNull(alice)).isEqualTo(1);
        assertThat(notifications.countByUserIdAndSeenAtIsNull(bob)).isEqualTo(1);

        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(admin("admin-recall")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.id").value((int) id))
                .andExpect(jsonPath("$.removed").value(2)) // both unseen → both in-app copies deleted
                .andExpect(jsonPath("$.tombstoned").value(0)) // nobody had seen it → nothing tombstoned
                .andExpect(jsonPath("$.recalledBy").value("admin-recall"))
                .andExpect(jsonPath("$.recalledAt").isNotEmpty());

        // After recall: the in-app inbox/panel rows are gone AND the bell badge is back to 0 (same store).
        assertThat(adminMessageRows(alice)).isZero();
        assertThat(adminMessageRows(bob)).isZero();
        assertThat(notifications.countByUserIdAndSeenAtIsNull(alice)).isZero();
        assertThat(notifications.countByUserIdAndSeenAtIsNull(bob)).isZero();

        // The campaign header is stamped recalled, attributed to the recalling admin.
        AdminMessage campaign = adminMessages.findByIdAndActorUid(id, "admin-recall").orElseThrow();
        assertThat(campaign.isRecalled()).isTrue();
        assertThat(campaign.getRecalledBy()).isEqualTo("admin-recall");
        assertThat(campaign.getRecalledAt()).isNotNull();

        // The sent-history row now reads RECALLED (TM-442's list, so TM-444 can render it).
        mockMvc.perform(get("/api/v1/admin/messages").with(admin("admin-recall")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].id").value((int) id))
                .andExpect(jsonPath("$.items[0].status").value("RECALLED"))
                .andExpect(jsonPath("$.items[0].recalledAt").isNotEmpty());

        // Exactly one ADMIN_MESSAGE_RECALLED audit row, targeting the campaign, carrying the removed count.
        List<AuditEvent> auditRows =
                audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc("AdminMessage", String.valueOf(id));
        List<AuditEvent> recalls = auditRows.stream()
                .filter(a -> a.getAction() == AuditAction.ADMIN_MESSAGE_RECALLED)
                .toList();
        assertThat(recalls).hasSize(1);
        assertThat(recalls.get(0).getActorUid()).isEqualTo("admin-recall");
        // Numeric metadata round-trips through the JSON column as an Integer/Long depending on the
        // mapper, so assert the key + its magnitude rather than an exact boxed type (the convention the
        // send integration test uses).
        assertThat(recalls.get(0).getMetadata()).containsKey("removed");
        assertThat(((Number) recalls.get(0).getMetadata().get("removed")).intValue()).isEqualTo(2);
        assertThat(((Number) recalls.get(0).getMetadata().get("tombstoned")).intValue()).isZero();
    }

    // --- HYBRID recall: delete the unseen, tombstone the seen --------------------------------------

    @Test
    void recallTombstonesSeenAndDeletesUnseen() throws Exception {
        long seen = seedUser("recall-seen"); // will open the bell → their copy is SEEN → tombstoned
        long unseen = seedUser("recall-unseen"); // never opens it → their copy is UNSEEN → deleted

        long id = send("admin-hybrid", List.of(seen, unseen));

        // The 'seen' recipient opens their bell/panel; the 'unseen' one does not.
        markAdminMessagesSeen(seen);
        assertThat(notifications.countByUserIdAndSeenAtIsNull(seen)).isZero(); // seen
        assertThat(notifications.countByUserIdAndSeenAtIsNull(unseen)).isEqualTo(1); // still unseen

        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(admin("admin-hybrid")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(1)) // the unseen copy deleted
                .andExpect(jsonPath("$.tombstoned").value(1)) // the seen copy kept + marked recalled
                .andExpect(jsonPath("$.recalledAt").isNotEmpty());

        // The UNSEEN recipient's row is gone entirely (clean vanish, no trace).
        assertThat(adminMessageRows(unseen)).isZero();

        // The SEEN recipient's row is KEPT but tombstoned — present, and stamped recalled.
        List<Notification> seenRows = adminMessageNotifications(seen);
        assertThat(seenRows).hasSize(1);
        assertThat(seenRows.get(0).isRecalled()).isTrue();
        assertThat(seenRows.get(0).getRecalledAt()).isNotNull();

        // The feed API surfaces the recalled/tombstone state (+ time) so the panel renders it struck-through.
        mockMvc.perform(get("/api/v1/me/notifications").with(regularUser("recall-seen")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].id").value(seenRows.get(0).getId().intValue()))
                .andExpect(jsonPath("$.items[0].recalled").value(true))
                .andExpect(jsonPath("$.items[0].recalledAt").isNotEmpty());

        // The campaign header is recalled, and the audit row records BOTH partitions.
        assertThat(adminMessages
                        .findByIdAndActorUid(id, "admin-hybrid")
                        .orElseThrow()
                        .isRecalled())
                .isTrue();
        List<AuditEvent> recalls = audits
                .findByTargetTypeAndTargetIdOrderByCreatedAtDesc("AdminMessage", String.valueOf(id))
                .stream()
                .filter(a -> a.getAction() == AuditAction.ADMIN_MESSAGE_RECALLED)
                .toList();
        assertThat(recalls).hasSize(1);
        assertThat(((Number) recalls.get(0).getMetadata().get("removed")).intValue()).isEqualTo(1);
        assertThat(((Number) recalls.get(0).getMetadata().get("tombstoned")).intValue())
                .isEqualTo(1);
    }

    // --- admin gate --------------------------------------------------------------------------------

    @Test
    void anonymousGetsUniform401() throws Exception {
        long id = send("admin-gate", List.of(seedUser("gate-target")));
        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));

        // The rejected recall changed nothing.
        assertThat(adminMessages.findByIdAndActorUid(id, "admin-gate").orElseThrow().isRecalled()).isFalse();
    }

    @Test
    void nonAdminCannotRecall() throws Exception {
        long target = seedUser("nonadmin-target");
        long id = send("admin-gate2", List.of(target));

        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));

        // No copies removed, header not recalled.
        assertThat(adminMessageRows(target)).isEqualTo(1);
        assertThat(adminMessages.findByIdAndActorUid(id, "admin-gate2").orElseThrow().isRecalled()).isFalse();
    }

    // --- scoped 404 (unknown id / another admin's message) -----------------------------------------

    @Test
    void unknownIdIs404() throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages/999999/recall").with(admin("admin-404")))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void anotherAdminsMessageIs404AndUntouched() throws Exception {
        long target = seedUser("scoped-target");
        long id = send("admin-owner", List.of(target));

        // A different admin can't recall a message they didn't send — a uniform 404 (never leaks it exists).
        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(admin("admin-other")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));

        // The owner's message is untouched: copies still present, header not recalled.
        assertThat(adminMessageRows(target)).isEqualTo(1);
        assertThat(adminMessages.findByIdAndActorUid(id, "admin-owner").orElseThrow().isRecalled()).isFalse();
    }

    // --- recall-only + idempotent ------------------------------------------------------------------

    @Test
    void secondRecallIsIdempotentNoOp() throws Exception {
        long target = seedUser("idem-target");
        long id = send("admin-idem", List.of(target));

        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(admin("admin-idem")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(1));

        Instant firstRecalledAt =
                adminMessages.findByIdAndActorUid(id, "admin-idem").orElseThrow().getRecalledAt();

        // Recalling again removes nothing (the copies are already gone) and keeps the original stamp.
        mockMvc.perform(post("/api/v1/admin/messages/" + id + "/recall").with(admin("admin-idem")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(0))
                .andExpect(jsonPath("$.recalledBy").value("admin-idem"));

        assertThat(adminMessages.findByIdAndActorUid(id, "admin-idem").orElseThrow().getRecalledAt())
                .isEqualTo(firstRecalledAt);

        // Only ONE recall audit row despite the two calls — the no-op doesn't re-audit.
        long recallAudits = audits
                .findByTargetTypeAndTargetIdOrderByCreatedAtDesc("AdminMessage", String.valueOf(id))
                .stream()
                .filter(a -> a.getAction() == AuditAction.ADMIN_MESSAGE_RECALLED)
                .count();
        assertThat(recallAudits).isEqualTo(1);
    }
}
