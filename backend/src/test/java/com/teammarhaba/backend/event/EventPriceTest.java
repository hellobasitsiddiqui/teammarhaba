package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Unit cover for the TM-475 price + premium event attributes on the {@link Event} entity itself —
 * the pure, DB-free half of the feature (the end-to-end create/patch/projection behaviour lives in
 * {@code EventAdminControllerIntegrationTest} / {@code EventControllerIntegrationTest}).
 *
 * <p>The load-bearing fact here is the <b>default</b>: a freshly built event — before any admin
 * override — is priced at £5 (500 pence) and not premium, matching the {@code price_pence DEFAULT
 * 500} / {@code is_premium DEFAULT false} the V21 migration also applies. That default is what keeps
 * an admin create that omits the price well-defined without the service having to invent one.
 */
class EventPriceTest {

    /** Build a minimal valid event through the real constructor (the create path's starting point). */
    private static Event newEvent() {
        Instant now = Instant.now();
        return new Event(
                "Marhaba picnic",
                "Bring a dish to share.",
                "Victoria Park",
                "Europe/London",
                now.plusSeconds(86_400), // startAt
                now, // visibilityStart
                now.plusSeconds(172_800), // visibilityEnd
                1L, // createdBy
                now);
    }

    @Test
    void freshEventDefaultsToFivePoundsAndNotPremium() {
        Event event = newEvent();

        // £5.00 == 500 pence, and un-gated — the values the admin form falls back to on omission.
        assertThat(event.getPricePence()).isEqualTo(500);
        assertThat(Event.DEFAULT_PRICE_PENCE).isEqualTo(500);
        assertThat(event.isPremium()).isFalse();
    }

    @Test
    void priceAndPremiumAreSettable() {
        Event event = newEvent();

        event.setPricePence(1500); // £15.00
        event.setPremium(true);

        assertThat(event.getPricePence()).isEqualTo(1500);
        assertThat(event.isPremium()).isTrue();
    }

    @Test
    void zeroPriceRepresentsAFreeEvent() {
        Event event = newEvent();

        event.setPricePence(0);

        assertThat(event.getPricePence()).isZero();
    }
}
