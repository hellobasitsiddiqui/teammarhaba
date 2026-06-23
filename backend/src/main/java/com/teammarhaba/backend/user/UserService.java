package com.teammarhaba.backend.user;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
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

    public UserService(UserRepository users, AuditService audit) {
        this.users = users;
        this.audit = audit;
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

    /** Find the caller's account, creating (or reactivating) it on first sight. Concurrency-safe. */
    @Transactional
    public User provision(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseGet(() -> reactivateOrInsert(caller));
    }

    /**
     * Apply a partial profile update for the caller (TM-162; generalises the TM-112 display-name
     * update). Provision-then-update so a PATCH before any GET still works; a {@code null} field
     * leaves its column unchanged. An empty update is a no-op (no write, no audit row).
     *
     * <p>The IANA {@code timezone} is validated best-effort here — only when provided — against the
     * runtime zone set; an unknown zone is a {@code 400} rather than a silently stored bad value.
     * The other fields are validated declaratively on the request DTO.
     */
    @Transactional
    public User updateProfile(VerifiedUser caller, ProfileUpdate update) {
        validateTimezone(update.timezone());
        User user = provision(caller);
        if (!update.isEmpty()) {
            user.applyProfile(update); // dirty-checking flushes on commit
            audit.record(
                    caller.uid(),
                    AuditAction.PROFILE_UPDATED,
                    TARGET_USER,
                    caller.uid(),
                    Map.of("fields", String.join(",", changedFields(update))));
        }
        return user;
    }

    /** Best-effort IANA check: reject a provided zone that the JVM doesn't know (400). */
    private static void validateTimezone(String timezone) {
        if (timezone != null && !ZoneId.getAvailableZoneIds().contains(timezone)) {
            throw new BadRequestException("Unknown timezone: " + timezone);
        }
    }

    /** The names of the fields this update actually sets — recorded on the audit row. */
    private static List<String> changedFields(ProfileUpdate u) {
        List<String> fields = new ArrayList<>();
        if (u.displayName() != null) {
            fields.add("displayName");
        }
        if (u.firstName() != null) {
            fields.add("firstName");
        }
        if (u.lastName() != null) {
            fields.add("lastName");
        }
        if (u.city() != null) {
            fields.add("city");
        }
        if (u.age() != null) {
            fields.add("age");
        }
        if (u.phone() != null) {
            fields.add("phone");
        }
        if (u.notificationPref() != null) {
            fields.add("notificationPref");
        }
        if (u.timezone() != null) {
            fields.add("timezone");
        }
        if (u.locale() != null) {
            fields.add("locale");
        }
        return fields;
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

    /** No active row: reactivate a soft-deleted tombstone for this uid if one exists, else insert. */
    private User reactivateOrInsert(VerifiedUser caller) {
        return users.findAnyByFirebaseUid(caller.uid())
                .map(tombstone -> {
                    tombstone.restore(); // returning user — bring their account back, don't duplicate
                    audit.record(caller.uid(), AuditAction.ACCOUNT_REACTIVATED, TARGET_USER, caller.uid());
                    return tombstone;
                })
                .orElseGet(() -> insertOrGet(caller));
    }

    private User insertOrGet(VerifiedUser caller) {
        try {
            User created = users.saveAndFlush(new User(caller.uid(), caller.email(), null));
            audit.record(caller.uid(), AuditAction.ACCOUNT_PROVISIONED, TARGET_USER, caller.uid());
            return created;
        } catch (DataIntegrityViolationException race) {
            // A concurrent first-request won the insert (unique firebase_uid) — treat as found.
            // No audit row: the winning request already recorded ACCOUNT_PROVISIONED.
            return users.findByFirebaseUid(caller.uid())
                    .orElseThrow(() -> race); // genuinely absent ⇒ not the race we expected
        }
    }
}
