package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.NotificationPref;

/**
 * The authenticated caller's profile, returned by {@code GET /api/v1/me}. Identity ({@code uid}/
 * {@code email}) comes from the verified token; the rest is the persisted, user-editable profile
 * (TM-112, extended with real profile details in TM-162). Unfilled fields are {@code null}.
 *
 * @param uid              the Firebase UID (always present on a verified token)
 * @param email            the caller's email if the token carries one (may be {@code null})
 * @param displayName      the profile name — {@code null} until the persisted profile lands (TM-112)
 * @param firstName        given name (may be {@code null})
 * @param lastName         family name (may be {@code null})
 * @param city             free-text city (may be {@code null})
 * @param age              age in years (may be {@code null})
 * @param phone            phone number (may be {@code null})
 * @param notificationPref delivery preference — defaults to {@code EMAIL}
 * @param timezone         IANA timezone id (may be {@code null})
 * @param locale           BCP-47 language tag (may be {@code null})
 * @param role             the caller's role — defaults to {@code "USER"} until claims land (TM-110)
 */
public record MeResponse(
        String uid,
        String email,
        String displayName,
        String firstName,
        String lastName,
        String city,
        Integer age,
        String phone,
        NotificationPref notificationPref,
        String timezone,
        String locale,
        String role) {}
