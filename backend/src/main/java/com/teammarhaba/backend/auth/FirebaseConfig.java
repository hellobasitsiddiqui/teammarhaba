package com.teammarhaba.backend.auth;

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
 */
@Configuration
public class FirebaseConfig {

    @Bean
    @Lazy
    FirebaseAuth firebaseAuth(AppProperties props) throws IOException {
        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseOptions options = FirebaseOptions.builder()
                    .setCredentials(GoogleCredentials.getApplicationDefault())
                    .setProjectId(props.firebase().projectId())
                    .build();
            FirebaseApp.initializeApp(options);
        }
        return FirebaseAuth.getInstance();
    }
}
