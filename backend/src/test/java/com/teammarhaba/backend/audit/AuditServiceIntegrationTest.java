package com.teammarhaba.backend.audit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

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

    @Autowired
    private JdbcTemplate jdbc;

    /**
     * TM-724: append-only must hold at the DB tier, not just by application convention. V42 installs
     * triggers that reject UPDATE/DELETE/TRUNCATE on audit_events even for the app's DB role (the schema
     * owner, which bypasses table GRANTs) — so a recorded event cannot be silently rewritten or erased.
     * INSERT and SELECT stay unaffected.
     */
    @Test
    void auditEventsAreImmutableAtTheDbLevel() {
        AuditEvent saved = audit.record(
                "audit-immutable-actor", AuditAction.PROFILE_UPDATED, "User", "audit-immutable-target", Map.of());
        Long id = saved.getId();

        // UPDATE is blocked by the trigger.
        assertThatThrownBy(() -> jdbc.update("update audit_events set action = 'TAMPERED' where id = ?", id))
                .hasMessageContaining("append-only");
        // DELETE is blocked by the trigger.
        assertThatThrownBy(() -> jdbc.update("delete from audit_events where id = ?", id))
                .hasMessageContaining("append-only");
        // TRUNCATE is blocked by the statement-level trigger.
        assertThatThrownBy(() -> jdbc.execute("truncate table audit_events"))
                .hasMessageContaining("append-only");

        // The row is untouched, and INSERT/SELECT still work (append-forward, read stay open).
        Map<String, Object> row =
                jdbc.queryForMap("select action from audit_events where id = ?", id);
        assertThat(row).containsEntry("action", "PROFILE_UPDATED");
    }

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
