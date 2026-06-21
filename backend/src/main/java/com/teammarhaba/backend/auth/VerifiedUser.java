package com.teammarhaba.backend.auth;

/**
 * The authenticated caller, established from a verified Firebase ID token (TM-79). Set as the
 * Spring Security {@code Authentication} principal, so a handler can read it with
 * {@code @AuthenticationPrincipal VerifiedUser}.
 *
 * @param uid   the Firebase user id ({@code sub}); always present on a verified token
 * @param email the caller's email if the token carries one (may be {@code null})
 */
public record VerifiedUser(String uid, String email) {}
