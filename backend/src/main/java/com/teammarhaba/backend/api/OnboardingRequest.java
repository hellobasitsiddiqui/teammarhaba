package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/me/onboarding} — the first-use "complete your profile" gate
 * (TM-250, extended in TM-880). Unlike the partial {@code PATCH /api/v1/me} (TM-162), every field
 * here is <strong>required</strong>: the gate is atomic, so a user supplies all four minimum fields
 * in one shot and only then enters the app. Identity ({@code uid}/{@code email}) still comes from
 * the verified token, never the client.
 *
 * <p>The fields map onto the existing profile columns (no new schema): {@code name} →
 * {@code displayName} (TM-112), {@code location} → {@code city} (TM-162), {@code age} → {@code age}
 * (TM-162), {@code phone} → {@code phone} (TM-162/TM-781). Reusing the columns keeps the onboarding
 * gate and the self-service edit-profile view (TM-167) writing the same fields, so there is one
 * source of truth per datum.
 *
 * <ul>
 *   <li>{@code name} — required, non-blank, max 255 (a {@code @NotBlank}-equivalent: {@code @NotNull}
 *       plus a min length of 1 after trimming is enforced at the service via {@code requireText}).
 *   <li>{@code location} — required, non-blank, max 255.
 *   <li>{@code age} — required, bounded to the platform age band 18–99 (TM-884; was 13–120).
 *   <li>{@code phone} — required (TM-880: phone is mandatory; email stays optional — it is the
 *       Firebase-auth identity, not a profile field). Must be E.164-shaped, the same stored-value
 *       pattern {@code PATCH /me} enforces (TM-781): a mandatory leading {@code +}, 7–15 digits in
 *       total, separators only between digits — but with <em>no</em> empty-string alternative,
 *       because here the phone cannot be omitted or cleared. This is what makes the completion gate
 *       unbypassable via the API: onboarding cannot be marked complete without a valid phone.
 * </ul>
 *
 * @param name     the public display name; required, 1–255 chars
 * @param location free-text location (stored as {@code city}); required, 1–255 chars
 * @param age      age in years; required, 18–99
 * @param phone    E.164 phone number; required (e.g. {@code +447700900123})
 */
public record OnboardingRequest(
        @NotNull @Size(min = 1, max = 255) String name,
        @NotNull @Size(min = 1, max = 255) String location,
        @NotNull @Min(18) @Max(99) Integer age,
        @NotNull
                @Size(max = 32)
                @Pattern(
                        regexp = "^\\+[0-9](?:[ ()./-]*[0-9]){6,14}$",
                        message = "must be a valid phone number")
                String phone) {}
