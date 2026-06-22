package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

/**
 * Verifies the TM-114 data conventions on the {@code users} entity: soft-delete hides rows from
 * normal queries while keeping them restorable, a returning user is reactivated (not duplicated),
 * and a stale concurrent write fails the optimistic-lock check instead of silently overwriting.
 */
class UserSoftDeleteAndVersionIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository users;

    @Autowired
    private UserService userService;

    private static VerifiedUser caller(String uid, String email) {
        return new VerifiedUser(uid, email);
    }

    @Test
    void softDeleteHidesFromNormalQueriesAndRestoreBringsItBack() {
        userService.provision(caller("uid-sd", "sd@example.com"));
        assertThat(users.findByFirebaseUid("uid-sd")).isPresent();

        userService.softDelete("uid-sd");

        // Excluded from every normal query by the entity's @SQLRestriction...
        assertThat(users.findByFirebaseUid("uid-sd")).isEmpty();
        assertThat(users.findAll()).noneMatch(u -> "uid-sd".equals(u.getFirebaseUid()));
        // ...but the tombstone still exists and is reachable for restore.
        assertThat(users.findAnyByFirebaseUid("uid-sd")).hasValueSatisfying(u -> {
            assertThat(u.isDeleted()).isTrue();
            assertThat(u.getDeletedAt()).isNotNull();
        });

        User restored = userService.restore("uid-sd");
        assertThat(restored.isDeleted()).isFalse();
        assertThat(restored.getDeletedAt()).isNull();
        assertThat(users.findByFirebaseUid("uid-sd")).isPresent();
    }

    @Test
    void reLoginReactivatesASoftDeletedAccountInsteadOfDuplicating() {
        User first = userService.provision(caller("uid-re", "re@example.com"));
        userService.softDelete("uid-re");
        assertThat(users.findByFirebaseUid("uid-re")).isEmpty();

        User second = userService.provision(caller("uid-re", "re@example.com"));

        assertThat(second.getId()).isEqualTo(first.getId()); // same row reactivated, not a duplicate
        assertThat(second.isDeleted()).isFalse();
    }

    @Test
    void staleUpdateFailsWithOptimisticLockConflict() {
        userService.provision(caller("uid-ol", "ol@example.com"));

        // Two independent loads (each in its own transaction) ⇒ two detached copies at the same version.
        User stale = users.findByFirebaseUid("uid-ol").orElseThrow();
        User fresh = users.findByFirebaseUid("uid-ol").orElseThrow();

        fresh.setDisplayName("first writer wins");
        users.saveAndFlush(fresh); // version 0 -> 1

        User reloaded = users.findByFirebaseUid("uid-ol").orElseThrow();
        assertThat(reloaded.getVersion()).isGreaterThan(stale.getVersion());

        stale.setDisplayName("second writer is stale");
        assertThatThrownBy(() -> users.saveAndFlush(stale))
                .isInstanceOf(ObjectOptimisticLockingFailureException.class);
    }
}
