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
 *       Name-like (TM-771, added by TM-898): the same {@code NAME_LIKE} pattern as
 *       {@code UpdateMeRequest.firstName}/{@code lastName} — the captured name seeds
 *       {@code firstName}/{@code lastName} (TM-883), so a purely numeric name would persist parts
 *       the edit form's own validation then refuses to re-save.
 *   <li>{@code location} — required, non-blank, max 255. Name-like too (TM-898): it maps onto the
 *       same {@code city} column {@code UpdateMeRequest.city} guards. The TM-877 allowed-city list
 *       is additionally enforced in {@link com.teammarhaba.backend.user.UserService} (it needs the
 *       stored row for the saved-value allowance), exactly as it is for {@code PATCH /me}.
 *   <li>{@code age} — required, bounded to the platform age band 18–99 (TM-884; was 13–120). Unlike
 *       {@code PATCH /me} (whose band moved into the service behind the unchanged-guard, TM-900),
 *       the hard band stays here: every gate submission (re)writes the age, so there is no
 *       unchanged-value case to grandfather.
 *   <li>{@code phone} — required (TM-880: phone is mandatory; email stays optional — it is the
 *       Firebase-auth identity, not a profile field). Must be E.164-shaped, the same stored-value
 *       pattern {@code PATCH /me} enforces (TM-781): a mandatory leading {@code +}, 7–15 digits in
 *       total, separators only between digits — but with <em>no</em> empty-string alternative,
 *       because here the phone cannot be omitted or cleared. This is what makes the completion gate
 *       unbypassable via the API: onboarding cannot be marked complete without a valid phone.
 * </ul>
 *
 * @param name     the public display name; required, 1–255 chars, name-like (TM-771/TM-898)
 * @param location the profile city (stored as {@code city}); required, 1–255 chars, name-like, and
 *                 allowed-list constrained in the service (TM-877/TM-898)
 * @param age      age in years; required, 18–99
 * @param phone    E.164 phone number; required (e.g. {@code +447700900123})
 */
public record OnboardingRequest(
        @NotNull
                @Size(min = 1, max = 255)
                @Pattern(regexp = UpdateMeRequest.NAME_LIKE, message = UpdateMeRequest.NAME_LIKE_MESSAGE)
                String name,
        @NotNull
                @Size(min = 1, max = 255)
                @Pattern(regexp = UpdateMeRequest.NAME_LIKE, message = UpdateMeRequest.NAME_LIKE_MESSAGE)
                String location,
        @NotNull @Min(18) @Max(99) Integer age,
        @NotNull
                @Size(max = 32)
                @Pattern(
                        regexp = "^\\+[0-9](?:[ ()./-]*[0-9]){6,14}$",
                        message = "must be a valid phone number")
                String phone) {}
