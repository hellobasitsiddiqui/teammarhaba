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
 *
 * <p>{@code interests} (TM-775) is a <strong>full-set replace</strong>: a non-null label list is the
 * user's complete new selection (the prior saved set is replaced with it); {@code null} leaves the
 * saved interests unchanged. The labels are validated against the active catalogue and the configured
 * min/max in {@link UserService}, not at the web boundary (the bounds are DB-backed).
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
        Boolean themeSketchy,
        java.util.List<String> interests) {}
