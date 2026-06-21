package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Verifies the {@code users} mapping against a real Postgres (Testcontainers): the context
 * booting at all proves Hibernate {@code validate} agrees with the {@code V2__create_users}
 * migration, and the round-trip confirms the entity + repository persist and look up by the
 * Firebase UID with the expected defaults.
 */
class UserRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository users;

    @Test
    void persistsAndLooksUpByFirebaseUidWithDefaults() {
        User saved = users.save(new User("firebase-uid-123", "ada@example.com", "Ada"));

        assertThat(saved.getId()).isNotNull();
        assertThat(saved.getFirebaseUid()).isEqualTo("firebase-uid-123");
        assertThat(saved.getRole()).isEqualTo(Role.USER); // DB + entity default
        assertThat(saved.isEnabled()).isTrue();

        assertThat(users.findByFirebaseUid("firebase-uid-123"))
                .get()
                .extracting(User::getEmail, User::getDisplayName)
                .containsExactly("ada@example.com", "Ada");

        assertThat(users.findByFirebaseUid("does-not-exist")).isEmpty();
    }
}
