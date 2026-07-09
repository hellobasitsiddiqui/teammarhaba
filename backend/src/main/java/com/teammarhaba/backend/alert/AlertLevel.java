package com.teammarhaba.backend.alert;

/**
 * The severity of a site-wide {@link Alert} banner (TM-243) — it drives the banner's colour on the
 * web. Stored on the {@code alert} row by {@code name()} via {@code EnumType.STRING} (same convention
 * as {@code users.role} / {@code notification.type}), so values may be added later but existing names
 * must never be renamed/removed — old rows keep referencing them.
 *
 * <p>The colour itself is <em>not</em> encoded here: the web maps each level to a Paper theme token
 * ({@code --alert-info} / {@code --alert-warning} / {@code --alert-critical}) so a notice re-tints
 * with the theme rather than carrying a hard-coded hue.
 *
 * <ul>
 *   <li>{@code INFO} — an informational notice (rendered blue).
 *   <li>{@code WARNING} — a heads-up such as the heatwave "events temporarily cancelled" notice
 *       (rendered amber/heat).
 *   <li>{@code CRITICAL} — an urgent notice the user must not miss (rendered red; announced
 *       assertively via {@code role="alert"} on the web).
 * </ul>
 */
public enum AlertLevel {
    INFO,
    WARNING,
    CRITICAL
}
