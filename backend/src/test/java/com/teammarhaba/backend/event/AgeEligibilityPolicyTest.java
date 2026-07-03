package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.config.AgeGateProperties;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link AgeEligibilityPolicy} rule and its {@link AgeGateProperties} config
 * (TM-415) — no Spring context. Pins the AC-required cases: the ±2 grace on both band edges
 * (22/23 and 32/33 for a 25–30 band), a single cohort (min == max), an open band (no restriction,
 * even for a null age), a null age on a banded event (409 prompting profile completion), and that
 * the tolerance is the config constant (default 2), plus the honest 409 copy naming the band. The
 * HTTP-level guard on RSVP / waitlist-join / claim lives in {@code EventAgeEligibilityIntegrationTest}.
 */
class AgeEligibilityPolicyTest {

    private static final AgeEligibilityPolicy POLICY = new AgeEligibilityPolicy(new AgeGateProperties(2));

    private static Event band(Integer ageMin, Integer ageMax) {
        Instant start = Instant.parse("2030-06-15T18:00:00Z");
        Event event = new Event(
                "Heading",
                "Body",
                "Marhaba Cafe",
                "Europe/London",
                start,
                start.minus(30, ChronoUnit.DAYS),
                start.plus(1, ChronoUnit.DAYS),
                1L,
                Instant.now());
        event.setAgeMin(ageMin);
        event.setAgeMax(ageMax);
        return event;
    }

    private static User aged(Integer age) {
        User user = new User("uid-" + age, "u@example.com", "U");
        user.setAge(age);
        return user;
    }

    // --- full band 25–30, tolerance 2 → allowed 23..32 ---

    @Test
    void bandEdgesRespectTheTwoYearGraceEitherSide() {
        Event event = band(25, 30);
        assertThat(POLICY.eligibility(event, 22)).as("one below the graced lower edge").isFalse();
        assertThat(POLICY.eligibility(event, 23)).as("graced lower edge (25 − 2)").isTrue();
        assertThat(POLICY.eligibility(event, 32)).as("graced upper edge (30 + 2)").isTrue();
        assertThat(POLICY.eligibility(event, 33)).as("one above the graced upper edge").isFalse();
    }

    @Test
    void outOfBandThrows409NamingTheBandAndInBandIsQuiet() {
        Event event = band(25, 30);
        assertThatThrownBy(() -> POLICY.ensureEligible(event, aged(22)))
                .isInstanceOf(ConflictException.class)
                .hasMessage("This event is for ages 25–30.");
        assertThatThrownBy(() -> POLICY.ensureEligible(event, aged(33)))
                .isInstanceOf(ConflictException.class)
                .hasMessage("This event is for ages 25–30.");
        assertThatCode(() -> POLICY.ensureEligible(event, aged(23))).doesNotThrowAnyException();
        assertThatCode(() -> POLICY.ensureEligible(event, aged(32))).doesNotThrowAnyException();
    }

    // --- single cohort min == max == 28 → allowed 26..30 ---

    @Test
    void singleCohortAllowsTheGraceEitherSideAndNamesASingleAge() {
        Event event = band(28, 28);
        assertThat(POLICY.eligibility(event, 25)).isFalse();
        assertThat(POLICY.eligibility(event, 26)).isTrue();
        assertThat(POLICY.eligibility(event, 30)).isTrue();
        assertThat(POLICY.eligibility(event, 31)).isFalse();
        assertThatThrownBy(() -> POLICY.ensureEligible(event, aged(31)))
                .isInstanceOf(ConflictException.class)
                .hasMessage("This event is for ages 28.");
    }

    // --- open band (both null) = no restriction, even for a null age ---

    @Test
    void openBandIsUnrestrictedEvenForAnUnsetAge() {
        Event open = band(null, null);
        assertThat(POLICY.eligibility(open, null)).as("null verdict = no restriction").isNull();
        assertThat(POLICY.eligibility(open, 5)).isNull();
        assertThatCode(() -> POLICY.ensureEligible(open, aged(null))).doesNotThrowAnyException();
        assertThatCode(() -> POLICY.ensureEligible(open, aged(70))).doesNotThrowAnyException();
    }

    // --- null age on a banded event → 409 prompting profile completion (never a silent pass) ---

    @Test
    void unsetAgeOnABandedEventIsRejectedWithAProfilePrompt() {
        Event event = band(25, 30);
        assertThat(POLICY.eligibility(event, null)).isFalse();
        assertThatThrownBy(() -> POLICY.ensureEligible(event, aged(null)))
                .isInstanceOf(ConflictException.class)
                .hasMessage(AgeEligibilityPolicy.AGE_NOT_SET);
    }

    // --- half-open bands: only one edge set ---

    @Test
    void halfOpenBandsBoundOnlyOneSideAndLabelAccordingly() {
        assertThat(POLICY.eligibility(band(18, null), 16)).as("18 − 2").isTrue();
        assertThat(POLICY.eligibility(band(18, null), 15)).isFalse();
        assertThat(POLICY.eligibility(band(null, 12), 14)).as("12 + 2").isTrue();
        assertThat(POLICY.eligibility(band(null, 12), 15)).isFalse();
        assertThatThrownBy(() -> POLICY.ensureEligible(band(18, null), aged(15)))
                .hasMessage("This event is for ages 18 and up.");
        assertThatThrownBy(() -> POLICY.ensureEligible(band(null, 12), aged(15)))
                .hasMessage("This event is for ages up to 12.");
    }

    // --- the tolerance is the config constant (default 2) ---

    @Test
    void toleranceComesFromConfigAndDefaultsToTwo() {
        AgeEligibilityPolicy strict = new AgeEligibilityPolicy(new AgeGateProperties(0));
        Event event = band(25, 30);
        assertThat(strict.eligibility(event, 24)).as("no grace at tolerance 0").isFalse();
        assertThat(strict.eligibility(event, 25)).isTrue();
        assertThat(strict.eligibility(event, 30)).isTrue();
        assertThat(strict.eligibility(event, 31)).isFalse();

        // A null or negative config value fails safe to the shipped default of 2.
        assertThat(new AgeGateProperties(null).toleranceYears()).isEqualTo(2);
        assertThat(new AgeGateProperties(-5).toleranceYears()).isEqualTo(2);
        assertThat(AgeGateProperties.DEFAULT_TOLERANCE_YEARS).isEqualTo(2);
    }
}
