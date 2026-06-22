package com.teammarhaba.backend.web;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.util.Map;
import net.logstash.logback.encoder.LogstashEncoder;
import org.junit.jupiter.api.Test;

/**
 * Verifies the prod logging mechanism (TM-73; fixed in TM-140): the {@link LogstashEncoder} the prod
 * appender uses in {@code logback-spring.xml} encodes a log event to JSON that contains the
 * <strong>formatted</strong> message and the MDC {@code traceId}.
 *
 * <p>The TM-140 regression this guards: logback's built-in {@code JsonEncoder} emitted the raw,
 * <em>unsubstituted</em> message (a literal {@code {}}) plus a separate {@code arguments} array, so
 * Cloud Logging showed {@code '{}'} instead of the real values — making prod issues undiagnosable.
 */
class JsonLoggingEncoderTest {

    @Test
    void emitsJsonWithFormattedMessageAndMdcTraceId() {
        LogstashEncoder encoder = new LogstashEncoder();
        encoder.setContext(new LoggerContext());
        encoder.start();

        LoggingEvent event = new LoggingEvent();
        event.setLevel(Level.WARN);
        event.setLoggerName("prod-json-test");
        event.setThreadName("main");
        event.setMessage("promoted admin '{}' to {}");
        event.setArgumentArray(new Object[] {"boss@example.com", "ADMIN"});
        event.setTimeStamp(0L);
        event.setMDCPropertyMap(Map.of("traceId", "trace-xyz-789"));

        String json = new String(encoder.encode(event), UTF_8).trim();

        assertThat(json).startsWith("{").endsWith("}");
        // SLF4J args ARE substituted (the TM-140 fix) — not the literal "{}".
        assertThat(json).contains("promoted admin 'boss@example.com' to ADMIN");
        assertThat(json).doesNotContain("promoted admin '{}'");
        // MDC traceId is lifted to a searchable field.
        assertThat(json).contains("trace-xyz-789");
    }
}
