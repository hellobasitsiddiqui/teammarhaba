package com.teammarhaba.backend.config;

import jakarta.annotation.PostConstruct;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/**
 * Fail-loud guard for the {@code prod} profile (TM-64). {@link AppProperties} already fails
 * startup on <em>missing or blank</em> required values ({@code @NotBlank}); this adds the
 * second half of "fail closed and loud" — refusing to start when a required secret/config is
 * present but still set to a known <em>dev/test default</em>. A production boot that is silently
 * pointed at a dev password or the test Firebase project must crash, not run insecure.
 *
 * <p>Only active under {@code prod} (it is {@code @Profile("prod")}), so dev/test keep their
 * local defaults. The error message names the offending key but never echoes the secret value.
 *
 * <p>Some dev values intentionally coincide with the real production values (e.g. the dev
 * {@code app.db.name}/{@code app.firebase.project-id} are both {@code teammarhaba}, which is
 * also prod), so those cannot be rejected by exact match — the checks target the values that
 * are <em>only</em> ever valid locally: dev/test DB passwords, a non-Cloud-SQL connection name,
 * and the {@code -test} Firebase project.
 */
@Configuration
@Profile("prod")
public class ProdSecretsValidator {

    /** DB passwords that ship as local defaults and must never reach prod. */
    private static final Set<String> FORBIDDEN_DB_PASSWORDS =
            Set.of("devpassword", "test", "localdevpw", "password", "changeme", "secret");

    /** Dev/test sentinels for the Cloud SQL connection name (a real one is project:region:instance). */
    private static final Set<String> FORBIDDEN_INSTANCE_CONNECTION_NAMES = Set.of("local", "test");

    /** The test Firebase project; the dev value (teammarhaba) is the real prod project, so it's allowed. */
    private static final Set<String> FORBIDDEN_FIREBASE_PROJECT_IDS = Set.of("teammarhaba-test");

    private final AppProperties props;

    public ProdSecretsValidator(AppProperties props) {
        this.props = props;
    }

    @PostConstruct
    void validate() {
        List<String> problems = new ArrayList<>();

        if (FORBIDDEN_DB_PASSWORDS.contains(lower(props.db().password()))) {
            problems.add("app.db.password (DB_PASSWORD) is a known dev/test default - set a real production secret");
        }

        String icn = props.db().instanceConnectionName();
        if (FORBIDDEN_INSTANCE_CONNECTION_NAMES.contains(lower(icn)) || !icn.contains(":")) {
            problems.add("app.db.instance-connection-name (INSTANCE_CONNECTION_NAME) '" + icn
                    + "' is not a Cloud SQL connection name (expected project:region:instance)");
        }

        String projectId = props.firebase().projectId();
        if (FORBIDDEN_FIREBASE_PROJECT_IDS.contains(lower(projectId))) {
            problems.add("app.firebase.project-id (FIREBASE_PROJECT_ID) is the test default '" + projectId
                    + "' - set the real production project");
        }

        if (!problems.isEmpty()) {
            throw new IllegalStateException(
                    "Refusing to start under the 'prod' profile - required secrets/config are missing or still set"
                            + " to dev/test defaults:\n  - " + String.join("\n  - ", problems));
        }
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }
}
