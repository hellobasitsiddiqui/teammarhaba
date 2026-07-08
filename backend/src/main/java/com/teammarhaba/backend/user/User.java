package com.teammarhaba.backend.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import org.hibernate.annotations.SQLRestriction;

/**
 * A TeamMarhaba account, keyed by the Firebase UID from the verified ID token (TM-79).
 *
 * <p>Schema is owned by Flyway ({@code V2__create_users}, {@code V3__users_soft_delete_and_version},
 * {@code V5__users_profile_fields}, {@code V6__users_lifecycle_fields}); Hibernate runs validate-only,
 * so this mapping must match the table exactly. The user-editable profile fields (names, city, age,
 * phone, notification preference, timezone, locale) are added by TM-162 and edited via
 * {@code PATCH /api/v1/me}. The account-lifecycle flags (onboarding completed, terms accepted
 * version + timestamp, self-attested age verified) are added by TM-163 and driven by the
 * {@code POST /api/v1/me/onboarding-complete} and {@code POST /api/v1/me/accept-terms} transitions.
 *
 * <p>Two cross-cutting data conventions land here first (TM-114), to be reused by later entities:
 *
 * <ul>
 *   <li><b>Soft-delete</b> — {@code deletedAt} (NULL = active). Deleting an account
 *       {@linkplain #markDeleted tombstones} the row rather than removing it, so it stays
 *       recoverable ({@link UserService#restore}) and its history survives. The
 *       {@code @SQLRestriction} excludes tombstoned rows from every normal query, so callers get
 *       "active only" by default; the restore path reads through it with a native query. This is
 *       the <em>deletion</em> path and is distinct from the {@code enabled} flag, which suspends an
 *       active account without hiding it.
 *   <li><b>Optimistic concurrency</b> — {@code @Version}. Concurrent edits to the same row fail the
 *       second writer with a {@code 409} (via {@code GlobalExceptionHandler}) instead of silently
 *       overwriting the first.
 * </ul>
 *
 * <p>Accounts are provisioned just-in-time on first login (TM-112) and {@code role} is mirrored
 * from the Firebase custom claim (TM-110).
 */
@Entity
@Table(name = "users")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "firebase_uid", nullable = false, unique = true, updatable = false)
    private String firebaseUid;

    @Column(name = "email")
    private String email;

    @Column(name = "display_name")
    private String displayName;

    @Column(name = "first_name")
    private String firstName;

    @Column(name = "last_name")
    private String lastName;

    @Column(name = "city")
    private String city;

    @Column(name = "age")
    private Integer age;

    @Column(name = "phone")
    private String phone;

    /**
     * Delivery preference. New accounts default to {@link NotificationPref#BOTH} (email + push) so a
     * fresh account can receive push as soon as a device token registers, rather than silently missing
     * pushes because it defaulted to email-only (TM-427). Hibernate writes this field on insert, so the
     * Java default — not the DB column default — is what every provisioned account gets; the DB default
     * is kept in step by {@code V19__default_notification_pref_both}. Existing rows are untouched.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "notification_pref", nullable = false)
    private NotificationPref notificationPref = NotificationPref.BOTH;

    @Column(name = "timezone")
    private String timezone;

    @Column(name = "locale")
    private String locale;

    /**
     * The chosen Paper accent swatch (TM-529). The multi-theme system is retired — Paper is the only
     * theme, and its accent is re-tinted per user by picking one of a small curated palette
     * ({@code teal|indigo|coral|amber|plum|ink}). Stored as the swatch id (not a hex), validated at
     * the web boundary against that fixed set, so it can only ever be a known-good, paper-legible
     * swatch. New accounts default to {@code teal} — the existing Paper {@code --accent} (TM-510) —
     * which is the first/selected swatch; the DB column default is kept in step by
     * {@code V20__users_theme_preferences}.
     */
    @Column(name = "theme_accent", nullable = false)
    private String themeAccent = "teal";

    /**
     * Whether the hand-drawn "wavy/sketchy" wobble is on (TM-529). {@code true} = the hand-drawn
     * wobble style, {@code false} = clean Paper. Product decision: a brand-new account defaults to
     * sketchy <strong>on</strong> (the app's character; clean Paper is the opt-out). Hibernate writes
     * this on insert, so the Java default is what every provisioned account gets; the DB default is
     * kept in step by {@code V20__users_theme_preferences}.
     */
    @Column(name = "theme_sketchy", nullable = false)
    private boolean themeSketchy = true;

    @Column(name = "onboarding_completed", nullable = false)
    private boolean onboardingCompleted = false;

    @Column(name = "terms_accepted_version")
    private String termsAcceptedVersion;

    @Column(name = "terms_accepted_at")
    private Instant termsAcceptedAt;

    @Column(name = "age_verified", nullable = false)
    private boolean ageVerified = false;

    /**
     * When this account last made an authenticated {@code GET /api/v1/me} (TM-164). This is the one
     * piece of account state we own: Firebase can report last <em>login</em>, but not last activity
     * against our API. {@code null} until the first authenticated call; stamped cheaply on every one.
     */
    @Column(name = "last_active_at")
    private Instant lastActiveAt;

    /**
     * Running tally of the account's late event cancellations (TM-414) — un-RSVPs made inside an
     * event's cancellation window (default 24h before start; see {@code CancellationPolicy}). A
     * lightweight strike counter, not a points ledger: it only ever moves up, one per late cancel,
     * and carries no enforced consequence yet. The full reliability economy (ledger, thresholds,
     * downgrade, on-time credit) is TM-409, which is designed to wrap this same counter.
     */
    @Column(name = "late_cancel_count", nullable = false)
    private int lateCancelCount = 0;

    @Enumerated(EnumType.STRING)
    @Column(name = "role", nullable = false)
    private Role role = Role.USER;

    @Column(name = "enabled", nullable = false)
    private boolean enabled = true;

    /** Soft-delete marker: {@code null} = active, non-null = tombstoned at that instant. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** Optimistic-lock counter; Hibernate bumps it on every update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected User() {
    }

    public User(String firebaseUid, String email, String displayName) {
        this.firebaseUid = firebaseUid;
        this.email = email;
        this.displayName = displayName;
    }

    public Long getId() {
        return id;
    }

    public String getFirebaseUid() {
        return firebaseUid;
    }

    public String getEmail() {
        return email;
    }

    public String getDisplayName() {
        return displayName;
    }

    /** Profile update (TM-112). Identity fields (uid/email) come from the token, not the client. */
    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public String getFirstName() {
        return firstName;
    }

    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    public Integer getAge() {
        return age;
    }

    public void setAge(Integer age) {
        this.age = age;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }

    public NotificationPref getNotificationPref() {
        return notificationPref;
    }

    public void setNotificationPref(NotificationPref notificationPref) {
        this.notificationPref = notificationPref;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public String getLocale() {
        return locale;
    }

    public void setLocale(String locale) {
        this.locale = locale;
    }

    /** The chosen Paper accent swatch id (TM-529); one of the curated palette ids. */
    public String getThemeAccent() {
        return themeAccent;
    }

    public void setThemeAccent(String themeAccent) {
        this.themeAccent = themeAccent;
    }

    /** Whether the hand-drawn wavy/sketchy wobble is on (TM-529). {@code true} for a new account. */
    public boolean isThemeSketchy() {
        return themeSketchy;
    }

    public void setThemeSketchy(boolean themeSketchy) {
        this.themeSketchy = themeSketchy;
    }

    public boolean isOnboardingCompleted() {
        return onboardingCompleted;
    }

    /** Mark first-run onboarding finished (TM-163). Idempotent. */
    public void completeOnboarding() {
        this.onboardingCompleted = true;
    }

    public String getTermsAcceptedVersion() {
        return termsAcceptedVersion;
    }

    public Instant getTermsAcceptedAt() {
        return termsAcceptedAt;
    }

    /** Record acceptance of a terms {@code version} at {@code when} (TM-163). */
    public void acceptTerms(String version, Instant when) {
        this.termsAcceptedVersion = version;
        this.termsAcceptedAt = when;
    }

    public boolean isAgeVerified() {
        return ageVerified;
    }

    /** Self-attested age check (TM-163). Real ID verification is out of scope. */
    public void setAgeVerified(boolean ageVerified) {
        this.ageVerified = ageVerified;
    }

    public Instant getLastActiveAt() {
        return lastActiveAt;
    }

    /** Stamp the "last active" marker (TM-164). Called on every authenticated {@code GET /me}. */
    public void markActive(Instant when) {
        this.lastActiveAt = when;
    }

    /** Running late-cancellation strike count (TM-414). {@code 0} for an account that has never late-cancelled. */
    public int getLateCancelCount() {
        return lateCancelCount;
    }

    /**
     * Record one late event cancellation (TM-414): bump the strike counter and return the new
     * running total (used for the honest "this is your Nth" pre-confirm copy). Called from the
     * un-RSVP path inside its transaction; dirty-checking flushes the change on commit. Increment
     * only — a late cancel is never undone here (no on-time credit / restoration: that is TM-409).
     */
    public int recordLateCancel() {
        return ++this.lateCancelCount;
    }

    public Role getRole() {
        return role;
    }

    /** Mirror the role onto the row (TM-111). The Firebase custom claim stays the auth source of truth. */
    void setRole(Role role) {
        this.role = role;
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** Suspend ({@code false}) or reinstate ({@code true}) an active account (TM-111 admin action). */
    void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this account has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }

    /** Soft-delete: tombstone the row so normal queries hide it. Package-private — go via the service. */
    void markDeleted(Instant when) {
        this.deletedAt = when;
    }

    /** Undo a soft-delete, making the account active again. Idempotent on an already-active row. */
    void restore() {
        this.deletedAt = null;
    }
}
