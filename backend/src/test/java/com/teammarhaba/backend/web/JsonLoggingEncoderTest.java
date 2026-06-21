package com.teammarhaba.backend.web;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.encoder.JsonEncoder;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Verifies the prod logging mechanism: logback's {@code JsonEncoder} (the encoder the prod
 * appender uses in {@code logback-spring.xml}) encodes a log event to JSON that includes both the
 * message and the MDC {@code traceId} — so prod logs are structured and correlatable. The dev/test
 * console path is exercised implicitly by the rest of the suite booting under the {@code test}
 * profile with {@code logback-spring.xml} loaded.
 */
class JsonLoggingEncoderTest {

    @Test
    void emitsJsonContainingMessageAndMdcTraceId() {
        JsonEncoder encoder = new JsonEncoder();
        encoder.setContext(new LoggerContext());
        encoder.start();

        LoggingEvent event = new LoggingEvent();
        event.setLevel(Level.INFO);
        event.setLoggerName("prod-json-test");
        event.setThreadName("main");
        event.setMessage("structured hello");
        event.setTimeStamp(0L);
        event.setMDCPropertyMap(Map.of("traceId", "trace-xyz-789"));

        String json = new String(encoder.encode(event), UTF_8).trim();

        assertThat(json).startsWith("{").endsWith("}");
        assertThat(json).contains("structured hello");
        assertThat(json).contains("trace-xyz-789");
    }
}
