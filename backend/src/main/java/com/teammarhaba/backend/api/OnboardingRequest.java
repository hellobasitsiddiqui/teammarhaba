package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/me/onboarding} — the first-login "complete your profile" gate
 * (TM-250). Unlike the partial {@code PATCH /api/v1/me} (TM-162), every field here is
 * <strong>required</strong>: the gate is atomic, so a new user supplies all three minimum fields in
 * one shot and only then enters the app. Identity ({@code uid}/{@code email}) still comes from the
 * verified token, never the client.
 *
 * <p>The three fields map onto the existing profile columns (no new schema): {@code name} →
 * {@code displayName} (TM-112), {@code location} → {@code city} (TM-162), {@code age} → {@code age}
 * (TM-162). Reusing the columns keeps the onboarding gate and the self-service edit-profile view
 * (TM-167) writing the same fields, so there is one source of truth per datum.
 *
 * <ul>
 *   <li>{@code name} — required, non-blank, max 255 (a {@code @NotBlank}-equivalent: {@code @NotNull}
 *       plus a min length of 1 after trimming is enforced at the service via {@code requireText}).
 *   <li>{@code location} — required, non-blank, max 255.
 *   <li>{@code age} — required, bounded to the same sane human range as the rest of the app (13–120).
 * </ul>
 *
 * @param name     the public display name; required, 1–255 chars
 * @param location free-text location (stored as {@code city}); required, 1–255 chars
 * @param age      age in years; required, 13–120
 */
public record OnboardingRequest(
        @NotNull @Size(min = 1, max = 255) String name,
        @NotNull @Size(min = 1, max = 255) String location,
        @NotNull @Min(13) @Max(120) Integer age) {}
