package com.teammarhaba.backend.auth;

import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.cloud.storage.Storage;
import com.google.cloud.storage.StorageOptions;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.cloud.StorageClient;
import com.google.firebase.messaging.FirebaseMessaging;
import com.teammarhaba.backend.config.AppProperties;
import java.io.IOException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Lazy;

/**
 * Initialises the Firebase Admin SDK and exposes the SDK entry points the backend uses (TM-79,
 * TM-284). One {@link FirebaseApp} is initialised here and shared by both consumers:
 * {@link FirebaseAuth} (ID-token verification, TM-79) and {@link FirebaseMessaging} (send-push,
 * TM-284) — so there is a single credential/project-id init, not one per feature.
 *
 * <p>Credentials come from <strong>Application Default Credentials</strong> — the Cloud Run
 * runtime service account in prod, {@code gcloud auth application-default login} locally. There
 * is <strong>no committed service-account key</strong>. The project id (which scopes token
 * verification) comes from the validated {@link AppProperties}.
 *
 * <p>Every bean here is {@link Lazy}: created on first use, not at startup. Token verification only
 * happens when a request actually presents a {@code Bearer} token, and a push send only happens when
 * there's something to deliver — so dev/test/CI (no ADC, no real tokens, no real sends) never trigger
 * initialisation and boot cleanly. Integration tests replace these beans with mocks.
 *
 * <p><strong>Browser-e2e (TM-134):</strong> when {@code FIREBASE_AUTH_EMULATOR_HOST} is set, the
 * Admin SDK talks to a local Firebase Auth emulator and verifies its (unsigned) tokens without
 * real credentials, so a stub token stands in for ADC. This variable is unset in dev/prod, so
 * that path never runs there.
 */
@Configuration
public class FirebaseConfig {

    /**
     * The single shared {@link FirebaseApp}. Lazy, so it is only built when a feature first needs the
     * Admin SDK; idempotent against an already-initialised default app (e.g. if another bean raced it).
     */
    @Bean
    @Lazy
    FirebaseApp firebaseApp(AppProperties props) throws IOException {
        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseOptions.Builder options = FirebaseOptions.builder()
                    .setCredentials(resolveCredentials())
                    .setProjectId(props.firebase().projectId());
            // The chat-media signed-URL path (TM-1126) needs a default Storage bucket on the app so
            // StorageClient.getInstance().bucket() resolves without a per-call name. It is optional
            // (dev/test/CI run with no Storage), so only set it when configured; when unset the
            // ChatMediaService is the single feature that refuses, not the whole app.
            String bucket = props.firebase().storageBucket();
            if (bucket != null && !bucket.isBlank()) {
                options.setStorageBucket(bucket);
            }
            return FirebaseApp.initializeApp(options.build());
        }
        return FirebaseApp.getInstance();
    }

    @Bean
    @Lazy
    FirebaseAuth firebaseAuth(FirebaseApp app) {
        return FirebaseAuth.getInstance(app);
    }

    @Bean
    @Lazy
    FirebaseMessaging firebaseMessaging(FirebaseApp app) {
        return FirebaseMessaging.getInstance(app);
    }

    /**
     * The Cloud Storage client the chat-media signed-URL path (TM-1126) signs upload/download URLs with.
     * Derived from the same shared {@link FirebaseApp} (and therefore the same ADC credential + project),
     * so there is one credential/project init for auth, push <em>and</em> storage — not a separate
     * {@link StorageOptions} chain. {@link Lazy} like its siblings: only built when the chat-media
     * endpoint first runs, so dev/test/CI (no ADC, no Storage) never trigger it.
     *
     * <p>{@link StorageClient#getInstance(FirebaseApp)} returns the SDK's storage handle for the app;
     * {@link StorageClient#bucket()} (used by the service) resolves the default bucket configured above.
     */
    @Bean
    @Lazy
    Storage storage(FirebaseApp app) {
        return StorageClient.getInstance(app).bucket().getStorage();
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
