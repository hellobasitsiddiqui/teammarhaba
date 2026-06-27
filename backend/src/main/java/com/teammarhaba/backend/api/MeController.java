package com.teammarhaba.backend.api;

import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.AccountState;
import com.teammarhaba.backend.auth.EmailVerificationService;
import com.teammarhaba.backend.auth.FirebaseAccountStateService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.config.TermsProperties;
import com.teammarhaba.backend.user.ProfileUpdate;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import jakarta.validation.Valid;
import java.util.Set;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
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
 *   <li>{@code POST /me/onboarding-complete} — marks first-run onboarding finished and self-attests
 *       the supplied age (TM-163); idempotent.</li>
 *   <li>{@code POST /me/onboarding} — the first-login profile gate (TM-250): atomically persists the
 *       three required minimum fields (name/location/age) and marks onboarding complete.</li>
 *   <li>{@code POST /me/accept-terms} — records the accepted terms version + acceptance time
 *       (TM-163). {@code GET /me} also reports the <strong>currently published</strong> terms version
 *       ({@code currentTermsVersion}, TM-170) so the client can gate the app until the user has
 *       accepted that version.</li>
 * </ul>
 *
 * <p>Identity ({@code uid}/{@code email}) always comes from the verified token, never the client.
 * {@code role} reflects the stored role (the Firebase custom-claim wiring is TM-110).
 */
@RestController
public class MeController {

    /** History is a timeline — sort only by time/identity, newest first by default (TM-185). */
    private static final Set<String> HISTORY_SORTABLE = Set.of("createdAt", "id");

    private static final Sort HISTORY_DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "createdAt");

    private final UserService userService;
    private final EmailVerificationService emailVerificationService;
    private final FirebaseAccountStateService accountStateService;
    private final AuditService auditService;
    private final TermsProperties termsProperties;

    MeController(
            UserService userService,
            EmailVerificationService emailVerificationService,
            FirebaseAccountStateService accountStateService,
            AuditService auditService,
            TermsProperties termsProperties) {
        this.userService = userService;
        this.emailVerificationService = emailVerificationService;
        this.accountStateService = accountStateService;
        this.auditService = auditService;
        this.termsProperties = termsProperties;
    }

    /**
     * The caller's profile, plus the live Firebase-owned account state and our own "last active"
     * marker (TM-164). Provisioning stamps {@code last_active_at = now()} (cheap single-column
     * update); the Firebase state ({@code emailVerified}, {@code mfaEnabled}, {@code phoneVerified},
     * {@code photoURL}, {@code lastLoginAt}) is read live from the Admin SDK and never persisted —
     * Firebase stays the source of truth. Reading that state is best-effort: if Firebase can't be
     * reached (e.g. credential-free dev), the block degrades to {@code null}s rather than failing.
     */
    @GetMapping("/me")
    MeResponse me(@AuthenticationPrincipal VerifiedUser caller) {
        User user = userService.provisionAndTouch(caller);
        AccountState state = accountStateService.forUid(caller.uid());
        return toResponse(user, state);
    }

    @PatchMapping("/me")
    MeResponse updateMe(@AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid UpdateMeRequest request) {
        return toResponse(userService.updateProfile(caller, toProfileUpdate(request)));
    }

    /**
     * The caller's own profile-change history (TM-185), newest first, paginated via the shared list
     * convention. Each entry is a {@code PROFILE_UPDATED} audit row whose {@code metadata} carries the
     * field-level {@code old → new} diff, the source ({@code self}/{@code admin}), and the actor. A
     * user only ever sees their own history — the target is the verified token's uid, never a param.
     */
    @GetMapping("/me/history")
    PageResponse<AuditEventResponse> history(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, HISTORY_SORTABLE, HISTORY_DEFAULT_SORT);
        return PageResponse.from(auditService.profileHistory(caller.uid(), pageable), AuditEventResponse::from);
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

    /**
     * Mark first-run onboarding complete for the caller (TM-163). Idempotent. Self-attests the age
     * the user supplied (TM-162): {@code ageVerified} flips to {@code true} only once an age is on
     * record. Returns the updated profile so the client sees the new lifecycle state.
     */
    @PostMapping("/me/onboarding-complete")
    MeResponse completeOnboarding(@AuthenticationPrincipal VerifiedUser caller) {
        return toResponse(userService.completeOnboarding(caller));
    }

    /**
     * Complete the first-login profile gate (TM-250): atomically persist the three required minimum
     * fields — name (→ display name), location (→ city), age — and mark onboarding complete, in a
     * single transaction. All three are required ({@link OnboardingRequest} bean validation): a
     * missing/blank field or an out-of-range age is a uniform {@code 400}, so a new user can't slip
     * into the app with an empty profile. Returns the updated profile carrying
     * {@code onboardingCompleted = true} so the client can drop the gate and proceed.
     */
    @PostMapping("/me/onboarding")
    MeResponse onboarding(
            @AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid OnboardingRequest request) {
        return toResponse(
                userService.completeProfileOnboarding(caller, request.name(), request.location(), request.age()));
    }

    /**
     * Record the caller's acceptance of a terms version (TM-163). The server stamps {@code now()} as
     * the acceptance time. Returns the updated profile carrying the accepted version + timestamp.
     */
    @PostMapping("/me/accept-terms")
    MeResponse acceptTerms(
            @AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid AcceptTermsRequest request) {
        return toResponse(userService.acceptTerms(caller, request.version()));
    }

    /**
     * Build the response for the mutation endpoints (PATCH / onboarding / accept-terms), which return
     * the persisted profile without paying for an extra live Firebase round trip: the Firebase-owned
     * {@code accountState} degrades to {@link AccountState#unknown()} (clients re-read it from
     * {@code GET /me}). {@code lastActiveAt} reflects whatever is on the row.
     */
    private MeResponse toResponse(User user) {
        return toResponse(user, AccountState.unknown());
    }

    private MeResponse toResponse(User user, AccountState accountState) {
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
                user.getRole().name(),
                user.isOnboardingCompleted(),
                user.getTermsAcceptedVersion(),
                user.getTermsAcceptedAt(),
                termsProperties.currentVersion(),
                user.isAgeVerified(),
                accountState,
                user.getLastActiveAt());
    }
}
