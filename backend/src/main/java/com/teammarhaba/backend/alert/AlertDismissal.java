package com.teammarhaba.backend.alert;

/**
 * How a user may dismiss a site-wide {@link Alert} banner (TM-243). The banner is server-driven, but
 * the <em>dismissal</em> is entirely a client concern (the backend never records who dismissed what) —
 * this enum is simply the instruction the web reads to decide which control to render and where to
 * remember the dismissal. Stored by {@code name()} via {@code EnumType.STRING}; add values freely but
 * never rename/remove existing ones (old rows reference them).
 *
 * <ul>
 *   <li>{@code ACKNOWLEDGE} — sticky. The banner shows an "OK" button; the web persists the dismissal
 *       in {@code localStorage} keyed by the alert id <b>plus a content hash</b>, so it never nags
 *       again — but an <em>edited</em> alert (new content hash) re-shows.
 *   <li>{@code DISMISS} — session-only. The banner shows a "✕" close that hides it for the current
 *       browser session ({@code sessionStorage}); it returns next session until it expires.
 *   <li>{@code PERSISTENT} — no dismiss control at all; the banner disappears only when it reaches
 *       {@code expiresAt}.
 * </ul>
 */
public enum AlertDismissal {
    ACKNOWLEDGE,
    DISMISS,
    PERSISTENT
}
