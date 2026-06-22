package com.teammarhaba.backend.common;

import java.util.Set;
import java.util.TreeSet;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

/**
 * Builds a safe {@link Pageable} from raw request params (TM-115) — the one place the list
 * conventions are enforced, so every collection endpoint behaves identically:
 *
 * <ul>
 *   <li><b>size is bounded</b> to {@code [1, MAX_SIZE]} (default {@code DEFAULT_SIZE}) — no caller
 *       can request an unbounded result set;
 *   <li><b>page</b> is floored at {@code 0};
 *   <li><b>sort</b> is <b>allow-listed</b> — only properties the endpoint opts in are accepted;
 *       anything else is a {@code 400} ({@link InvalidListQueryException}), never passed through to
 *       Spring Data (which would leak schema details / throw a 500).
 * </ul>
 *
 * <p>The {@code sort} param is {@code "property"} or {@code "property,(asc|desc)"} (default asc).
 */
public final class PageRequests {

    /** Default page size when the caller doesn't specify one. */
    public static final int DEFAULT_SIZE = 20;

    /** Hard ceiling on page size — requests above this are clamped down. */
    public static final int MAX_SIZE = 100;

    private PageRequests() {}

    /**
     * @param page                  zero-based page (null/negative → 0)
     * @param size                  page size (null → {@link #DEFAULT_SIZE}; clamped to {@code [1, MAX_SIZE]})
     * @param sort                  {@code "property[,asc|desc]"} (null/blank → {@code defaultSort})
     * @param allowedSortProperties properties the endpoint permits sorting on
     * @param defaultSort           the sort to use when none is requested
     */
    public static Pageable of(
            Integer page, Integer size, String sort, Set<String> allowedSortProperties, Sort defaultSort) {
        int resolvedPage = (page == null || page < 0) ? 0 : page;
        int resolvedSize = (size == null) ? DEFAULT_SIZE : Math.min(Math.max(size, 1), MAX_SIZE);
        return PageRequest.of(resolvedPage, resolvedSize, resolveSort(sort, allowedSortProperties, defaultSort));
    }

    private static Sort resolveSort(String sort, Set<String> allowedSortProperties, Sort defaultSort) {
        if (sort == null || sort.isBlank()) {
            return defaultSort;
        }
        String[] parts = sort.split(",");
        String property = parts[0].trim();
        if (!allowedSortProperties.contains(property)) {
            throw new InvalidListQueryException(
                    "Unknown sort property '" + property + "'. Allowed: " + new TreeSet<>(allowedSortProperties));
        }
        Sort.Direction direction = (parts.length > 1 && "desc".equalsIgnoreCase(parts[1].trim()))
                ? Sort.Direction.DESC
                : Sort.Direction.ASC;
        return Sort.by(direction, property);
    }
}
