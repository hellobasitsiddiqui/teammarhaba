package com.teammarhaba.backend.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

class PageRequestsTest {

    private static final Set<String> ALLOWED = Set.of("id", "email");
    private static final Sort DEFAULT = Sort.by(Sort.Direction.ASC, "id");

    @Test
    void sizeAboveMaxIsClampedToMax() {
        Pageable pageable = PageRequests.of(0, 5000, null, ALLOWED, DEFAULT);
        assertThat(pageable.getPageSize()).isEqualTo(PageRequests.MAX_SIZE);
    }

    @Test
    void nullSizeUsesDefault() {
        assertThat(PageRequests.of(0, null, null, ALLOWED, DEFAULT).getPageSize())
                .isEqualTo(PageRequests.DEFAULT_SIZE);
    }

    @Test
    void sizeBelowOneIsClampedToOne() {
        assertThat(PageRequests.of(0, 0, null, ALLOWED, DEFAULT).getPageSize()).isEqualTo(1);
    }

    @Test
    void nullOrNegativePageBecomesZero() {
        assertThat(PageRequests.of(null, 10, null, ALLOWED, DEFAULT).getPageNumber()).isZero();
        assertThat(PageRequests.of(-3, 10, null, ALLOWED, DEFAULT).getPageNumber()).isZero();
    }

    @Test
    void blankSortFallsBackToDefault() {
        assertThat(PageRequests.of(0, 10, "  ", ALLOWED, DEFAULT).getSort()).isEqualTo(DEFAULT);
    }

    @Test
    void allowListedSortIsAppliedWithDirection() {
        Sort sort = PageRequests.of(0, 10, "email,desc", ALLOWED, DEFAULT).getSort();
        Sort.Order order = sort.getOrderFor("email");
        assertThat(order).isNotNull();
        assertThat(order.getDirection()).isEqualTo(Sort.Direction.DESC);
    }

    @Test
    void sortDefaultsToAscendingWhenDirectionOmitted() {
        Sort.Order order = PageRequests.of(0, 10, "email", ALLOWED, DEFAULT).getSort().getOrderFor("email");
        assertThat(order).isNotNull();
        assertThat(order.getDirection()).isEqualTo(Sort.Direction.ASC);
    }

    @Test
    void unknownSortPropertyIsRejected() {
        assertThatThrownBy(() -> PageRequests.of(0, 10, "ssn", ALLOWED, DEFAULT))
                .isInstanceOf(InvalidListQueryException.class)
                .hasMessageContaining("ssn");
    }
}
