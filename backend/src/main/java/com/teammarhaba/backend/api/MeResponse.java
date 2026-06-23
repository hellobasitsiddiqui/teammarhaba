package com.teammarhaba.backend.api;

/**
 * The authenticated caller's profile, returned by {@code GET /api/v1/me}.
 *
 * <p>Identity ({@code uid}/{@code email}) always comes from the verified token. The remaining
 * fields are the self-service profile (TM-112 display name; TM-162 added the rest), persisted in
 * the {@code users} row and editable via {@code PATCH /api/v1/me}.
 *
 * @param uid             the Firebase UID (always present on a verified token)
 * @param email           the caller's email if the token carries one (may be {@code null})
 * @param displayName     the profile name — {@code null} until set (TM-112)
 * @param firstName       given name ({@code null} until set)
 * @param lastName        family name ({@code null} until set)
 * @param city            city ({@code null} until set)
 * @param age             age in years ({@code null} until set)
 * @param phone           contact phone, free-form ({@code null} until set)
 * @param notificationPref preferred notification channel — {@code EMAIL}/{@code PUSH}/{@code BOTH}, default {@code EMAIL}
 * @param timezone        IANA timezone id, e.g. {@code Europe/London} ({@code null} until set)
 * @param locale          BCP-47 locale tag, e.g. {@code en-GB} ({@code null} until set)
 * @param role            the caller's role — defaults to {@code "USER"} until claims land (TM-110)
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
        String notificationPref,
        String timezone,
        String locale,
        String role) {}
