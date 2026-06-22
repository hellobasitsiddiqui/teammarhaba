package com.teammarhaba.backend.api;

import java.util.List;
import org.springframework.data.domain.Page;

/**
 * A consistent paged-list envelope: the page of {@code items} plus the metadata a client needs to
 * render pagination (current page, page size, totals).
 *
 * <p><strong>Interim (TM-111).</strong> TM-115 owns the reusable list convention (a shared
 * {@code PagedResponse} + size-cap + sort guard in {@code common/}); this is the first real consumer
 * (the admin user list) and is intentionally local so TM-111 ships without blocking on TM-115. When
 * TM-115 lands, this should be replaced by the shared envelope — see the follow-up note on TM-111.
 *
 * @param items         the items on this page
 * @param page          zero-based page index
 * @param size          page size actually used (after the max-size cap)
 * @param totalElements total matching elements across all pages
 * @param totalPages    total number of pages
 */
public record PagedResponse<T>(List<T> items, int page, int size, long totalElements, int totalPages) {

    /** Map a Spring Data {@link Page} of entities to a {@code PagedResponse} of DTOs. */
    public static <E, D> PagedResponse<D> from(Page<E> page, java.util.function.Function<E, D> toDto) {
        return new PagedResponse<>(
                page.getContent().stream().map(toDto).toList(),
                page.getNumber(),
                page.getSize(),
                page.getTotalElements(),
                page.getTotalPages());
    }
}
