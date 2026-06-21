package com.teammarhaba.backend.config;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.config.AppProperties.Db;
import com.teammarhaba.backend.config.AppProperties.Firebase;
import org.junit.jupiter.api.Test;

/**
 * Verifies the prod fail-loud guard (TM-64): real production config passes, but a value left
 * at a known dev/test default makes {@code validate()} throw — and the message never leaks the
 * secret value.
 */
class ProdSecretsValidatorTest {

    private static final String REAL_ICN = "teammarhaba:europe-west2:teammarhaba-pg";

    private static ProdSecretsValidator validator(String password, String icn, String projectId) {
        AppProperties props =
                new AppProperties(new Db("teammarhaba", "app", password, icn), new Firebase(projectId));
        return new ProdSecretsValidator(props);
    }

    @Test
    void acceptsRealProductionConfig() {
        assertThatCode(validator("S3cure-real-prod-secret", REAL_ICN, "teammarhaba")::validate)
                .doesNotThrowAnyException();
    }

    @Test
    void rejectsDevDefaultDbPassword() {
        assertThatThrownBy(validator("devpassword", REAL_ICN, "teammarhaba")::validate)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("app.db.password");
    }

    @Test
    void rejectsTestDbPassword() {
        assertThatThrownBy(validator("test", REAL_ICN, "teammarhaba")::validate)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DB_PASSWORD");
    }

    @Test
    void rejectsDevInstanceConnectionName() {
        assertThatThrownBy(validator("S3cure-real-prod-secret", "local", "teammarhaba")::validate)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("instance-connection-name");
    }

    @Test
    void rejectsTestFirebaseProject() {
        assertThatThrownBy(validator("S3cure-real-prod-secret", REAL_ICN, "teammarhaba-test")::validate)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("project");
    }

    @Test
    void errorMessageNeverEchoesTheSecret() {
        assertThatThrownBy(validator("devpassword", REAL_ICN, "teammarhaba")::validate)
                .hasMessageNotContaining("devpassword");
    }
}
