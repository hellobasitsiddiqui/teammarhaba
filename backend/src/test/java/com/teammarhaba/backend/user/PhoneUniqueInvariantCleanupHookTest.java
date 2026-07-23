package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * TM-1019 (c) — structural guard for {@link PhoneUniqueInvariantTest}'s row cleanup.
 *
 * <p>The bug: {@code cleanup()} used to be a plain helper CALLED INLINE at the end of each test body,
 * so it was SKIPPED exactly when an earlier assertion threw — leaking the test's seeded {@code inv-%}
 * rows into a sibling test, which would then see a spurious duplicate-phone collision. The fix moves
 * cleanup to an {@code @AfterEach} hook, which JUnit runs after EVERY test whether it passed or failed.
 *
 * <p>This is a lightweight reflection guard (no Spring context, no Testcontainers — so it runs on the
 * fast unit lane) that pins the fix so it can't silently regress: {@code cleanup} must carry
 * {@code @AfterEach}, and no test method may still call {@code cleanup()} inline from its body.
 *
 * <p>FAIL-BEFORE / PASS-AFTER: on {@code origin/main} the {@code cleanup} method carried NO annotation,
 * so {@link #cleanupRunsAsAnAfterEachHook()} fails; after the TM-1019 fix it passes.
 */
class PhoneUniqueInvariantCleanupHookTest {

    @Test
    void cleanupRunsAsAnAfterEachHook() throws NoSuchMethodException {
        Method cleanup = PhoneUniqueInvariantTest.class.getDeclaredMethod("cleanup");
        assertThat(cleanup.isAnnotationPresent(AfterEach.class))
                .as(
                        "PhoneUniqueInvariantTest.cleanup() must be an @AfterEach hook so a FAILING "
                                + "assertion can't leak its seeded rows into a sibling test (TM-1019)")
                .isTrue();
        // A cleanup hook must NOT itself be a @Test (that would make it a case, not an after-hook).
        assertThat(cleanup.isAnnotationPresent(Test.class))
                .as("cleanup() is an after-hook, not a test case")
                .isFalse();
    }
}
