package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import jakarta.validation.Valid;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's own account under {@code /api/v1/me} (the prefix is applied by {@link ApiV1Config}).
 * Reaching it requires a valid Firebase {@code Bearer} token; an anonymous/invalid token gets the
 * uniform RFC 7807 {@code 401} from the security chain (default-deny).
 *
 * <ul>
 *   <li>{@code GET} — returns the persisted profile, <strong>provisioning</strong> the account on
 *       first sight (TM-112) from the verified {@link VerifiedUser} principal.</li>
 *   <li>{@code PATCH} — updates the user-editable profile (display name plus the TM-162 fields:
 *       names, city, age, phone, notification preference, timezone, locale).</li>
 * </ul>
 *
 * <p>Identity ({@code uid}/{@code email}) always comes from the verified token, never the client.
 * {@code role} reflects the stored role (the Firebase custom-claim wiring is TM-110).
 */
@RestController
public class MeController {

    private final UserService userService;

    MeController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/me")
    MeResponse me(@AuthenticationPrincipal VerifiedUser caller) {
        return toResponse(userService.provision(caller));
    }

    @PatchMapping("/me")
    MeResponse updateMe(@AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid UpdateMeRequest request) {
        return toResponse(userService.updateProfile(caller, request.toProfileUpdate()));
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
                user.getNotificationPref().name(),
                user.getTimezone(),
                user.getLocale(),
                user.getRole().name());
    }
}
