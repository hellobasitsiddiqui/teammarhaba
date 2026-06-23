package com.teammarhaba.backend.api;

import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.auth.EmailVerificationService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.ProfileUpdate;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's own account under {@code /api/v1/me} (the prefix is applied by {@link ApiV1Config}).
 * Reaching it requires a valid Firebase {@code Bearer} token; an anonymous/invalid token gets the
 * uniform RFC 7807 {@code 401} from the security chain (default-deny).
 *
 * <ul>
 *   <li>{@code GET} — returns the persisted profile, <strong>provisioning</strong> the account on
 *       first sight (TM-112) from the verified {@link VerifiedUser} principal.</li>
 *   <li>{@code PATCH} — updates the user-editable profile (display name plus the real profile
 *       details added in TM-162: names, city, age, phone, notification preference, timezone,
 *       locale). Partial: any omitted/{@code null} field is left unchanged.</li>
 *   <li>{@code POST /me/resend-verification} — re-triggers the Firebase email-verification for the
 *       caller (TM-165); rate-limited per user and refused if the address is already verified.</li>
 * </ul>
 *
 * <p>Identity ({@code uid}/{@code email}) always comes from the verified token, never the client.
 * {@code role} reflects the stored role (the Firebase custom-claim wiring is TM-110).
 */
@RestController
public class MeController {

    private final UserService userService;
    private final EmailVerificationService emailVerificationService;

    MeController(UserService userService, EmailVerificationService emailVerificationService) {
        this.userService = userService;
        this.emailVerificationService = emailVerificationService;
    }

    @GetMapping("/me")
    MeResponse me(@AuthenticationPrincipal VerifiedUser caller) {
        return toResponse(userService.provision(caller));
    }

    @PatchMapping("/me")
    MeResponse updateMe(@AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid UpdateMeRequest request) {
        return toResponse(userService.updateProfile(caller, toProfileUpdate(request)));
    }

    private static ProfileUpdate toProfileUpdate(UpdateMeRequest r) {
        return new ProfileUpdate(
                r.displayName(),
                r.firstName(),
                r.lastName(),
                r.city(),
                r.age(),
                r.phone(),
                r.notificationPref(),
                r.timezone(),
                r.locale());
    }

    /**
     * Re-send the Firebase email-verification for the caller (TM-165). Idempotent under bursts via a
     * per-user cooldown; refused with {@code 422} if the address is already verified (Firebase is the
     * source of truth) and {@code 429} if requested again within the cooldown window. Returns
     * {@code 204 No Content} on a successful trigger — there is no body to return.
     *
     * @throws FirebaseAuthException if the Admin SDK call fails (mapped to {@code 502} in the advice)
     */
    @PostMapping("/me/resend-verification")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void resendVerification(@AuthenticationPrincipal VerifiedUser caller) throws FirebaseAuthException {
        emailVerificationService.resend(caller.uid());
    }

    private static MeResponse toResponse(User user) {
        return new MeResponse(
                user.getFirebaseUid(),
                user.getEmail(),
                user.getDisplayName(),
                user.getFirstName(),
                user.getLastName(),
                user.getCity(),
                user.getAge(),
                user.getPhone(),
                user.getNotificationPref(),
                user.getTimezone(),
                user.getLocale(),
                user.getRole().name());
    }
}
