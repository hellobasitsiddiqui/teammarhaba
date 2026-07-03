package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.AgeGateProperties;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.web.ConflictException;
import org.springframework.stereotype.Component;

/**
 * The single resolver for event age-group eligibility (TM-415) — the hard, server-side guard that a
 * user's self-reported {@link User#getAge() age} falls inside an event's target band, widened by the
 * app-level ±tolerance grace ({@link AgeGateProperties#toleranceYears()}). It is the one place the
 * rule lives, so the write-side guard ({@link EventRsvpService} on RSVP / waitlist-join / claim) and
 * the read-side affordance ({@link EventQueryService}, which tells the detail view whether the
 * caller is eligible) can never disagree.
 *
 * <p><b>The rule</b> — an event with no band ({@link Event#hasAgeRestriction()} {@code false}, i.e.
 * both edges {@code null}) is open to all ages: always eligible, even for a user who has not set an
 * age. A banded event requires an age: a {@code null} age is rejected so the caller completes their
 * profile first — never a silent pass. Otherwise eligible iff
 * {@code age_min − tolerance ≤ age ≤ age_max + tolerance}, where a {@code null} edge leaves that side
 * unbounded (a half-open band). Example: band 25–30 with tolerance 2 admits 23–32; a single cohort
 * (min == max == 28) admits 26–30.
 *
 * <p><b>Self-attestation only</b> — the basis is the self-reported {@code User.age}; there is no ID
 * verification here (real verification is out of scope, TM-163). {@link User#isAgeVerified()} is the
 * seam a future verification ticket would additionally require — this guard deliberately does not
 * gate on it yet.
 */
@Component
public class AgeEligibilityPolicy {

    /** 409 copy when a banded event is hit by a user who has not set their age yet. */
    static final String AGE_NOT_SET =
            "Set your age on your profile to RSVP — this event is limited to a specific age group.";

    private final AgeGateProperties properties;

    public AgeEligibilityPolicy(AgeGateProperties properties) {
        this.properties = properties;
    }

    /**
     * Enforce the hard guard, throwing a {@link ConflictException} (mapped to {@code 409}) with
     * honest, user-facing copy when the user may not attend: an unset age on a banded event prompts
     * profile completion; an out-of-band age names the band ("This event is for ages 25–30."). An
     * open-band event is a quiet no-op.
     */
    public void ensureEligible(Event event, User user) {
        if (!event.hasAgeRestriction()) {
            return; // open to all ages — no restriction
        }
        Integer age = user.getAge();
        if (age == null) {
            throw new ConflictException(AGE_NOT_SET);
        }
        if (!withinBand(event, age)) {
            throw new ConflictException("This event is for ages " + event.ageBandLabel() + ".");
        }
    }

    /**
     * Per-caller eligibility for the read side (the detail view's RSVP-enable signal): {@code null}
     * when the event has no age band (unrestricted — nothing for the client to disable); otherwise
     * {@code true} iff the given age is set and within the tolerance-widened band. A {@code null} age
     * on a banded event is {@code false} (ineligible until they set it). The client pairs this with
     * the user's own known age to choose the copy — "set your age" vs "this event is for ages …".
     */
    public Boolean eligibility(Event event, Integer age) {
        if (!event.hasAgeRestriction()) {
            return null; // no restriction — the client shows RSVP normally
        }
        return age != null && withinBand(event, age);
    }

    /** The band-membership test with the ±tolerance grace; a {@code null} edge is unbounded. */
    private boolean withinBand(Event event, int age) {
        int tolerance = properties.toleranceYears();
        Integer min = event.getAgeMin();
        Integer max = event.getAgeMax();
        boolean aboveLower = (min == null) || age >= min - tolerance;
        boolean belowUpper = (max == null) || age <= max + tolerance;
        return aboveLower && belowUpper;
    }
}
