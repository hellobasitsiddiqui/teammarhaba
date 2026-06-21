package com.teammarhaba.backend.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Verifies the validated binding of {@link AppProperties}: a complete config binds,
 * and a missing or blank required value fails startup (the fail-fast contract that
 * {@code prod} relies on — TM-70).
 */
class AppPropertiesTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(EnableConfig.class);

    @Test
    void bindsCompleteConfig() {
        runner.withPropertyValues(
                        "app.db.name=db",
                        "app.db.user=u",
                        "app.db.password=p",
                        "app.db.instance-connection-name=proj:region:inst",
                        "app.firebase.project-id=pid")
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    AppProperties props = ctx.getBean(AppProperties.class);
                    assertThat(props.db().name()).isEqualTo("db");
                    assertThat(props.db().instanceConnectionName()).isEqualTo("proj:region:inst");
                    assertThat(props.firebase().projectId()).isEqualTo("pid");
                });
    }

    @Test
    void failsFastWhenRequiredValueMissing() {
        // password omitted -> @NotBlank violation -> context fails to start.
        runner.withPropertyValues(
                        "app.db.name=db",
                        "app.db.user=u",
                        "app.db.instance-connection-name=proj:region:inst",
                        "app.firebase.project-id=pid")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void failsFastWhenRequiredValueBlank() {
        runner.withPropertyValues(
                        "app.db.name=db",
                        "app.db.user=u",
                        "app.db.password=",
                        "app.db.instance-connection-name=proj:region:inst",
                        "app.firebase.project-id=pid")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @EnableConfigurationProperties(AppProperties.class)
    static class EnableConfig {}
}
