package com.teammarhaba.backend.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Server-side verified-phone enforcement flag, bound from {@code app.phone.*} (TM-931, subticket B
 * of TM-923). Picked up by {@code @ConfigurationPropertiesScan} on {@code Application}.
 *
 * <p>{@code requireVerified} defaults to <strong>{@code false}</strong> and is deliberately not set
 * in any committed config ({@code application.yml}, {@code application-test.yml}, dev defaults). This
 * is a deploy-safety flag: this PR ships and deploys <em>before</em> subticket A's (TM-930) gate UI
 * is live in prod, so with the flag off the onboarding transitions keep their exact current
 * behaviour — no Firebase Admin SDK call is added to either path (see {@code VerifiedPhoneService}
 * and {@code UserService.completeOnboarding}/{@code completeProfileOnboarding}), and the whole
 * dev/test/CI boot stays credential-free.
 *
 * <p>The flag flips to {@code true} (env {@code APP_PHONE_REQUIRE_VERIFIED=true}) only after TM-930
 * is live in prod, at which point both onboarding transitions additionally require — and mirror onto
 * {@code users.phone} — a Firebase-verified E.164 phone for the caller's uid, failing closed if that
 * phone cannot be read.
 *
 * @param requireVerified when {@code true}, enforce a Firebase-verified phone on the onboarding
 *     transitions; defaults to {@code false} (the shipped, deploy-safe baseline).
 */
@ConfigurationProperties(prefix = "app.phone")
public record PhoneVerificationProperties(boolean requireVerified) {}
