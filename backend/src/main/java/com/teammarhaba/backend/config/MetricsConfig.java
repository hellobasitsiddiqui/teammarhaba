package com.teammarhaba.backend.config;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Configuration;

/**
 * Registers a sample custom application metric (TM-75) alongside the JVM and HTTP server
 * metrics Spring Boot collects automatically. Everything Micrometer records is exposed at
 * {@code /actuator/metrics} and — under prod — exported to Google Cloud Monitoring via the
 * Stackdriver registry (export is off in dev/test; see {@code application*.yml}).
 *
 * <p>{@code teammarhaba.app.info} is a constant {@code 1} heartbeat — a minimal, always-present
 * series that proves custom metrics flow through to Cloud Monitoring.
 */
@Configuration
public class MetricsConfig {

    public static final String APP_INFO_METRIC = "teammarhaba.app.info";

    public MetricsConfig(MeterRegistry registry) {
        Gauge.builder(APP_INFO_METRIC, () -> 1.0)
                .description("App heartbeat (always 1) — the sample custom metric exported to Cloud Monitoring.")
                .register(registry);
    }
}
