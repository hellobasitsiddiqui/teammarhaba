package com.teammarhaba.backend.config;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

/**
 * Verifies the sample custom metric (TM-75) is registered with value 1 — the series that proves
 * application metrics flow through Micrometer to Cloud Monitoring. JVM/HTTP metrics are Spring
 * Boot defaults; the dev/test export no-op is covered by the full-context tests booting with the
 * Stackdriver registry on the classpath but export disabled.
 */
class MetricsConfigTest {

    @Test
    void registersSampleCustomMetric() {
        MeterRegistry registry = new SimpleMeterRegistry();

        new MetricsConfig(registry);

        Gauge gauge = registry.find(MetricsConfig.APP_INFO_METRIC).gauge();
        assertThat(gauge).isNotNull();
        assertThat(gauge.value()).isEqualTo(1.0);
    }
}
