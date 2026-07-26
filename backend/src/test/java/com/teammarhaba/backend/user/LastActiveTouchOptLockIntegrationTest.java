package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * TM-1031 regression: the {@code last_active_at} liveness touch on {@code GET /me}
 * ({@link UserService#provisionAndTouch}) must NOT bump the optimistic-lock {@code @Version}, so it
 * can never invalidate a concurrent {@code PATCH /me} profile save.
 *
 * <p><strong>The bug this pins.</strong> The touch used to be a dirty-check update on the managed
 * entity ({@code user.markActive(now)} flushed on commit), which bumps {@code @Version}. Because
 * every authenticated read runs the touch — including the signed-in page's own background
 * {@code GET /me} polling — it raced a concurrent {@code PATCH /me}: both wrote a new version on the
 * same row, the loser's stale version threw {@code ObjectOptimisticLockingFailureException}, which
 * the {@code GlobalExceptionHandler} maps to a spurious {@code 409}. That was the intermittent
 * {@code web/e2e/tests/profile-regate.spec.mjs:213} RED ("PATCH /me {"phone":""} should succeed, got
 * 409"), observed on PRs #666 and #672 — and a real product bug: a liveness heartbeat must never
 * invalidate a semantically-independent write.
 *
 * <p><strong>Fail-before / pass-after.</strong> Both tests fail against the old dirty-write touch
 * (the version bumps; the concurrent PATCH throws optlock) and pass once the touch is a non-versioned
 * {@link UserRepository#touchLastActiveAt} UPDATE.
 *
 * <p>Drives the real {@code @Transactional} service against a real Postgres via a
 * {@link TransactionTemplate}, so the actual {@code @Version} column and Hibernate's flush behaviour
 * are what is under test — not a mock. The interleave is done by holding one transaction open while a
 * second one commits inside it, which is the exact shape of two concurrent requests on the same row.
 */
class LastActiveTouchOptLockIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserService userService;

    @Autowired
    private UserRepository users;

    @Autowired
    private PlatformTransactionManager txManager;

    private static VerifiedUser caller(String uid, String email) {
        return new VerifiedUser(uid, email);
    }

    /**
     * The direct invariant: the liveness touch stamps {@code last_active_at} WITHOUT advancing
     * {@code @Version}. This is the whole fix in one assertion — the old dirty-write bumped the
     * version on every {@code GET /me}, which is what let it collide with a concurrent write.
     */
    @Test
    void provisionAndTouchStampsLastActiveWithoutBumpingVersion() {
        VerifiedUser who = caller("uid-touch-noversion-" + UUID.randomUUID(), "touch@example.com");
        User provisioned = userService.provision(who);
        long versionBefore = users.findById(provisioned.getId()).orElseThrow().getVersion();

        // The GET /me liveness touch.
        User touched = userService.provisionAndTouch(who);

        // The stamp landed (the touch's actual job)...
        assertThat(touched.getLastActiveAt()).isNotNull();
        assertThat(users.findById(provisioned.getId()).orElseThrow().getLastActiveAt())
                .as("last_active_at is persisted by the touch")
                .isNotNull();
        // ...but the version is UNCHANGED — a liveness heartbeat is not a versioned mutation, so it
        // leaves nothing for a concurrent PATCH to lose an optimistic-lock race against. With the old
        // dirty-write touch this would be versionBefore + 1 and the test fails here.
        assertThat(users.findById(provisioned.getId()).orElseThrow().getVersion())
                .as("the last_active_at touch must NOT bump @Version (TM-1031)")
                .isEqualTo(versionBefore);
    }

    /**
     * The end-to-end race from {@code profile-regate.spec.mjs}: a {@code GET /me} liveness touch that
     * commits WHILE a {@code PATCH /me} profile edit is in flight must not make that PATCH 409.
     *
     * <ol>
     *   <li>Open the PATCH transaction and load the caller's entity (captures its current version).</li>
     *   <li>While it is open, fire the concurrent {@code GET /me} touch in its OWN committed
     *       transaction (a nested {@code REQUIRES_NEW}).</li>
     *   <li>Mutate the profile (clear the phone, exactly as the spec's {@code PATCH /me {"phone":""}})
     *       and commit the PATCH transaction.</li>
     * </ol>
     *
     * <p>With the old dirty-write touch, step 2 bumps the row to {@code version + 1}, so committing the
     * step-1 copy (still at {@code version}) throws {@code ObjectOptimisticLockingFailureException}
     * (→ 409). With the non-versioned touch the version is untouched, so the PATCH commits cleanly.
     */
    @Test
    void concurrentLivenessTouchDoesNotMakeAnInFlightProfilePatch409() {
        VerifiedUser who = caller("uid-touch-vs-patch-" + UUID.randomUUID(), "patch@example.com");
        // A completed account with a stored phone — the profile-regate control shape. A run-unique
        // number: the V48 users_phone_normalized_uq index bans reusing a literal across the shared DB.
        User seed = userService.provision(who);
        seed.setPhone(uniqueGbPhone());
        users.saveAndFlush(seed);

        TransactionTemplate patchTx = new TransactionTemplate(txManager);
        TransactionTemplate touchTx = new TransactionTemplate(txManager);
        // The touch must commit on its OWN transaction while the PATCH's is still open, so the PATCH
        // copy becomes genuinely stale — the two-concurrent-requests shape. REQUIRES_NEW suspends the
        // outer PATCH transaction and commits the touch independently.
        touchTx.setPropagationBehavior(
                org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);

        assertThatCode(() -> patchTx.executeWithoutResult(status -> {
                    // 1. The PATCH loads the caller's row (captures its version at this instant).
                    User forPatch = users.findByFirebaseUid(who.uid()).orElseThrow();

                    // 2. A concurrent GET /me liveness touch commits NOW, before the PATCH commits.
                    touchTx.executeWithoutResult(inner -> userService.provisionAndTouch(who));

                    // 3. The PATCH mutates the profile (clear the phone) and commits when this callback
                    //    returns. The old versioned touch would have moved the row on under it → optlock.
                    forPatch.setPhone("");
                    users.saveAndFlush(forPatch);
                }))
                .as("a concurrent last_active_at touch must not 409 an in-flight PATCH /me (TM-1031)")
                .doesNotThrowAnyException();

        // The PATCH actually took effect (the clear persisted) — proof it was not silently swallowed.
        assertThat(users.findByFirebaseUid(who.uid()).orElseThrow().getPhone()).isEmpty();
    }

    /**
     * A globally-unique GB E.164 number so the V48 phone-uniqueness index never collides (TM-934).
     * {@code +447700} + 5 unique digits = {@code +447700NNNNN}, inside the reserved GB test range
     * ({@code +447700 900000}–{@code 900999} is Ofcom-reserved; the wider {@code +447700 9xxxxx} block
     * is drama/test use) and a valid E.164 mobile shape for the {@code UpdateMeRequest} pattern.
     */
    private static String uniqueGbPhone() {
        long n = Math.abs(UUID.randomUUID().getLeastSignificantBits() % 100_000L);
        return String.format("+4477009%05d", n);
    }
}
