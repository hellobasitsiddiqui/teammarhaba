package com.teammarhaba.backend.audit;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Verifies the append-only audit log against a real Postgres (Testcontainers): a recorded event
 * persists with all fields (incl. the JSONB metadata and the DB-generated timestamp), and a real
 * account action (just-in-time provisioning, TM-112) writes exactly one event — while a returning
 * user's reuse writes none. Queries are scoped by a unique actor/target id so the shared
 * integration context's accumulated rows don't interfere.
 */
class AuditServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AuditService audit;

    @Autowired
    private AuditRepository events;

    @Autowired
    private UserService userService;

    @Test
    void recordPersistsOneImmutableEventWithMetadataAndTimestamp() {
        String actor = "audit-it-actor-1";

        AuditEvent saved = audit.record(
                actor, AuditAction.PROFILE_UPDATED, "User", actor, Map.of("field", "displayName"));

        assertThat(saved.getId()).isNotNull();
        assertThat(saved.getCreatedAt()).isNotNull(); // DB-generated default now()

        List<AuditEvent> byActor = events.findByActorUidOrderByCreatedAtDesc(actor);
        assertThat(byActor).hasSize(1);
        AuditEvent e = byActor.get(0);
        assertThat(e.getAction()).isEqualTo(AuditAction.PROFILE_UPDATED);
        assertThat(e.getTargetType()).isEqualTo("User");
        assertThat(e.getTargetId()).isEqualTo(actor);
        assertThat(e.getMetadata()).containsEntry("field", "displayName"); // JSONB round-trips
        assertThat(e.getCreatedAt()).isNotNull();
    }

    @Test
    void provisioningWritesExactlyOneEventAndReuseWritesNone() {
        String uid = "audit-it-prov-1";
        VerifiedUser caller = new VerifiedUser(uid, "ada@example.com");

        userService.provision(caller); // first sight → inserts the account
        userService.provision(caller); // returning user → reuses the row, no new audit event

        List<AuditEvent> history = events.findByTargetTypeAndTargetIdOrderByCreatedAtDesc("User", uid);
        assertThat(history).hasSize(1);
        assertThat(history.get(0).getAction()).isEqualTo(AuditAction.ACCOUNT_PROVISIONED);
        assertThat(history.get(0).getActorUid()).isEqualTo(uid);
    }
}
