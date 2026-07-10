package com.teammarhaba.backend.user;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Account lifecycle for the verified caller (TM-112).
 *
 * <p>Accounts are provisioned <strong>just-in-time</strong>: the first authenticated request from
 * a Firebase UID inserts the {@code users} row; later requests reuse it. Identity ({@code uid},
 * {@code email}) is always taken from the verified token — never from client input — so the
 * caller can't claim to be someone else. {@code displayName} starts empty and is the one field
 * the user can edit via {@code PATCH /api/v1/me}.
 *
 * <p>Soft-delete (TM-114): {@link #softDelete} tombstones an account and {@link #restore} brings it
 * back. Because {@code firebase_uid} stays globally unique, a returning user whose account was
 * soft-deleted is <em>reactivated</em> on next sign-in by {@link #provision} rather than duplicated.
 */
@Service
public class UserService {

    /** Audit {@code target_type} for account events. */
    private static final String TARGET_USER = "User";

    /** Properties the admin users list may be sorted on (allow-listed — see {@link PageRequests}). */
    private static final Set<String> SORTABLE = Set.of("id", "email", "displayName", "role", "enabled");

    /** Stable default ordering when the caller requests none. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.ASC, "id");

    private final UserRepository users;
    private final AuditService audit;
    private final UserProvisioner provisioner;

    public UserService(UserRepository users, AuditService audit, UserProvisioner provisioner) {
        this.users = users;
        this.audit = audit;
        this.provisioner = provisioner;
    }

    /**
     * Paged, filtered listing of accounts for the admin users console (TM-115) — the first adopter
     * of the {@link PageResponse} list convention. Filters are optional ({@code null} disables a
     * clause); {@code size} is capped and {@code sort} is allow-listed by {@link PageRequests}.
     */
    @Transactional(readOnly = true)
    public PageResponse<UserSummary> list(
            String q, Role role, Boolean enabled, Integer page, Integer size, String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        String trimmed = (q == null || q.isBlank()) ? null : q.trim();
        return PageResponse.from(users.search(trimmed, role, enabled, pageable), UserSummary::from);
    }

    /**
     * Find the caller's account, creating (or reactivating) it on first sight (TM-112). Safe to call
     * from a read-only transaction and under a concurrent first-request burst (TM-597).
     *
     * <p>The common path is a plain read — harmless in any caller transaction, read-only included. Only
     * when no active row exists do we fall through to {@link #createOrReactivate}, which does the write
     * in its own writable {@code REQUIRES_NEW} transaction (via {@link UserProvisioner}) and re-reads
     * the result into <em>this</em> transaction, so the entity handed back is managed here and later
     * dirty-check updates (e.g. {@link #provisionAndTouch}'s {@code last_active_at}) still flush.
     */
    @Transactional
    public User provision(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseGet(() -> createOrReactivate(caller));
    }

    /**
     * Take a {@code SELECT ... FOR UPDATE} row lock on the caller's {@code users} row — the per-user
     * serialisation point behind "one active event at a time" (TM-413/TM-423).
     *
     * <p>Each capacity command locks only its own {@code events} row, so two concurrent GOING-landings
     * by the same user on <em>different</em> events lock different rows and never mutually exclude:
     * both pass the non-locking active-event guard and the user ends up GOING to two events. Locking
     * the user row first makes those commands queue — the second waits, then sees the first's committed
     * GOING and is refused. Callers take this <strong>before</strong> the event lock, giving a
     * consistent user-then-event lock order (deadlock-free). {@link Propagation#MANDATORY} enforces the
     * only correct usage: inside the command's own transaction (without one the lock would be released
     * immediately and serialise nothing).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void lockForUpdate(Long userId) {
        users.findByIdForUpdate(userId);
    }

    /**
     * Load an existing account by its surrogate id (TM-478). Used by the payment-webhook confirm path,
     * which knows the buyer only by the {@code user_id} stored on the order (the caller is the payment
     * provider, not a signed-in user, so there is no {@link VerifiedUser} to {@link #provision}). The
     * account was already provisioned at checkout time, so a missing row is an invariant breach and fails
     * loudly rather than silently skipping the RSVP.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public User getById(Long userId) {
        return users.findById(userId)
                .orElseThrow(() -> new IllegalStateException("No user for id " + userId));
    }

    /**
     * Provision the caller (as {@link #provision}) and stamp {@code last_active_at = now()} (TM-164).
     * This backs {@code GET /api/v1/me}: every authenticated read advances our own "last active"
     * marker — the one piece of account state we own (Firebase reports last <em>login</em>, not last
     * activity against our API). A cheap single-column dirty update flushed on commit; the Firebase-
     * owned state block is read separately and never persisted.
     */
    @Transactional
    public User provisionAndTouch(VerifiedUser caller) {
        User user = provision(caller);
        user.markActive(Instant.now()); // dirty-checking flushes on commit
        return user;
    }

    /**
     * Apply a partial profile update for the caller (TM-162; generalised from the display-name-only
     * TM-112 path). Provision-then-update, so a PATCH before any GET still works. Each {@code null}
     * field is left unchanged; only the fields actually supplied are written and audited.
     *
     * <p>Identity ({@code uid}/{@code email}) is taken from the verified token and is never settable
     * here. Syntactic validation (sizes, age range, phone pattern, enum) happens at the web boundary;
     * {@code timezone} (IANA id) and {@code locale} (BCP-47 tag) get a best-effort semantic check
     * here, rejecting an unresolvable value with a {@code 400}.
     */
    @Transactional
    public User updateProfile(VerifiedUser caller, ProfileUpdate update) {
        User user = provision(caller);
        List<Map<String, Object>> changes = new ArrayList<>();

        if (update.displayName() != null && !Objects.equals(user.getDisplayName(), update.displayName())) {
            changes.add(change("displayName", user.getDisplayName(), update.displayName()));
            user.setDisplayName(update.displayName());
        }
        if (update.firstName() != null && !Objects.equals(user.getFirstName(), update.firstName())) {
            changes.add(change("firstName", user.getFirstName(), update.firstName()));
            user.setFirstName(update.firstName());
        }
        if (update.lastName() != null && !Objects.equals(user.getLastName(), update.lastName())) {
            changes.add(change("lastName", user.getLastName(), update.lastName()));
            user.setLastName(update.lastName());
        }
        if (update.city() != null && !Objects.equals(user.getCity(), update.city())) {
            changes.add(change("city", user.getCity(), update.city()));
            user.setCity(update.city());
        }
        if (update.age() != null && !Objects.equals(user.getAge(), update.age())) {
            changes.add(change("age", user.getAge(), update.age()));
            user.setAge(update.age());
        }
        if (update.phone() != null && !Objects.equals(user.getPhone(), update.phone())) {
            changes.add(change("phone", user.getPhone(), update.phone()));
            user.setPhone(update.phone());
        }
        if (update.notificationPref() != null && user.getNotificationPref() != update.notificationPref()) {
            changes.add(change(
                    "notificationPref",
                    user.getNotificationPref() == null ? null : user.getNotificationPref().name(),
                    update.notificationPref().name()));
            user.setNotificationPref(update.notificationPref());
        }
        if (update.timezone() != null) {
            String tz = validTimezone(update.timezone());
            if (!Objects.equals(user.getTimezone(), tz)) {
                changes.add(change("timezone", user.getTimezone(), tz));
                user.setTimezone(tz);
            }
        }
        if (update.locale() != null) {
            String loc = validLocale(update.locale());
            if (!Objects.equals(user.getLocale(), loc)) {
                changes.add(change("locale", user.getLocale(), loc));
                user.setLocale(loc);
            }
        }
        // Paper appearance prefs (TM-529). Both are partial-update like the rest: a null leaves the
        // stored value unchanged. The accent swatch id is already constrained to the curated palette
        // by the web boundary (@Pattern), so only a known-good, paper-legible swatch reaches here.
        if (update.themeAccent() != null && !Objects.equals(user.getThemeAccent(), update.themeAccent())) {
            changes.add(change("themeAccent", user.getThemeAccent(), update.themeAccent()));
            user.setThemeAccent(update.themeAccent());
        }
        if (update.themeSketchy() != null && user.isThemeSketchy() != update.themeSketchy()) {
            changes.add(change("themeSketchy", user.isThemeSketchy(), update.themeSketchy()));
            user.setThemeSketchy(update.themeSketchy());
        }

        if (!changes.isEmpty()) {
            // Per-field change history (TM-185): the PROFILE_UPDATED audit row carries the actor, the
            // target, the source (self vs admin), and the old→new diff in its JSONB metadata. Only
            // actual changes are recorded — a PATCH that sets a field to its current value is a no-op.
            // Dirty-checking flushes the entity on commit.
            audit.record(
                    caller.uid(),
                    AuditAction.PROFILE_UPDATED,
                    TARGET_USER,
                    caller.uid(),
                    profileChangeMetadata(caller.uid(), caller.uid(), "self", changes));
        }
        return user;
    }

    /** A single field diff entry for the profile-change history (TM-185). Null-tolerant (old may be null). */
    private static Map<String, Object> change(String field, Object oldValue, Object newValue) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("field", field);
        entry.put("old", oldValue);
        entry.put("new", newValue);
        return entry;
    }

    /** The PROFILE_UPDATED audit metadata shape (TM-185): who, whom, how, and the field-level diff. */
    private static Map<String, Object> profileChangeMetadata(
            String actorUid, String targetUid, String source, List<Map<String, Object>> changes) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("actorUid", actorUid);
        metadata.put("targetUid", targetUid);
        metadata.put("source", source);
        metadata.put("changes", changes);
        return metadata;
    }

    /**
     * Mark first-run onboarding complete for the caller (TM-163). Provision-then-update, so the
     * transition works even before any GET. Idempotent: completing an already-completed account is a
     * no-op for the flag, and only an actual flip is audited.
     *
     * <p>Age attestation is tied to the TM-162 {@code age} field: completing onboarding self-attests
     * the age the user supplied, so {@code age_verified} is set true here <em>only once an age is on
     * record</em>. Real ID verification is out of scope for this ticket.
     */
    @Transactional
    public User completeOnboarding(VerifiedUser caller) {
        User user = provision(caller);
        boolean wasComplete = user.isOnboardingCompleted();
        boolean ageWasVerified = user.isAgeVerified();

        user.completeOnboarding();
        // Self-attested age check (TM-163): only meaningful once the user has supplied an age (TM-162).
        if (user.getAge() != null) {
            user.setAgeVerified(true);
        }

        if (!wasComplete || user.isAgeVerified() != ageWasVerified) {
            audit.record(
                    caller.uid(),
                    AuditAction.ONBOARDING_COMPLETED,
                    TARGET_USER,
                    caller.uid(),
                    Map.of("ageVerified", String.valueOf(user.isAgeVerified())));
        }
        return user;
    }

    /**
     * Complete the first-login "profile gate" in one atomic transaction (TM-250): persist the three
     * required minimum fields (name → {@code displayName}, location → {@code city}, age) <em>and</em>
     * mark onboarding complete, so a new passwordless user can't enter the app with an empty shell.
     *
     * <p>Unlike {@link #updateProfile} (partial PATCH), this is all-or-nothing: all three values are
     * required by the {@code OnboardingRequest} bean validation at the web boundary; here we
     * additionally reject blank/whitespace-only name and location (a {@code @Size(min=1)} lets a
     * single space through). The whole thing runs in one {@code @Transactional} unit, so the profile
     * write and the onboarding-flag flip commit together or not at all — the gate never half-applies.
     *
     * <p>Reuses the existing onboarding-complete machinery (TM-163): completing onboarding here also
     * self-attests the supplied age ({@code ageVerified = true}), since an age is always on record by
     * construction. Idempotent on the flag, but the profile fields are always (re)written from the
     * request, so re-submitting overwrites with the latest values.
     */
    @Transactional
    public User completeProfileOnboarding(VerifiedUser caller, String name, String location, Integer age) {
        User user = provision(caller);

        user.setDisplayName(requireText(name, "name"));
        user.setCity(requireText(location, "location"));
        user.setAge(age); // range already enforced (13–120) by bean validation at the boundary

        boolean wasComplete = user.isOnboardingCompleted();
        user.completeOnboarding();
        user.setAgeVerified(true); // an age is always on record here (required field) — self-attested

        // The gate is a profile fill plus an onboarding completion; record both for a complete trail.
        audit.record(
                caller.uid(),
                AuditAction.PROFILE_UPDATED,
                TARGET_USER,
                caller.uid(),
                Map.of("fields", "displayName,city,age", "via", "onboarding"));
        if (!wasComplete) {
            audit.record(
                    caller.uid(),
                    AuditAction.ONBOARDING_COMPLETED,
                    TARGET_USER,
                    caller.uid(),
                    Map.of("ageVerified", "true"));
        }
        return user;
    }

    /** Required free-text field: reject {@code null}/blank (a single space passes {@code @Size(min=1)}). */
    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new BadRequestException(field + " is required");
        }
        return value.trim();
    }

    /**
     * Record the caller's acceptance of a terms {@code version} at {@code now()} (TM-163).
     * Provision-then-update. Re-accepting (e.g. a new version) overwrites the stored version and
     * timestamp and is audited each time.
     */
    @Transactional
    public User acceptTerms(VerifiedUser caller, String version) {
        User user = provision(caller);
        user.acceptTerms(version, Instant.now()); // dirty-checking flushes on commit
        audit.record(
                caller.uid(),
                AuditAction.TERMS_ACCEPTED,
                TARGET_USER,
                caller.uid(),
                Map.of("version", version));
        return user;
    }

    /** Best-effort IANA timezone check: the value must resolve to a known {@link ZoneId}. */
    private static String validTimezone(String timezone) {
        try {
            return ZoneId.of(timezone).getId();
        } catch (DateTimeException ex) {
            throw new BadRequestException("Unknown timezone: " + timezone);
        }
    }

    /**
     * Best-effort BCP-47 locale check: the tag must parse and name a language. Java's lenient parser
     * accepts a blank/garbage tag without complaint, so we additionally require a non-empty language.
     */
    private static String validLocale(String locale) {
        Locale parsed = Locale.forLanguageTag(locale);
        if (parsed.getLanguage().isEmpty()) {
            throw new BadRequestException("Unknown locale: " + locale);
        }
        return locale;
    }

    /**
     * Mirror an assigned role onto the persisted row (TM-140). The Firebase custom claim is the
     * authorization source of truth (TM-110); keeping {@code users.role} in step is what makes
     * {@code GET /api/v1/me} reflect the role. Called by {@link com.teammarhaba.backend.auth.RoleService}
     * on every assignment. A no-op when no active account exists yet for the uid — the row is created
     * lazily on first sign-in (the claim still applies; the row syncs on the next assignment).
     */
    @Transactional
    public void syncRole(String firebaseUid, Role role) {
        users.findByFirebaseUid(firebaseUid).ifPresent(user -> user.setRole(role));
    }

    /** Soft-delete an active account: it is then hidden from normal queries but recoverable. */
    @Transactional
    public User softDelete(String firebaseUid) {
        User user = users.findByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No active account for uid " + firebaseUid));
        user.markDeleted(Instant.now()); // dirty-checking flushes on commit
        audit.record(firebaseUid, AuditAction.ACCOUNT_SOFT_DELETED, TARGET_USER, firebaseUid);
        return user;
    }

    /** Restore a soft-deleted account. Idempotent: a no-op if the account is already active. */
    @Transactional
    public User restore(String firebaseUid) {
        User user = users.findAnyByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No account for uid " + firebaseUid));
        boolean wasDeleted = user.isDeleted();
        user.restore();
        if (wasDeleted) { // only an actual restore is auditable; an already-active no-op isn't
            audit.record(firebaseUid, AuditAction.ACCOUNT_RESTORED, TARGET_USER, firebaseUid);
        }
        return user;
    }

    /**
     * No active row: create (or reactivate) it, then re-read into this transaction (TM-597).
     *
     * <p>The write is delegated to {@link UserProvisioner#createOrReactivate} — a separate bean so the
     * {@code REQUIRES_NEW} advice actually fires (a self-invocation would skip the proxy) — which runs
     * it in a fresh <em>writable</em> transaction. That both lets provisioning work when the caller's
     * transaction is read-only and means a losing first-request race rolls back only that inner
     * transaction, never this one.
     *
     * <p>Two callers can race here: both see no row, both enter the writable path, one INSERT wins and
     * the other throws {@link DataIntegrityViolationException} (unique {@code firebase_uid}). We swallow
     * that and re-read — the winner's row is committed and visible — so both callers return the same
     * single row and neither errors. The re-read (rather than returning the inner transaction's entity)
     * also re-attaches the row to this transaction's persistence context, keeping the returned entity
     * managed for the caller's subsequent updates.
     */
    private User createOrReactivate(VerifiedUser caller) {
        try {
            provisioner.createOrReactivate(caller);
        } catch (DataIntegrityViolationException race) {
            // A concurrent first-request won the unique-firebase_uid insert; its REQUIRES_NEW
            // transaction committed the row and rolled back ours cleanly. Fall through and re-read it.
        }
        return users.findByFirebaseUid(caller.uid())
                .orElseThrow(() -> new IllegalStateException(
                        "provision: users row still absent after create for uid " + caller.uid()));
    }
}
