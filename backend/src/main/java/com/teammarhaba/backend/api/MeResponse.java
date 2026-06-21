package com.teammarhaba.backend.api;

/**
 * The verified caller's identity, returned by {@link MeController} at {@code GET /api/v1/me}.
 *
 * @param uid         the Firebase user id ({@code sub}); always present on a verified token
 * @param email       the caller's email if the token carries one (may be {@code null})
 * @param displayName the caller's display name; currently always {@code null} because the
 *                    {@link com.teammarhaba.backend.auth.VerifiedUser} principal does not yet
 *                    carry the token's {@code name} claim (see the TM-107 finding)
 * @param role        the caller's role; a fixed {@code USER} until RBAC (2.3) lands
 */
public record MeResponse(String uid, String email, String displayName, String role) {}
