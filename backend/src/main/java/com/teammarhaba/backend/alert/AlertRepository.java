package com.teammarhaba.backend.alert;

import java.time.Instant;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Alert} (TM-243) — the site-wide alert store behind the banner + the admin
 * history.
 *
 * <p>Two reads:
 *
 * <ul>
 *   <li>{@link #findActive(String, Instant)} — the banner's public read: the currently-<b>active</b>
 *       alerts for a scope ({@code startsAt <= now < expiresAt}), newest-first. The half-open window
 *       matches {@link AlertStatus#at} exactly, so a notice appears the instant it starts and drops
 *       the instant it expires. Served by the {@code (scope, starts_at, expires_at)} index.
 *   <li>{@link #findAllByOrderByCreatedAtDescIdDesc()} — the admin history: <em>every</em> row
 *       (scheduled/active/expired), newest-first. Rows are never deleted, so this list is the durable
 *       "what was sent and when".
 * </ul>
 */
public interface AlertRepository extends JpaRepository<Alert, Long> {

    /**
     * The active alerts for a scope at {@code now}, newest-first. {@code now} is supplied by the
     * service from the server {@link java.time.Clock}, never the client, so activeness is decided
     * server-side. Ordered by {@code createdAt} (with {@code id} as the deterministic same-instant
     * tiebreak) so the most-recently-composed notice stacks on top.
     */
    @Query(
            """
            select a from Alert a
            where a.scope = :scope and a.startsAt <= :now and a.expiresAt > :now
            order by a.createdAt desc, a.id desc
            """)
    List<Alert> findActive(@Param("scope") String scope, @Param("now") Instant now);

    /** The full history — every alert, newest-first ({@code id} breaks a same-{@code createdAt} tie). */
    List<Alert> findAllByOrderByCreatedAtDescIdDesc();
}
