/**
 * Cross-cutting, product-agnostic conventions reused across the API.
 *
 * <p><b>List conventions (TM-115).</b> Every collection endpoint follows the same contract:
 *
 * <ul>
 *   <li>Request params: {@code page} (zero-based), {@code size} (bounded — see
 *       {@link com.teammarhaba.backend.common.PageRequests#MAX_SIZE}), and {@code sort}
 *       ({@code "property[,asc|desc]"}, allow-listed per endpoint).
 *   <li>Resolve them with {@link com.teammarhaba.backend.common.PageRequests#of} — it caps the
 *       size, floors the page, and rejects un-allow-listed sort properties with a {@code 400}.
 *   <li>Return a {@link com.teammarhaba.backend.common.PageResponse} envelope
 *       ({@code items, page, size, totalElements, totalPages}).
 * </ul>
 *
 * <p>First adopter: the user listing ({@code UserService.list}), which the admin users endpoint
 * (TM-111) exposes over HTTP. New list endpoints opt in by reusing these two types — no per-endpoint
 * pagination code.
 */
package com.teammarhaba.backend.common;
