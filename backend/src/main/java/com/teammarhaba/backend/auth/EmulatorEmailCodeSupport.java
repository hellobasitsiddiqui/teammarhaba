package com.teammarhaba.backend.auth;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Primary;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Emulator-only test support for the email-code login (TM-234), so the browser-e2e suite can read the
 * code that was "emailed" and drive the full passwordless happy path end-to-end.
 *
 * <p><strong>It exists only against the Firebase Auth emulator.</strong> Both beans below carry the
 * same {@code @ConditionalOnExpression} gate on the very signal {@link FirebaseConfig} already uses to
 * switch to the emulator — {@code FIREBASE_AUTH_EMULATOR_HOST} being set — which is <em>unset in dev
 * and prod</em>. The condition is on each {@code @Component}/{@code @RestController} itself, so it is
 * evaluated during component scanning and the beans are simply absent in any real environment; the
 * default {@link LoggingEmailCodeMailer} (which never reveals a code) is what ships. This mirrors the
 * codebase's established "emulator-only seam" pattern (TM-134) rather than inventing a new prod risk.
 */
public final class EmulatorEmailCodeSupport {

    private EmulatorEmailCodeSupport() {}

    /** Activation condition shared by the recording mailer + the peek endpoint: emulator only. */
    static final String EMULATOR_ONLY = "'${FIREBASE_AUTH_EMULATOR_HOST:}' != ''";

    /**
     * Records the last code per (normalised) address so the e2e harness can read it back. {@code
     * @Primary} so it wins over the default {@link LoggingEmailCodeMailer} when both are present.
     */
    @Component
    @Primary
    @ConditionalOnExpression(EMULATOR_ONLY)
    public static class RecordingEmailCodeMailer implements EmailCodeMailer {
        private final ConcurrentHashMap<String, String> lastCode = new ConcurrentHashMap<>();

        @Override
        public void sendLoginCode(String email, String code) {
            lastCode.put(email.toLowerCase(Locale.ROOT), code);
        }

        String peek(String email) {
            return lastCode.get(email == null ? "" : email.trim().toLowerCase(Locale.ROOT));
        }
    }

    /**
     * Emulator-only endpoint: hand back the last code emailed to an address (for the e2e harness). In
     * the {@code auth} package (not {@code api}), so it is NOT under the {@code /api/v1} prefix —
     * served at {@code /auth/email-code/peek}, which {@code SecurityConfig} permit-lists.
     */
    @RestController
    @ConditionalOnExpression(EMULATOR_ONLY)
    public static class EmailCodePeekController {
        private final RecordingEmailCodeMailer mailer;

        EmailCodePeekController(RecordingEmailCodeMailer mailer) {
            this.mailer = mailer;
        }

        @GetMapping("/auth/email-code/peek")
        ResponseEntity<String> peek(@RequestParam String email) {
            String code = mailer.peek(email);
            return code == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(code);
        }
    }
}
