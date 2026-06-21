package com.teammarhaba.backend.api;

/**
 * The authenticated caller's identity, returned by {@code GET /api/v1/me}.
 *
 * @param uid         the Firebase UID (always present on a verified token)
 * @param email       the caller's email if the token carries one (may be {@code null})
 * @param displayName the profile name — {@code null} until the persisted profile lands (TM-112)
 * @param role        the caller's role — defaults to {@code "USER"} until claims land (TM-110)
 */
public record MeResponse(String uid, String email, String displayName, String role) {}
