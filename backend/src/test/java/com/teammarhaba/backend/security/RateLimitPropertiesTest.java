package com.teammarhaba.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Verifies the validated binding of {@link RateLimitProperties} (TM-158): safe defaults apply out of
 * the box, explicit values bind, the master switch can be turned off explicitly, and a non-positive
 * refill period fails startup loudly rather than silently disabling the guard.
 */
class RateLimitPropertiesTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(EnableConfig.class);

    @Test
    void appliesSafeDefaultsWhenUnset() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            RateLimitProperties props = ctx.getBean(RateLimitProperties.class);
            assertThat(props.enabled()).isTrue(); // absent -> ON (wrapper Boolean, not primitive false)
            assertThat(props.capacity()).isEqualTo(120);
            assertThat(props.refillTokens()).isEqualTo(120);
            assertThat(props.refillPeriod()).isEqualTo(Duration.ofMinutes(1));
            assertThat(props.maxTrackedClients()).isEqualTo(100_000);
        });
    }

    @Test
    void bindsExplicitValues() {
        runner.withPropertyValues(
                        "app.rate-limit.enabled=true",
                        "app.rate-limit.capacity=50",
                        "app.rate-limit.refill-tokens=25",
                        "app.rate-limit.refill-period=30s",
                        "app.rate-limit.max-tracked-clients=1000")
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    RateLimitProperties props = ctx.getBean(RateLimitProperties.class);
                    assertThat(props.capacity()).isEqualTo(50);
                    assertThat(props.refillTokens()).isEqualTo(25);
                    assertThat(props.refillPeriod()).isEqualTo(Duration.ofSeconds(30));
                    assertThat(props.maxTrackedClients()).isEqualTo(1000);
                });
    }

    @Test
    void masterSwitchCanBeDisabledExplicitly() {
        runner.withPropertyValues("app.rate-limit.enabled=false").run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(RateLimitProperties.class).enabled()).isFalse();
        });
    }

    @Test
    void failsFastOnNonPositiveRefillPeriod() {
        runner.withPropertyValues("app.rate-limit.refill-period=0s").run(ctx -> assertThat(ctx).hasFailed());
    }

    @EnableConfigurationProperties(RateLimitProperties.class)
    static class EnableConfig {}
}
