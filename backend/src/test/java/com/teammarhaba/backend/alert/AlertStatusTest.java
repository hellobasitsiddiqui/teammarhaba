package com.teammarhaba.backend.alert;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * The derived {@link AlertStatus} boundary semantics (TM-243) — a pure, Spring-free unit test of the
 * half-open active window ({@code startsAt <= now < expiresAt}). This is the exact edge the public
 * banner read and the admin history's "state" column both hang off, so it is pinned precisely here.
 */
class AlertStatusTest {

    private static final Instant START = Instant.parse("2026-07-09T12:00:00Z");
    private static final Instant END = Instant.parse("2026-07-09T18:00:00Z");

    @Test
    void beforeStartIsScheduled() {
        assertThat(AlertStatus.at(START, END, START.minusMillis(1))).isEqualTo(AlertStatus.SCHEDULED);
    }

    @Test
    void exactlyAtStartIsActive() {
        // startsAt is INCLUSIVE — a notice is live the instant it starts.
        assertThat(AlertStatus.at(START, END, START)).isEqualTo(AlertStatus.ACTIVE);
    }

    @Test
    void insideWindowIsActive() {
        assertThat(AlertStatus.at(START, END, START.plusSeconds(3600))).isEqualTo(AlertStatus.ACTIVE);
    }

    @Test
    void exactlyAtExpiryIsExpired() {
        // expiresAt is EXCLUSIVE — a notice is done the instant it expires.
        assertThat(AlertStatus.at(START, END, END)).isEqualTo(AlertStatus.EXPIRED);
    }

    @Test
    void afterExpiryIsExpired() {
        assertThat(AlertStatus.at(START, END, END.plusMillis(1))).isEqualTo(AlertStatus.EXPIRED);
    }
}
