package com.teammarhaba.backend.api;

/**
 * Response for a successful {@code POST /api/v1/auth/email-code/verify} (TM-234): a Firebase
 * <strong>custom token</strong> the web client exchanges via {@code signInWithCustomToken} to start a
 * normal Firebase session. The custom token is short-lived (Firebase: ~1 hour) and is only useful for
 * that one exchange; it is never logged server-side.
 *
 * @param customToken the Firebase custom token to sign in with
 */
public record EmailCodeVerifyResponse(String customToken) {}
