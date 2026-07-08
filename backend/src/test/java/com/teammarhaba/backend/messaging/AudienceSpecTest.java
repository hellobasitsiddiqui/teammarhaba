package com.teammarhaba.backend.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@link AudienceSpec} construction, factory helpers and normalisation — the pure value-object rules
 * that keep every resolved audience canonical, immutable and null-safe (TM-440). No database here;
 * the resolution behaviour is covered by {@link RecipientResolverTest} (mocked) and
 * {@link RecipientResolverIntegrationTest} (real Postgres).
 */
class AudienceSpecTest {

    @Test
    void singleUserFactoryTargetsOnlyThatUser() {
        AudienceSpec spec = AudienceSpec.user(7L);

        assertThat(spec.userIds()).containsExactly(7L);
        assertThat(spec.cities()).isEmpty();
        assertThat(spec.eventIds()).isEmpty();
        assertThat(spec.isEmpty()).isFalse();
    }

    @Test
    void cityFactoryTargetsOnlyThatCity() {
        AudienceSpec spec = AudienceSpec.city("London");

        assertThat(spec.cities()).containsExactly("London");
        assertThat(spec.userIds()).isEmpty();
        assertThat(spec.eventIds()).isEmpty();
    }

    @Test
    void singleEventFactoryTargetsOnlyThatEvent() {
        AudienceSpec spec = AudienceSpec.event(42L);

        assertThat(spec.eventIds()).containsExactly(42L);
        assertThat(spec.userIds()).isEmpty();
        assertThat(spec.cities()).isEmpty();
    }

    @Test
    void multiEventFactoryKeepsEveryEventId() {
        AudienceSpec spec = AudienceSpec.events(List.of(1L, 2L, 3L));

        assertThat(spec.eventIds()).containsExactlyInAnyOrder(1L, 2L, 3L);
    }

    @Test
    void multiCityFactoryTrimsAndDropsBlanks() {
        AudienceSpec spec = AudienceSpec.cities(List.of("  Leeds ", "Hull", " "));

        assertThat(spec.cities()).containsExactlyInAnyOrder("Leeds", "Hull");
    }

    @Test
    void isEmptyOnlyWhenEveryDimensionIsEmpty() {
        assertThat(new AudienceSpec(null, null, null).isEmpty()).isTrue();
        assertThat(AudienceSpec.events(List.of()).isEmpty()).isTrue();
        assertThat(AudienceSpec.user(1L).isEmpty()).isFalse();
    }

    @Test
    void nullCollectionsBecomeEmptyNotNull() {
        AudienceSpec spec = new AudienceSpec(null, null, null);

        assertThat(spec.userIds()).isEmpty();
        assertThat(spec.cities()).isEmpty();
        assertThat(spec.eventIds()).isEmpty();
    }

    @Test
    void duplicatesWithinADimensionCollapse() {
        AudienceSpec spec = AudienceSpec.users(List.of(5L, 5L, 6L));

        assertThat(spec.userIds()).containsExactly(5L, 6L);
    }

    @Test
    void nullIdsAreDropped() {
        // A HashSet can hold a single null element — the canonical constructor takes Sets.
        AudienceSpec spec = new AudienceSpec(new HashSet<>(Arrays.asList(1L, null, 2L)), null, null);

        assertThat(spec.userIds()).containsExactlyInAnyOrder(1L, 2L);
    }

    @Test
    void citiesAreTrimmedAndBlankOrNullEntriesDropped() {
        AudienceSpec spec =
                new AudienceSpec(null, new HashSet<>(Arrays.asList("  Leeds  ", "  ", null, "")), null);

        assertThat(spec.cities()).containsExactly("Leeds");
    }

    @Test
    void cityFactoryToleratesNull() {
        assertThat(AudienceSpec.city(null).cities()).isEmpty();
    }

    @Test
    void factoriesTolerateNullCollections() {
        assertThat(AudienceSpec.users(null).userIds()).isEmpty();
        assertThat(AudienceSpec.events(null).eventIds()).isEmpty();
    }

    @Test
    void collectionsAreUnmodifiable() {
        AudienceSpec spec = AudienceSpec.users(List.of(1L));

        assertThatThrownBy(() -> spec.userIds().add(2L)).isInstanceOf(UnsupportedOperationException.class);
    }
}
