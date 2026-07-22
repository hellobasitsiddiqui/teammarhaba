package com.teammarhaba.backend.interests;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin-side interest-catalogue management (TM-774, epic Interests): create, list (incl. retired),
 * edit, retire/restore, and the interests min/max-selection config — the service behind
 * {@code /api/v1/admin/interests}. Authorization ({@code hasRole('ADMIN')}) is enforced at the
 * controller; this service owns the domain rules. It closely mirrors {@code VenueAdminService} (a
 * library aggregate with soft-retire and no lifecycle-push seam), with two deliberate divergences
 * called out below.
 *
 * <ul>
 *   <li><b>Audited</b> — every mutation appends a house audit row ({@link AuditService}, TM-113) in the
 *       same transaction, so an action and its trail commit or roll back together.</li>
 *   <li><b>Retire ≠ delete</b> — retiring stamps {@code deleted_at} + {@code active=false}
 *       ({@link InterestCatalogue#markDeleted}) and KEEPS the row, so any {@code UserInterest} snapshot
 *       that copied it is untouched (the TM-773 snapshot invariant). Idempotent; a repeat retire does
 *       not re-audit. Restore is the mirror.</li>
 *   <li><b>No-op edit is silent</b> — a PATCH that changes nothing is a clean no-op: no audit, no
 *       {@code updatedAt} bump (matches venues).</li>
 *   <li><b>Active-label uniqueness</b> — a label must be unique among ACTIVE (non-tombstoned) rows.
 *       Enforced by an explicit pre-check (clean 409 message) backed by the DB partial-unique index
 *       {@code uq_interest_catalogue_label_active} (belt-and-braces: a {@code DataIntegrityViolation}
 *       also maps to 409). Re-checked on create, rename, AND restore (a same-label active row may have
 *       been created while this one was retired).</li>
 * </ul>
 *
 * <p><b>Divergence 1 — restriction-bypassing reads.</b> The entity's {@code @SQLRestriction} hides
 * tombstoned rows from every normal query, but the admin console must SEE retired rows and RESTORE
 * them. So the list / get / retire / restore paths use the repository's native, restriction-bypassing
 * queries ({@code adminSearch}, {@code findByIdIncludingRetired}) — the crux of the feature.
 *
 * <p><b>Divergence 2 — no {@code users.provision}.</b> Unlike venues (which store a {@code createdBy}
 * FK), {@code interest_catalogue} has no creator column and the audit log keys on the caller's Firebase
 * uid, so there is no need to JIT-provision a {@code users} row on create — this service does not depend
 * on {@code UserService}.
 *
 * <p>Lives in the {@code interests} package so it can call the package-private
 * {@link InterestCatalogue#markDeleted}/{@link InterestCatalogue#restore} mutators (they are NOT
 * widened to public).
 */
@Service
public class InterestAdminService {

    /** Audit {@code target_type} for interest rows (mirrors {@code VenueAdminService.TARGET_VENUE}). */
    static final String TARGET_INTEREST = "Interest";

    /** Sort weight a freshly-created highlighted interest defaults to (matches the V45 seed's 100). */
    private static final int HIGHLIGHTED_DEFAULT_WEIGHT = 100;

    private final InterestCatalogueRepository catalogue;
    private final AuditService audit;
    private final EntityManager entityManager;
    private final InterestSelectionConfig selectionConfig;
    private final UserInterestRepository userInterests;
    private final UserRepository users;

    public InterestAdminService(
            InterestCatalogueRepository catalogue,
            AuditService audit,
            EntityManager entityManager,
            InterestSelectionConfig selectionConfig,
            UserInterestRepository userInterests,
            UserRepository users) {
        this.catalogue = catalogue;
        this.audit = audit;
        this.entityManager = entityManager;
        this.selectionConfig = selectionConfig;
        this.userInterests = userInterests;
        this.users = users;
    }

    // --- Catalogue CRUD ---

    /**
     * The admin listing: the FULL catalogue including retired rows, filtered by an optional
     * case-insensitive label substring ({@code q}), an optional exact {@code category}, and an optional
     * tri-state {@code active} flag ({@code null} = all incl. retired). Uses the native,
     * restriction-bypassing {@code adminSearch}. {@code pageable}'s sort must already be expressed in DB
     * column names (the controller maps the public property names to columns for the native query).
     */
    @Transactional(readOnly = true)
    public Page<InterestCatalogue> list(String query, String category, Boolean active, Pageable pageable) {
        String q = (query == null || query.isBlank()) ? null : query.trim();
        String cat = (category == null || category.isBlank()) ? null : category.trim();
        return catalogue.adminSearch(q, cat, active, pageable);
    }

    /** One interest by id, INCLUDING a retired one (edit-form load); 404 if absent (no existence leak). */
    @Transactional(readOnly = true)
    public InterestCatalogue get(long id) {
        return loadIncludingRetired(id);
    }

    /**
     * Create an {@code active} interest. Enforces active-label uniqueness (409 on collision), defaults
     * the sort weight (explicit value if given, else 100 when highlighted / 0 otherwise — the V45
     * convention), re-reads the DB-authoritative {@code created_at}, and audits
     * {@link AuditAction#INTEREST_CREATED}.
     */
    @Transactional
    public InterestCatalogue create(VerifiedUser caller, InterestDraft draft) {
        ensureLabelFree(draft.label(), null);

        int weight = draft.sortWeight() != null
                ? draft.sortWeight()
                : (draft.highlighted() ? HIGHLIGHTED_DEFAULT_WEIGHT : 0);

        InterestCatalogue interest = new InterestCatalogue(
                draft.label(), draft.category(), draft.highlighted(), weight, Instant.now());
        // Optional emoji (TM-805): a blank/whitespace glyph is stored as null (a clean "no emoji"),
        // matching how the client treats a null/blank emoji as "no glyph".
        interest.setEmoji(normaliseEmoji(draft.emoji()));

        InterestCatalogue saved = catalogue.saveAndFlush(interest);
        // created_at is DB-authoritative (DEFAULT now(), insertable = false): re-read it so the 201 body
        // carries the real timestamp instead of null (same as VenueAdminService.create).
        entityManager.refresh(saved);

        audit.record(
                caller.uid(),
                AuditAction.INTEREST_CREATED,
                TARGET_INTEREST,
                String.valueOf(saved.getId()),
                Map.of("label", saved.getLabel(), "category", saved.getCategory()));
        return saved;
    }

    /**
     * Partial edit: apply the patch's non-{@code null}, actually-changed fields (loading a retired row
     * too), audit {@link AuditAction#INTEREST_UPDATED} with the changed field names. A rename re-checks
     * active-label uniqueness against the NEW label (excluding this row) → 409 on collision. A patch that
     * changes nothing is a clean no-op (no audit, no {@code updatedAt} bump).
     */
    @Transactional
    public InterestCatalogue update(VerifiedUser caller, long id, InterestPatch patch) {
        InterestCatalogue interest = loadIncludingRetired(id);

        List<String> changed = new ArrayList<>();

        if (patch.label() != null && !patch.label().equals(interest.getLabel())) {
            ensureLabelFree(patch.label(), interest.getId());
            interest.setLabel(patch.label());
            changed.add("label");
        }
        if (patch.category() != null && !patch.category().equals(interest.getCategory())) {
            interest.setCategory(patch.category());
            changed.add("category");
        }
        // Emoji (TM-805): a present emoji is normalised (blank → null) then applied if it actually
        // changes. null in the patch means "leave unchanged" (house PATCH convention).
        if (patch.emoji() != null) {
            String next = normaliseEmoji(patch.emoji());
            if (!java.util.Objects.equals(next, interest.getEmoji())) {
                interest.setEmoji(next);
                changed.add("emoji");
            }
        }
        if (patch.highlighted() != null && patch.highlighted() != interest.isHighlighted()) {
            interest.setHighlighted(patch.highlighted());
            changed.add("highlighted");
        }
        if (patch.sortWeight() != null && patch.sortWeight() != interest.getSortWeight()) {
            interest.setSortWeight(patch.sortWeight());
            changed.add("sortWeight");
        }

        if (changed.isEmpty()) {
            return interest; // nothing actually changed: no touch, no audit
        }
        interest.touch(Instant.now()); // dirty-checking flushes on commit

        audit.record(
                caller.uid(),
                AuditAction.INTEREST_UPDATED,
                TARGET_INTEREST,
                String.valueOf(interest.getId()),
                Map.of("fields", List.copyOf(changed)));
        return interest;
    }

    /**
     * Retire (soft-delete) the interest, KEEPING the row: stamps {@code deleted_at} + {@code active=false}
     * ({@link InterestCatalogue#markDeleted}). Idempotent — retiring an already-retired interest returns
     * it unchanged and does NOT re-audit. Never hard-deletes, so any user snapshot referencing it
     * survives (the TM-773 invariant). Audits {@link AuditAction#INTEREST_RETIRED} on the actual
     * transition.
     */
    @Transactional
    public InterestCatalogue retire(VerifiedUser caller, long id) {
        InterestCatalogue interest = loadIncludingRetired(id);
        if (interest.isDeleted()) {
            return interest; // already retired — idempotent no-op
        }
        interest.markDeleted(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.INTEREST_RETIRED,
                TARGET_INTEREST,
                String.valueOf(interest.getId()),
                Map.of("label", interest.getLabel()));
        return interest;
    }

    /**
     * Restore a retired interest ({@link InterestCatalogue#restore}: clears {@code deleted_at}, sets
     * {@code active=true}). Idempotent mirror of {@link #retire} — restoring an already-active interest
     * is a no-op that does not re-audit. Re-checks active-label uniqueness first: another active row may
     * have taken this label while it was retired → 409 on collision. Audits
     * {@link AuditAction#INTEREST_RESTORED} on the actual transition.
     */
    @Transactional
    public InterestCatalogue restore(VerifiedUser caller, long id) {
        InterestCatalogue interest = loadIncludingRetired(id);
        if (!interest.isDeleted()) {
            return interest; // already active — idempotent no-op
        }
        // A same-label active row may have been created while this was retired — restoring would collide
        // with the partial-unique index. Check against the CURRENT active set, excluding this row.
        ensureLabelFree(interest.getLabel(), interest.getId());
        interest.restore(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.INTEREST_RESTORED,
                TARGET_INTEREST,
                String.valueOf(interest.getId()),
                Map.of("label", interest.getLabel()));
        return interest;
    }

    // --- Interests selection config (min/max) ---

    /** The current interests min/max-selection bounds (reads via {@link InterestSelectionConfig}). */
    @Transactional(readOnly = true)
    public InterestConfig getConfig() {
        return new InterestConfig(selectionConfig.minSelections(), selectionConfig.maxSelections());
    }

    /**
     * Set both interests min/max-selection bounds (TM-774) and audit
     * {@link AuditAction#INTERESTS_CONFIG_UPDATED}. The range invariant ({@code min >= 1},
     * {@code max >= min}) is validated at the request edge; it is re-asserted here defensively (→ 400
     * {@link BadRequestException}) so a bad call through a non-HTTP path can't persist an inverted range.
     * Returns the read-back persisted values.
     */
    @Transactional
    public InterestConfig setConfig(VerifiedUser caller, int min, int max) {
        if (min < 1) {
            throw new BadRequestException("minSelections must be at least 1.");
        }
        if (max < min) {
            throw new BadRequestException("maxSelections must be greater than or equal to minSelections.");
        }
        selectionConfig.setMinSelections(min);
        selectionConfig.setMaxSelections(max);
        audit.record(
                caller.uid(),
                AuditAction.INTERESTS_CONFIG_UPDATED,
                TARGET_INTEREST,
                "config",
                Map.of("min", min, "max", max));
        return new InterestConfig(selectionConfig.minSelections(), selectionConfig.maxSelections());
    }

    // --- Per-interest selection analytics (TM-832) ---

    /**
     * Per-LABEL selection analytics for the admin console's "Selected by" column (TM-832): for every
     * label anyone has selected, how many users picked it ({@code selectorCount}) and what whole-number
     * percentage of the ACTIVE user base that is. SCOPE: count + percent only — the gender split is
     * deferred (TM-955).
     *
     * <p>Exactly TWO aggregate reads, never an N+1: one {@code COUNT(*) GROUP BY label} over the whole
     * snapshot log ({@link UserInterestRepository#selectionCountsByLabel()}) and one active-user count
     * ({@link UserRepository#countActiveUsers()}) — the shared percentage denominator. Because the count
     * is keyed on the free-text snapshot label (TM-773), a selection of a since-renamed or since-retired
     * interest is still tallied under the label it was picked as, so a retired catalogue interest keeps
     * its historical count. A label nobody selected is simply absent from the result (the client renders
     * it as {@code 0 (0%)}).
     *
     * <p>Percent is 0-guarded: with no active users the denominator is 0, so every percent is 0 rather
     * than a divide-by-zero. Otherwise {@code percent = round(100 * selectorCount / activeUsers)}.
     */
    @Transactional(readOnly = true)
    public SelectionStats selectionStats() {
        long activeUsers = users.countActiveUsers();
        List<UserInterestRepository.LabelCount> counts = userInterests.selectionCountsByLabel();
        List<LabelSelectionStat> stats = counts.stream()
                .map(c -> new LabelSelectionStat(c.getLabel(), c.getCount(), percentOf(c.getCount(), activeUsers)))
                .toList();
        return new SelectionStats(activeUsers, stats);
    }

    /**
     * A count as a whole-number percentage of {@code activeUsers}, rounded half-up, 0-guarded: a zero (or
     * negative — defensive) denominator yields 0 rather than dividing by zero. Kept package-visible for a
     * direct unit test of the divide-by-zero + rounding contract.
     */
    public static int percentOf(long selectorCount, long activeUsers) {
        if (activeUsers <= 0) {
            return 0;
        }
        return (int) Math.round(100.0 * selectorCount / activeUsers);
    }

    // --- helpers ---

    /** Load an interest by id including a tombstoned one (the admin paths); 404 if truly absent. */
    private InterestCatalogue loadIncludingRetired(long id) {
        return catalogue.findByIdIncludingRetired(id).orElseThrow(InterestAdminService::notFound);
    }

    /**
     * Guard the active-label-uniqueness invariant: throw a 409 {@link ConflictException} if an ACTIVE
     * (non-tombstoned) row other than {@code excludeId} already holds {@code label}. Pass
     * {@code excludeId = null} for a create (nothing to exclude) or the row's own id for a rename/restore.
     */
    private void ensureLabelFree(String label, Long excludeId) {
        if (catalogue.countActiveByLabelExcludingId(label, excludeId) > 0) {
            throw new ConflictException("An active interest with that label already exists.");
        }
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("Interest not found.");
    }

    /**
     * Normalise an admin-supplied emoji for storage (TM-805): trim it, and treat a blank/whitespace-only
     * value as {@code null} — a clean "no emoji" — so the column never holds an empty string (which the
     * client renders identically to null anyway). A {@code null} input passes straight through.
     */
    private static String normaliseEmoji(String emoji) {
        if (emoji == null) {
            return null;
        }
        String trimmed = emoji.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** The two interests-selection bounds, returned by {@link #getConfig()} / {@link #setConfig}. */
    public record InterestConfig(int minSelections, int maxSelections) {}

    /**
     * The per-interest selection analytics (TM-832) returned by {@link #selectionStats()}: the active-user
     * denominator plus one {@link LabelSelectionStat} per selected label. Count + percent only (the gender
     * split is deferred, TM-955).
     */
    public record SelectionStats(long activeUsers, List<LabelSelectionStat> stats) {}

    /** One label's selection tally: the label, its selector count, and that count as a 0–100 percent. */
    public record LabelSelectionStat(String label, long selectorCount, int percent) {}
}
