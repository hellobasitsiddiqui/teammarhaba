package com.teammarhaba.backend.auth;

import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.config.AppProperties;
import java.io.IOException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Lazy;

/**
 * Initialises the Firebase Admin SDK for ID-token verification (TM-79).
 *
 * <p>Credentials come from <strong>Application Default Credentials</strong> — the Cloud Run
 * runtime service account in prod, {@code gcloud auth application-default login} locally. There
 * is <strong>no committed service-account key</strong>. The project id (which scopes token
 * verification) comes from the validated {@link AppProperties}.
 *
 * <p>The bean is {@link Lazy}: it is created on first use, not at startup. Token verification
 * only happens when a request actually presents a {@code Bearer} token, so dev/test/CI — which
 * have no ADC and send no real tokens — never trigger initialisation and boot cleanly. The
 * integration test replaces this bean with a mock.
 *
 * <p><strong>Browser-e2e (TM-134):</strong> when {@code FIREBASE_AUTH_EMULATOR_HOST} is set, the
 * Admin SDK talks to a local Firebase Auth emulator and verifies its (unsigned) tokens without
 * real credentials, so a stub token stands in for ADC. This variable is unset in dev/prod, so
 * that path never runs there.
 */
@Configuration
public class FirebaseConfig {

    @Bean
    @Lazy
    FirebaseAuth firebaseAuth(AppProperties props) throws IOException {
        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseOptions options = FirebaseOptions.builder()
                    .setCredentials(resolveCredentials())
                    .setProjectId(props.firebase().projectId())
                    .build();
            FirebaseApp.initializeApp(options);
        }
        return FirebaseAuth.getInstance();
    }

    /**
     * ADC in every real environment; a stub token only when pointed at the Auth emulator
     * (the emulator skips signature verification, so no real credential is needed — TM-134).
     */
    private static GoogleCredentials resolveCredentials() throws IOException {
        String emulatorHost = System.getenv("FIREBASE_AUTH_EMULATOR_HOST");
        if (emulatorHost != null && !emulatorHost.isBlank()) {
            return GoogleCredentials.create(new AccessToken("owner", null));
        }
        return GoogleCredentials.getApplicationDefault();
    }
}
