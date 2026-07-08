package com.teammarhaba.backend.user;

/**
 * The user-editable profile fields applied by {@link UserService#updateProfile} (TM-162). A
 * package-local value object so the {@code user} service layer stays decoupled from the web
 * ({@code api}) request type; the controller maps {@code UpdateMeRequest} onto this.
 *
 * <p>Partial-update semantics: any {@code null} field leaves the stored value unchanged, so a
 * caller can patch one field without resending the rest. Syntactic validation (sizes, age range,
 * phone pattern, enum) happens at the web boundary; {@code timezone}/{@code locale} get a
 * best-effort semantic check here in the service.
 */
public record ProfileUpdate(
        String displayName,
        String firstName,
        String lastName,
        String city,
        Integer age,
        String phone,
        NotificationPref notificationPref,
        String timezone,
        String locale,
        String themeAccent,
        Boolean themeSketchy) {}
