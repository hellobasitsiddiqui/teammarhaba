package com.teammarhaba.backend.common;

import java.util.List;
import java.util.function.Function;
import org.springframework.data.domain.Page;

/**
 * The standard envelope every collection endpoint returns (TM-115). A consistent shape across
 * lists means clients (web/webview/android) render pagination the same way everywhere.
 *
 * <p>Build one from a Spring Data {@link Page} via {@link #from(Page)} (when the page already holds
 * the response type) or {@link #from(Page, Function)} (to map entities → DTOs in one step). Page
 * numbers are <strong>zero-based</strong>, matching Spring Data.
 *
 * @param <T>           the item type (a DTO — never a JPA entity)
 * @param items         the page's rows
 * @param page          zero-based page number
 * @param size          the page size actually used (already capped — see {@link PageRequests})
 * @param totalElements total matching rows across all pages
 * @param totalPages    total number of pages
 */
public record PageResponse<T>(List<T> items, int page, int size, long totalElements, int totalPages) {

    /** Wrap a page whose content is already the response type. */
    public static <T> PageResponse<T> from(Page<T> page) {
        return new PageResponse<>(
                page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
    }

    /** Wrap a page of entities, mapping each to a DTO. */
    public static <E, T> PageResponse<T> from(Page<E> page, Function<E, T> mapper) {
        List<T> mapped = page.getContent().stream().map(mapper).toList();
        return new PageResponse<>(
                mapped, page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
    }
}
