package com.teammarhaba.backend.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * TM-554 — {@link AdminMessageService#send} must be transactionally atomic: the durable per-recipient
 * {@code ADMIN_MESSAGE} inbox rows have to commit or roll back <em>together</em> with the campaign
 * header and the {@code ADMIN_MESSAGE_SENT} audit, so a failure anywhere in the send can never strand
 * orphaned, un-recallable notifications pointing at a campaign header that itself rolled back.
 *
 * <p>The regression the fix closes: {@code NotificationWriter.writeAdminMessage} runs
 * {@code @Transactional(REQUIRES_NEW)}, so before the fix the inbox rows committed in an inner
 * transaction while the header + audit stayed in {@code send()}'s still-open outer one. A throw
 * <em>after</em> that inner commit (an audit DB error, or a {@code fanOutPush} read failing for a
 * later recipient) rolled the header back but left the already-committed rows behind as orphans. The
 * fix routes the synchronous admin-send through
 * {@link com.teammarhaba.backend.notify.NotificationWriter#writeAdminMessageInCurrentTransaction}
 * ({@code REQUIRED}), which joins the outer transaction so the whole send is one unit.
 *
 * <p>Runs against a real Postgres (Testcontainers) via {@link AbstractIntegrationTest} — a genuine
 * commit/rollback boundary is the only thing that can prove atomicity; H2 or a test-managed
 * {@code @Transactional} wrapper would mask it. The test is deliberately <em>not</em>
 * {@code @Transactional} so {@code send()} owns its own transaction, exactly as production.
 */
class AdminMessageSendAtomicityIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AdminMessageService adminMessageService;

    @Autowired
    private UserRepository users;

    @Autowired
    private NotificationRepository notifications;

    @Autowired
    private AdminMessageRepository adminMessages;

    /**
     * The audit append is {@code send()}'s final persistent step (step 6, after the durable inbox write
     * and the push fan-out). Stubbing it to throw reproduces exactly the bug's "throw after the durable
     * write" without any timing tricks: with the fix the whole {@code send()} transaction — header +
     * inbox rows + audit — must roll back as one.
     */
    @MockitoBean
    private AuditService audit;

    @Test
    void aFailureAfterTheDurableWriteLeavesNoOrphanedInboxRows() {
        // A push-independent recipient with NO device token: the best-effort fan-out therefore sends
        // nothing, so the ONLY thing that throws is the stubbed audit append below — isolating the
        // strand-on-failure scenario to the exact error path the bug describes.
        User recipient =
                users.save(new User("tm554-recipient", "tm554-recipient@example.com", "TM554 Recipient"));
        long recipientId = recipient.getId();

        long headersBefore = adminMessages.count();
        long adminRowsBefore = adminNotificationCount(recipientId);

        // Make the audit append blow up the way a DB error would — the failure lands after the durable
        // inbox write and the push fan-out have already run inside send().
        doThrow(new RuntimeException("audit write failed"))
                .when(audit)
                .record(anyString(), any(AuditAction.class), anyString(), anyString(), any());

        assertThatThrownBy(() -> adminMessageService.send(
                        "tm554-admin",
                        AudienceSpec.user(recipientId),
                        TargetType.USER,
                        "user:" + recipientId,
                        "Outage notice",
                        "We are investigating an issue.",
                        null))
                .isInstanceOf(RuntimeException.class)
                .hasMessage("audit write failed");

        // The send() transaction rolled back as ONE unit — no campaign header AND no ADMIN_MESSAGE inbox
        // row survived. Before the fix the REQUIRES_NEW inner write had already committed the inbox row,
        // so it would linger here as an orphan referencing a header that never reached the DB.
        assertThat(adminMessages.count())
                .as("campaign header must roll back on failure")
                .isEqualTo(headersBefore);
        assertThat(adminNotificationCount(recipientId))
                .as("durable inbox rows must roll back with the header — no orphan may survive")
                .isEqualTo(adminRowsBefore);
    }

    /** Count of durable {@code ADMIN_MESSAGE} inbox rows currently persisted for the given user. */
    private long adminNotificationCount(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .count();
    }
}
