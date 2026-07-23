package com.teammarhaba.backend.user;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedPhoneService;
import com.teammarhaba.backend.auth.VerifiedPhoneUnavailableException;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.config.PhoneVerificationProperties;
import com.teammarhaba.backend.interests.InterestCatalogue;
import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.InterestSelectionConfig;
import com.teammarhaba.backend.interests.UserInterest;
import com.teammarhaba.backend.interests.UserInterestRepository;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.NameLockedException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
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

    /**
     * The interim allowed city list (TM-877) — the profile city is picked from a fixed dropdown.
     * Mirrors {@code CITY_OPTIONS} in {@code web/src/assets/profile-core.js}; the admin-managed
     * version of this list is TM-878. A NEW city value must come from this set, but a caller
     * re-sending their ALREADY-SAVED off-list city is accepted (see {@link #updateProfile} and —
     * since TM-898 — the onboarding gate {@link #completeProfileOnboarding}, which enforces the
     * same rule), so profiles saved before the list existed (e.g. "Dubai") are preserved, never
     * invalidated.
     */
    private static final Set<String> ALLOWED_CITIES = Set.of("London", "Milton Keynes", "Sharjah", "Karachi");

    /**
     * The platform age band, 18–99 (TM-884). For {@code PATCH /me} it is enforced HERE — behind the
     * unchanged-value guard in {@link #updateProfile} (TM-900) — not by bean validation on
     * {@code UpdateMeRequest}: the boundary would reject an unchanged grandfathered age (a 13–120-era
     * value) before the service's no-op check could wave it through, locking those accounts out of
     * saving anything. {@code OnboardingRequest} keeps its hard {@code @Min/@Max} band — every gate
     * submission (re)writes the age, so there is no unchanged case there.
     */
    private static final int MIN_AGE = 18;

    private static final int MAX_AGE = 99;

    /**
     * The stored-phone E.164 shape (TM-781/TM-880): mandatory {@code +}, 7–15 digits, separators
     * only between digits — the same rule {@code UpdateMeRequest.phone} enforces at the boundary
     * (minus the empty-string clear alternative). Used to refuse an onboarding-complete transition
     * for an account with no valid phone on record (TM-880), which also catches legacy
     * country-ambiguous bare numbers saved before TM-781.
     */
    private static final java.util.regex.Pattern E164_PHONE =
            java.util.regex.Pattern.compile("^\\+[0-9](?:[ ()./-]*[0-9]){6,14}$");

    /**
     * The stable, gate-keyable refusal message (TM-931) when verified-phone enforcement is on and the
     * caller has no Firebase-verified phone (or it can't be read — fail closed). Distinct from the
     * TM-880 stored-shape message so the gate UI (TM-930) can tell "verify your number" from "a phone
     * is required".
     */
    static final String PHONE_NOT_VERIFIED_MESSAGE = "Phone number must be verified before completing onboarding";

    private final UserRepository users;
    private final AuditService audit;
    private final UserProvisioner provisioner;
    private final SubscriptionRepository subscriptions;
    private final UserInterestRepository userInterests;
    private final InterestCatalogueRepository catalogue;
    private final InterestSelectionConfig interestBounds;
    private final PhoneVerificationProperties phoneVerification;
    private final VerifiedPhoneService verifiedPhoneService;
    private final NameLockPredicate nameLock;

    public UserService(
            UserRepository users,
            AuditService audit,
            UserProvisioner provisioner,
            SubscriptionRepository subscriptions,
            UserInterestRepository userInterests,
            InterestCatalogueRepository catalogue,
            InterestSelectionConfig interestBounds,
            PhoneVerificationProperties phoneVerification,
            VerifiedPhoneService verifiedPhoneService,
            NameLockPredicate nameLock) {
        this.users = users;
        this.audit = audit;
        this.provisioner = provisioner;
        this.subscriptions = subscriptions;
        this.userInterests = userInterests;
        this.catalogue = catalogue;
        this.interestBounds = interestBounds;
        this.phoneVerification = phoneVerification;
        this.verifiedPhoneService = verifiedPhoneService;
        this.nameLock = nameLock;
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
     * Load an account by surrogate id <em>including soft-deleted rows</em> (TM-623) — the lifecycle
     * check for money-moving background paths. The renewal engine calls this BEFORE any provider call:
     * a tombstoned account's card must never be charged, and the restricted {@link #getById} can't tell
     * "soft-deleted" from "never existed" (it throws for both — previously AFTER the charge had already
     * gone out, rolling back the ledger and retrying the charge every tick). Callers check
     * {@link User#isDeleted()} and choose the terminal, charge-free path for tombstoned accounts.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<User> findAnyById(Long userId) {
        return users.findAnyById(userId);
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
        // TM-907: the SELF edit path enforces the name lock (enforceNameLock = true) — a user with
        // event history can't CHANGE an already-set first/last/display name (setting a blank one is
        // still allowed, the carve-out). The admin path passes false (admin correction is exempt).
        List<Map<String, Object>> changes = applyProfileFields(user, update, true);

        // TM-982: phone is a VERIFIED IDENTITY. When the caller CHANGES their phone via PATCH /me, the
        // stored number must be the Firebase-VERIFIED one — so gate the write behind the SAME
        // app.phone.require-verified flag as the onboarding paths (TM-931), and only when the phone
        // actually changed (a name/city/notification-only PATCH must never touch Firebase). Activates
        // when TM-986 flips the flag in prod; a no-op while the flag is off (byte-for-byte the
        // pre-TM-982 baseline). enforceVerifiedPhoneIfRequired reads the caller's verified E.164 and
        // mirrors it onto users.phone (the verified value winning over the client one, or refusing with
        // the distinct PHONE_NOT_VERIFIED_MESSAGE 400 when none is on record) — so a changed-but-
        // unverified number is rejected/corrected server-side, matching the client's TM-982 save-block.
        boolean phoneChanged = changes.stream().anyMatch(c -> "phone".equals(c.get("field")));
        if (phoneChanged) {
            // enforceVerifiedPhoneIfRequired mirrors the verified number onto users.phone and audits
            // that mirror as its OWN separate PROFILE_UPDATED diff (clientValue→verifiedValue) when it
            // actually changes the value — the exact same shape as the onboarding paths — so the trail
            // stays consistent without reconciling the client-side diff below.
            enforceVerifiedPhoneIfRequired(caller, user);
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

    /**
     * Admin edit of ANOTHER user's admin-editable profile fields (TM-172). The admin console reaches
     * this via {@code PATCH /api/v1/admin/users/{id}/profile}; authorization (ADMIN-only) is enforced
     * at the web layer ({@code @PreAuthorize}), and this service owns the rules — which are
     * <strong>identical</strong> to the self-edit path because both share {@link #applyProfileFields}:
     * the same city allow-list (TM-877), age band (TM-884), E.164 phone shape, name-like check
     * (TM-771), and timezone/locale resolution. Identity (uid/email), role and enabled are NOT
     * touched here — those stay governed by the TM-111 admin endpoints ({@link UserAdminService}).
     *
     * <ul>
     *   <li><b>404, not 403, for a missing target</b> — an unknown (or soft-deleted) id is a
     *       {@link ResourceNotFoundException}, so the API never reveals whether an id exists (the same
     *       no-existence-leak rule the TM-111 endpoints follow).</li>
     *   <li><b>Audited as an admin action</b> — every effective edit appends one immutable
     *       {@link AuditAction#ADMIN_USER_PROFILE_EDITED} row in this transaction, carrying the actor
     *       (the admin), the target (the edited user), {@code source=admin}, and the field-level diff;
     *       a no-op edit (every field already at its value) writes nothing.</li>
     * </ul>
     *
     * @param id        the target account's database id
     * @param update    the profile fields to apply (partial: a {@code null} field is left unchanged)
     * @param callerUid the acting admin's Firebase uid (the audit actor)
     * @return the updated account
     */
    @Transactional
    public User adminUpdateProfile(long id, ProfileUpdate update, String callerUid) {
        User user = users.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User not found."));
        // TM-907: the admin correction path is EXEMPT from the name lock (enforceNameLock = false) —
        // an admin must still be able to correct a locked user's name (typo / legal change). It stays
        // audited as ADMIN_USER_PROFILE_EDITED below, so the correction leaves a trail.
        List<Map<String, Object>> changes = applyProfileFields(user, update, false);

        if (!changes.isEmpty()) {
            // Audited as an ADMIN action (TM-172), distinct from the user's own PROFILE_UPDATED so the
            // log tells an admin edit apart from a self-edit. The metadata's source=admin + actor/target
            // uids record WHO edited WHOSE profile and exactly what changed (same diff shape as TM-185).
            audit.record(
                    callerUid,
                    AuditAction.ADMIN_USER_PROFILE_EDITED,
                    TARGET_USER,
                    user.getFirebaseUid(),
                    profileChangeMetadata(callerUid, user.getFirebaseUid(), "admin", changes));
        }
        return user;
    }

    /**
     * Apply the partial profile {@code update} onto {@code user} in place, returning the field-level
     * change list (old→new diffs) for auditing. This is the <strong>single shared</strong> field
     * application + validation path (TM-172): both {@link #updateProfile} (self-edit) and
     * {@link #adminUpdateProfile} (admin-edit) call it, so the admin edit can never drift to a looser
     * copy of the rules — the city allow-list (TM-877), age band (TM-884), E.164 phone, name-like
     * check (TM-771 — via {@code UpdateMeRequest} bean validation at the boundary) and timezone/locale
     * resolution all run here identically for both callers. Each {@code null} field is left unchanged;
     * only fields that actually differ from the stored value are written and returned as changes.
     */
    private List<Map<String, Object>> applyProfileFields(
            User user, ProfileUpdate update, boolean enforceNameLock) {
        List<Map<String, Object>> changes = new ArrayList<>();

        // TM-907 name lock: on the self path (enforceNameLock), a user with event history can't CHANGE
        // an already-SET first/last/display name — but SETTING a currently-empty one is still allowed
        // (the carve-out: mirrors onboarding's "first/last seed only when unset", and keeps a locked
        // EMPTY name a fixable profile-strength gap). The lock is resolved lazily and ONCE per call,
        // only if a name field would actually change, so a no-name PATCH pays nothing for the check.
        boolean locked = enforceNameLock
                && namedFieldWouldChange(user, update)
                && nameLock.isNameLocked(user);

        if (update.displayName() != null && !Objects.equals(user.getDisplayName(), update.displayName())) {
            guardNameChange(locked, user.getDisplayName());
            changes.add(change("displayName", user.getDisplayName(), update.displayName()));
            user.setDisplayName(update.displayName());
        }
        if (update.firstName() != null && !Objects.equals(user.getFirstName(), update.firstName())) {
            guardNameChange(locked, user.getFirstName());
            changes.add(change("firstName", user.getFirstName(), update.firstName()));
            user.setFirstName(update.firstName());
        }
        if (update.lastName() != null && !Objects.equals(user.getLastName(), update.lastName())) {
            guardNameChange(locked, user.getLastName());
            changes.add(change("lastName", user.getLastName(), update.lastName()));
            user.setLastName(update.lastName());
        }
        if (update.city() != null) {
            // TM-900: trim BEFORE the equality/allow-list checks. The client's fillCitySelect trims
            // the saved value before re-selecting it, so a legacy row stored with padding
            // (" Dubai ") comes back from a full-form save as "Dubai" — untrimmed comparison would
            // read that as a NEW off-list value and 400 the whole save. New values are stored
            // trimmed for the same reason (a padded "  London  " is the list value "London").
            String city = update.city().trim();
            if (!Objects.equals(trimmedOrNull(user.getCity()), city)) {
                // TM-877: a NEW city must come from the allowed dropdown list. Reached only when the
                // value actually differs from the stored one, so re-sending an already-saved
                // off-list city ("Dubai") is a no-op above and stays preserved; "" keeps its clear
                // semantics.
                if (!city.isEmpty() && !ALLOWED_CITIES.contains(city)) {
                    throw new BadRequestException("Choose a city from the list");
                }
                changes.add(change("city", user.getCity(), city));
                user.setCity(city);
            }
        }
        if (update.age() != null && !Objects.equals(user.getAge(), update.age())) {
            // TM-900: the 18–99 band (TM-884) is enforced here, BEHIND the unchanged-guard above
            // (mirroring the city pattern), so an API client re-sending an unchanged grandfathered
            // age is a no-op rather than a 400 — only a NEW age value must be in-band. (The web
            // client omits an unchanged age from the PATCH; this makes the server behave the same
            // for clients that don't.)
            if (update.age() < MIN_AGE || update.age() > MAX_AGE) {
                throw new BadRequestException("Age must be between " + MIN_AGE + " and " + MAX_AGE);
            }
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
        // Interests (TM-775): full-set replace. A null list = field omitted = leave saved interests
        // untouched (partial-PATCH, like every field above). A non-null list (including empty) is the
        // user's complete new set: validate every label against the *active* catalogue, enforce the
        // configured min/max, then delete-and-reinsert the snapshots. Category is resolved from the
        // catalogue at save time, preserving TM-773's free-text snapshot invariant — source_interest_id
        // stays a soft pointer, never a hard FK. Runs inside this @Transactional, so a 400 rolls back.
        if (update.interests() != null) {
            replaceInterests(user, update.interests(), changes);
        }

        return changes;
    }

    /**
     * Whether {@code update} would actually change any of the three name fields (TM-907) — a supplied,
     * non-null value that differs from what is stored. Used to decide whether to resolve the (possibly
     * DB-touching) name-lock predicate at all: a PATCH that touches no name never pays for the check,
     * and one that re-sends a name unchanged is a no-op that must never be refused.
     */
    private static boolean namedFieldWouldChange(User user, ProfileUpdate update) {
        return (update.displayName() != null && !Objects.equals(user.getDisplayName(), update.displayName()))
                || (update.firstName() != null && !Objects.equals(user.getFirstName(), update.firstName()))
                || (update.lastName() != null && !Objects.equals(user.getLastName(), update.lastName()));
    }

    /**
     * Whether {@code user}'s name is locked by their event history (TM-907) — the read the
     * {@code GET/PATCH /me} response ({@code MeResponse.nameLocked}) carries so the web renders the
     * name fields read-only PRE-EMPTIVELY (not save-then-error). Delegates to the derived-live
     * {@link NameLockPredicate}; exposed here so {@code MeController} keeps routing all user state
     * through this service rather than injecting the predicate directly.
     */
    @Transactional(readOnly = true)
    public boolean isNameLocked(User user) {
        return nameLock.isNameLocked(user);
    }

    /**
     * The TM-907 carve-out gate for one name field: refuse the write only when the account is
     * {@code locked} AND the field already holds a non-blank value ({@code current}). Setting a
     * currently-EMPTY name (null/blank) is always allowed — a locked user who attended with only a
     * displayName can still fill in their first/last once, exactly like onboarding's seed-when-unset
     * rule, so the lock never traps an empty name behind an unfixable profile-strength gap. A genuine
     * change of a set value throws {@link NameLockedException} (422, distinct problem type).
     */
    private static void guardNameChange(boolean locked, String current) {
        if (locked && current != null && !current.isBlank()) {
            throw new NameLockedException();
        }
    }

    /**
     * The caller's saved interest snapshots (TM-775), owner-scoped — the read path backing the
     * {@code interests} field on {@code GET}/{@code PATCH /api/v1/me}. Exposed here (rather than
     * injecting the interests repo into the controller) so {@code MeController} keeps delegating all
     * user state to this service.
     */
    @Transactional(readOnly = true)
    public List<UserInterest> interestsFor(User user) {
        return userInterests.findByUserId(user.getId());
    }

    /**
     * Replace the caller's saved interests with the submitted label set (TM-775; full-set replace).
     *
     * <p>Pipeline: de-duplicate the labels (exact match, first-seen order) → enforce the DB-backed
     * min/max from {@link InterestSelectionConfig} (default 1–3) → validate every label is a
     * <em>current active</em> catalogue label (unknown/retired → {@code 400}) → delete the user's
     * existing snapshots and insert the new set, copying {@code label}/{@code category} by value from
     * the resolved catalogue row and setting {@code sourceInterestId} to its id (never client-supplied).
     * All of this runs inside {@link #updateProfile}'s {@code @Transactional}, so the replace is atomic
     * and any {@code 400} rolls back with no partial write.
     */
    private void replaceInterests(User user, List<String> requested, List<Map<String, Object>> changes) {
        // De-duplicate by exact label, first-seen order preserved (a client double-sending a label
        // must not inflate the count against min/max or create two identical rows).
        List<String> wanted = new ArrayList<>(new LinkedHashSet<>(requested));

        // Enforce the DB-backed selection bounds at save time (bean validation can't read these).
        int min = interestBounds.minSelections();
        int max = interestBounds.maxSelections();
        if (wanted.size() < min) {
            throw new BadRequestException("Select at least " + min + " interest" + (min == 1 ? "" : "s"));
        }
        if (wanted.size() > max) {
            throw new BadRequestException("Select at most " + max + " interest" + (max == 1 ? "" : "s"));
        }

        // Catalogue-only validation: every submitted label must resolve to a current active catalogue
        // row (one WHERE label IN (…) read). A label absent from the result is unknown or retired.
        Map<String, InterestCatalogue> byLabel = new LinkedHashMap<>();
        if (!wanted.isEmpty()) {
            for (InterestCatalogue c : catalogue.findByActiveTrueAndLabelIn(wanted)) {
                byLabel.put(c.getLabel(), c);
            }
            List<String> unknown =
                    wanted.stream().filter(label -> !byLabel.containsKey(label)).toList();
            if (!unknown.isEmpty()) {
                throw new BadRequestException("Unknown or retired interest(s): " + String.join(", ", unknown));
            }
        }

        // Change detection as SETS, not order-sensitive lists (TM-874). findByUserId returns rows in an
        // unspecified order, so an order-sensitive List.equals would treat a same-set re-save as a change
        // and churn a delete-and-reinsert (fresh ids/created_at) plus a spurious PROFILE_UPDATED diff on
        // every no-op save. The user's interests are a SET (already de-duplicated above), so compare by
        // set membership: an unchanged set skips both the rewrite and the audit entry.
        List<UserInterest> existing = userInterests.findByUserId(user.getId());
        List<String> before = existing.stream().map(UserInterest::getLabel).toList();
        if (new HashSet<>(before).equals(new HashSet<>(wanted))) {
            return; // true no-op: same interests (any order) → no delete/reinsert, no audit diff.
        }

        // Full-set replace: clear the user's existing snapshots, then insert the resolved new set.
        userInterests.deleteAll(existing);
        for (String label : wanted) {
            InterestCatalogue c = byLabel.get(label);
            // Copy label + category by value; the source id is a soft provenance pointer (TM-773).
            userInterests.save(new UserInterest(user.getId(), c.getLabel(), c.getCategory(), c.getId()));
        }

        // Audit the change as one field diff (old set → new set) — reached only when the set changed,
        // consistent with the no-op-edit discipline of the rest of updateProfile.
        changes.add(change("interests", String.join(", ", before), String.join(", ", wanted)));
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
     *
     * <p>Phone is mandatory (TM-880): the transition is refused with a {@code 400} unless a valid
     * E.164 phone is already on record, so the onboarding-complete state can't be reached without
     * one via this endpoint either — the API can't bypass the completion gate. (The atomic gate
     * {@link #completeProfileOnboarding} collects the phone in the same request instead.)
     */
    @Transactional
    public User completeOnboarding(VerifiedUser caller) {
        User user = provision(caller);
        // TM-931: when enforcement is on, the caller's Firebase-verified phone is read and mirrored
        // onto users.phone BEFORE the TM-880 stored-shape check, so the mirrored (always-E.164)
        // verified number is what requirePhoneOnRecord then validates, and a phone-less/unverified
        // account is refused with the distinct verified-phone message rather than the TM-880 one.
        enforceVerifiedPhoneIfRequired(caller, user);
        requirePhoneOnRecord(user);
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
     * Complete the first-use "profile gate" in one atomic transaction (TM-250, extended in TM-880):
     * persist the four required minimum fields (name → {@code displayName}, location → {@code city},
     * age, phone) <em>and</em> mark onboarding complete, so a user can't enter the app with an empty
     * shell or without a phone.
     *
     * <p>Unlike {@link #updateProfile} (partial PATCH), this is all-or-nothing: all four values are
     * required by the {@code OnboardingRequest} bean validation at the web boundary (name/location
     * name-like TM-771/TM-898; age 18–99 TM-884; phone E.164 TM-880); here we additionally reject
     * blank/whitespace-only text values (a {@code @Size(min=1)} lets a single space through) and
     * enforce the TM-877 allowed-city list on {@code location} with the same saved-value allowance
     * as {@code PATCH /me} (TM-898). The whole thing runs in one {@code @Transactional} unit, so
     * the profile write and the onboarding-flag flip commit together or not at all — the gate never
     * half-applies.
     *
     * <p>Reuses the existing onboarding-complete machinery (TM-163): completing onboarding here also
     * self-attests the supplied age ({@code ageVerified = true}), since an age is always on record by
     * construction. Idempotent on the flag, but the profile fields are always (re)written from the
     * request, so re-submitting overwrites with the latest values.
     *
     * <p>TM-883: the captured name also seeds {@code firstName}/{@code lastName} (first word →
     * first name, remainder → last name) — previously onboarding only ever wrote
     * {@code displayName}, so first/last name stayed {@code null} forever unless the user found the
     * edit form, and the profile identity header had nothing but fallbacks to show. The split only
     * runs when BOTH parts are still unset: an explicit first/last name (edited via
     * {@code PATCH /me}) is a user's own correction and must never be overwritten by this heuristic
     * on a re-submit.
     */
    @Transactional
    public User completeProfileOnboarding(
            VerifiedUser caller, String name, String location, Integer age, String phone) {
        User user = provision(caller);

        String fullName = requireText(name, "name");
        // TM-907: the onboarding re-submit is a SELF write, so it enforces the name lock too. A locked
        // user re-submitting the gate can't CHANGE an already-set displayName (a genuine rename), but a
        // locked user whose displayName is still blank may set it (the carve-out) — and the first/last
        // seed below only ever runs when BOTH are unset, so it is carve-out-safe by construction. The
        // predicate is resolved once, only when the displayName would actually change.
        if (!Objects.equals(user.getDisplayName(), fullName) && nameLock.isNameLocked(user)) {
            guardNameChange(true, user.getDisplayName());
        }
        user.setDisplayName(fullName);
        boolean seedNames = user.getFirstName() == null && user.getLastName() == null;
        if (seedNames) {
            // Whitespace-split, limit 2: "Ibn Battuta" → ("Ibn", "Battuta"), "Mary Jane Watson" →
            // ("Mary", "Jane Watson"), a single word → first name only (lastName stays null).
            // The parts are name-like by construction (TM-898): OnboardingRequest.name carries the
            // TM-771 NAME_LIKE pattern at the boundary, so a non-name-like name (the V47 backfill's
            // skip case) can never reach this seed — it 400s before the transaction starts.
            String[] parts = fullName.split("\\s+", 2);
            user.setFirstName(parts[0]);
            user.setLastName(parts.length > 1 ? parts[1] : null);
        }
        String city = requireText(location, "location");
        // TM-898: the gate enforces the TM-877 allowed-city list exactly as updateProfile does,
        // INCLUDING the saved-value allowance — an account whose stored city is off-list (saved
        // before the list existed) may pass back through the gate re-submitting that same value
        // (the gate dropdown keeps it selectable), but any NEW off-list value is refused. The
        // stored side is trimmed for the comparison (TM-900) so a legacy padded value still matches
        // its trimmed re-submission.
        if (!Objects.equals(trimmedOrNull(user.getCity()), city) && !ALLOWED_CITIES.contains(city)) {
            throw new BadRequestException("Choose a city from the list");
        }
        user.setCity(city);
        user.setAge(age); // range already enforced (18–99) by bean validation at the boundary
        user.setPhone(requireText(phone, "phone")); // E.164 shape already enforced at the boundary
        // TM-931: when enforcement is on, the Firebase-verified phone wins over the client-supplied
        // one just set above — read it and mirror it onto users.phone (refusing if it can't be
        // established). A phone-less/unverified caller is refused with the distinct verified message.
        enforceVerifiedPhoneIfRequired(caller, user);

        boolean wasComplete = user.isOnboardingCompleted();
        user.completeOnboarding();
        user.setAgeVerified(true); // an age is always on record here (required field) — self-attested

        // The gate is a profile fill plus an onboarding completion; record both for a complete trail
        // (the fields list names first/last name only when the TM-883 seed actually wrote them).
        audit.record(
                caller.uid(),
                AuditAction.PROFILE_UPDATED,
                TARGET_USER,
                caller.uid(),
                Map.of(
                        "fields",
                        seedNames
                                ? "displayName,firstName,lastName,city,age,phone"
                                : "displayName,city,age,phone",
                        "via",
                        "onboarding"));
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
     * The stored value's side of a trimmed comparison (TM-900): {@code null} stays {@code null},
     * anything else is trimmed — so a legacy padded stored city (" Dubai ") compares equal to the
     * trimmed value clients send back (fillCitySelect trims before re-selecting).
     */
    private static String trimmedOrNull(String value) {
        return value == null ? null : value.trim();
    }

    /**
     * TM-880: refuse the onboarding-complete transition unless a valid E.164 phone is on record.
     * Catches "no phone at all" AND a legacy country-ambiguous bare number (pre-TM-781) — the same
     * two states the client's completion gate routes back through {@code #/onboarding} for.
     */
    private static void requirePhoneOnRecord(User user) {
        String phone = user.getPhone();
        if (phone == null || !E164_PHONE.matcher(phone).matches()) {
            throw new BadRequestException("A phone number is required to complete onboarding");
        }
    }

    /**
     * TM-931 (subticket B of TM-923): server-side verified-phone enforcement, flag-gated by
     * {@code app.phone.require-verified} (default off). A no-op when the flag is off — Firebase is
     * never touched, so flag-off behaviour is byte-for-byte the pre-TM-931 baseline (the TM-880
     * {@link #requirePhoneOnRecord} rule alone).
     *
     * <p>Called from the two onboarding-complete transitions ({@link #completeOnboarding},
     * {@link #completeProfileOnboarding}) AND — since TM-982 — from {@link #updateProfile} when a
     * PATCH /me actually CHANGES the phone (phone is a verified identity, so an edited number must be
     * the Firebase-verified one too, not just at onboarding). The PATCH caller gates on the phone
     * having changed so an unrelated edit never pays for a Firebase read.
     *
     * <p>When the flag is on: read the caller's Firebase-verified E.164 phone (fail-closed — a
     * missing bean / absent user / SDK error / null phone all refuse), then <strong>mirror it onto
     * {@code users.phone}</strong>, the verified value winning over any client-supplied one. A
     * refusal surfaces as the distinct, stable {@link #PHONE_NOT_VERIFIED_MESSAGE} {@code 400} the
     * gate UI (TM-930) keys on. The mirror is audited only when it actually changes the stored value.
     */
    private void enforceVerifiedPhoneIfRequired(VerifiedUser caller, User user) {
        if (!phoneVerification.requireVerified()) {
            return; // flag off — no Firebase call, pre-TM-931 behaviour preserved.
        }
        String verifiedPhone;
        try {
            verifiedPhone = verifiedPhoneService.requireVerifiedPhone(caller.uid());
        } catch (VerifiedPhoneUnavailableException ex) {
            // Fail closed: no verified phone (or an unreadable identity provider) refuses the
            // transition with the distinct message; the cause is already logged by the service.
            throw new BadRequestException(PHONE_NOT_VERIFIED_MESSAGE);
        }
        // Mirror the verified E.164 onto users.phone — it always fits VARCHAR(32) and always wins over
        // the client value. Audit only a real change (mirroring the no-op-edit discipline elsewhere).
        String previous = user.getPhone();
        if (!Objects.equals(previous, verifiedPhone)) {
            user.setPhone(verifiedPhone);
            audit.record(
                    caller.uid(),
                    AuditAction.PROFILE_UPDATED,
                    TARGET_USER,
                    caller.uid(),
                    profileChangeMetadata(
                            caller.uid(),
                            caller.uid(),
                            "self",
                            List.of(change("phone", previous, verifiedPhone))));
        }
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

    /**
     * Soft-delete an active account: it is then hidden from normal queries but recoverable.
     *
     * <p>Any recurring subscription lapses in the same transaction (TM-623): tombstoning only the
     * account previously left the subscription live — its {@code nextChargeAt} kept the renewal engine
     * charging the deleted account's saved card every cycle (V38's {@code ON DELETE CASCADE} only fires
     * on a hard delete). Lapsing here stops all future charges and clears the "due" pointer, so the
     * scheduler never even scans the row again. Restoring the account does NOT resurrect the
     * subscription — the user re-subscribes if they want it back (a fresh SCA-authenticated mandate).
     */
    @Transactional
    public User softDelete(String firebaseUid) {
        User user = users.findByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No active account for uid " + firebaseUid));
        Instant now = Instant.now();
        user.markDeleted(now); // dirty-checking flushes on commit
        subscriptions
                .findByUserId(user.getId())
                .filter(sub -> sub.isRenewing() || sub.getNextChargeAt() != null)
                .ifPresent(sub -> sub.lapse(now)); // stop renewals + unschedule; flushes on commit
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
        DataIntegrityViolationException integrityFailure = null;
        try {
            provisioner.createOrReactivate(caller);
        } catch (DataIntegrityViolationException race) {
            // Expected when a concurrent first-request won the unique-firebase_uid insert: its
            // REQUIRES_NEW transaction committed the row and rolled back ours cleanly, so the re-read
            // below finds the winner's row. Keep the exception so that if the re-read instead finds
            // nothing — meaning this was NOT the benign race but some other integrity violation — we
            // can chain it as the cause rather than losing why provisioning actually failed.
            integrityFailure = race;
        }
        final DataIntegrityViolationException cause = integrityFailure;
        return users.findByFirebaseUid(caller.uid())
                .orElseThrow(() -> new IllegalStateException(
                        "provision: users row still absent after create for uid " + caller.uid(), cause));
    }
}
