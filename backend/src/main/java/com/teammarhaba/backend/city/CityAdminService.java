package com.teammarhaba.backend.city;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin-side city-catalogue management (TM-1089): create, list (incl. retired), edit, retire/restore —
 * the service behind {@code /api/v1/admin/cities}. Authorization ({@code hasRole('ADMIN')}) is enforced
 * at the controller; this service owns the domain rules. It closely mirrors {@code InterestAdminService}.
 *
 * <ul>
 *   <li><b>Audited</b> — every mutation appends a house audit row ({@link AuditService}, TM-113) in the
 *       same transaction, so an action and its trail commit or roll back together.</li>
 *   <li><b>Retire ≠ delete</b> — retiring stamps {@code deleted_at} + {@code active=false}
 *       ({@link CityCatalogue#markDeleted}) and KEEPS the row, so any user/event that saved this city by
 *       name (a free-text copy, no FK) is untouched. Idempotent; a repeat retire does not re-audit.
 *       Restore is the mirror.</li>
 *   <li><b>No-op edit is silent</b> — a PATCH that changes nothing is a clean no-op: no audit, no
 *       {@code updatedAt} bump.</li>
 *   <li><b>Active-name uniqueness</b> — a name must be unique among ACTIVE (non-tombstoned) rows.
 *       Enforced by an explicit pre-check (clean 409) backed by the DB partial-unique index
 *       {@code uq_city_catalogue_name_active}. Re-checked on create, rename, AND restore.</li>
 * </ul>
 *
 * <p>Lives in the {@code city} package so it can call the package-private
 * {@link CityCatalogue#markDeleted}/{@link CityCatalogue#restore} mutators.
 */
@Service
public class CityAdminService {

    /** Audit {@code target_type} for city rows. */
    static final String TARGET_CITY = "City";

    private final CityCatalogueRepository catalogue;
    private final AuditService audit;
    private final EntityManager entityManager;

    public CityAdminService(CityCatalogueRepository catalogue, AuditService audit, EntityManager entityManager) {
        this.catalogue = catalogue;
        this.audit = audit;
        this.entityManager = entityManager;
    }

    // --- Catalogue CRUD ---

    /**
     * The admin listing: the FULL catalogue including retired rows, filtered by an optional
     * case-insensitive substring ({@code q}, matched against name OR country) and an optional tri-state
     * {@code active} flag ({@code null} = all incl. retired). Uses the native, restriction-bypassing
     * {@code adminSearch}. {@code pageable}'s sort must already be expressed in DB column names.
     */
    @Transactional(readOnly = true)
    public Page<CityCatalogue> list(String query, Boolean active, Pageable pageable) {
        String q = (query == null || query.isBlank()) ? null : query.trim();
        return catalogue.adminSearch(q, active, pageable);
    }

    /** One city by id, INCLUDING a retired one (edit-form load); 404 if absent (no existence leak). */
    @Transactional(readOnly = true)
    public CityCatalogue get(long id) {
        return loadIncludingRetired(id);
    }

    /**
     * Create an {@code active} city. Enforces active-name uniqueness (409 on collision), defaults the
     * sort weight to 0 when unset, re-reads the DB-authoritative {@code created_at}, and audits
     * {@link AuditAction#CITY_CREATED}.
     */
    @Transactional
    public CityCatalogue create(VerifiedUser caller, CityDraft draft) {
        ensureNameFree(draft.name(), null);

        int weight = draft.sortWeight() != null ? draft.sortWeight() : 0;

        CityCatalogue city = new CityCatalogue(draft.name(), draft.country(), weight, Instant.now());
        city.setIconEmoji(normaliseText(draft.iconEmoji()));
        city.setGeoLat(draft.geoLat());
        city.setGeoLng(draft.geoLng());
        city.setImagePath(normaliseText(draft.imagePath()));
        city.setIconImagePath(normaliseText(draft.iconImagePath()));

        CityCatalogue saved = catalogue.saveAndFlush(city);
        // created_at is DB-authoritative (DEFAULT now(), insertable = false): re-read it so the 201 body
        // carries the real timestamp instead of null (same as InterestAdminService.create).
        entityManager.refresh(saved);

        audit.record(
                caller.uid(),
                AuditAction.CITY_CREATED,
                TARGET_CITY,
                String.valueOf(saved.getId()),
                Map.of("name", saved.getName(), "country", saved.getCountry()));
        return saved;
    }

    /**
     * Partial edit: apply the patch's non-{@code null}, actually-changed fields (loading a retired row
     * too), audit {@link AuditAction#CITY_UPDATED} with the changed field names. A rename re-checks
     * active-name uniqueness against the NEW name (excluding this row) → 409 on collision. A patch that
     * changes nothing is a clean no-op (no audit, no {@code updatedAt} bump).
     */
    @Transactional
    public CityCatalogue update(VerifiedUser caller, long id, CityPatch patch) {
        CityCatalogue city = loadIncludingRetired(id);

        List<String> changed = new ArrayList<>();

        if (patch.name() != null && !patch.name().equals(city.getName())) {
            ensureNameFree(patch.name(), city.getId());
            city.setName(patch.name());
            changed.add("name");
        }
        if (patch.country() != null && !patch.country().equals(city.getCountry())) {
            city.setCountry(patch.country());
            changed.add("country");
        }
        // icon/image: a present value is normalised (blank → null) then applied if it actually changes.
        // null in the patch means "leave unchanged" (house PATCH convention).
        if (patch.iconEmoji() != null) {
            String next = normaliseText(patch.iconEmoji());
            if (!Objects.equals(next, city.getIconEmoji())) {
                city.setIconEmoji(next);
                changed.add("iconEmoji");
            }
        }
        if (patch.imagePath() != null) {
            String next = normaliseText(patch.imagePath());
            if (!Objects.equals(next, city.getImagePath())) {
                city.setImagePath(next);
                changed.add("imagePath");
            }
        }
        if (patch.iconImagePath() != null) {
            String next = normaliseText(patch.iconImagePath());
            if (!Objects.equals(next, city.getIconImagePath())) {
                city.setIconImagePath(next);
                changed.add("iconImagePath");
            }
        }
        if (patch.geoLat() != null && !Objects.equals(patch.geoLat(), city.getGeoLat())) {
            city.setGeoLat(patch.geoLat());
            changed.add("geoLat");
        }
        if (patch.geoLng() != null && !Objects.equals(patch.geoLng(), city.getGeoLng())) {
            city.setGeoLng(patch.geoLng());
            changed.add("geoLng");
        }
        if (patch.sortWeight() != null && patch.sortWeight() != city.getSortWeight()) {
            city.setSortWeight(patch.sortWeight());
            changed.add("sortWeight");
        }

        if (changed.isEmpty()) {
            return city; // nothing actually changed: no touch, no audit
        }
        city.touch(Instant.now()); // dirty-checking flushes on commit

        audit.record(
                caller.uid(),
                AuditAction.CITY_UPDATED,
                TARGET_CITY,
                String.valueOf(city.getId()),
                Map.of("fields", List.copyOf(changed)));
        return city;
    }

    /**
     * Retire (soft-delete) the city, KEEPING the row: stamps {@code deleted_at} + {@code active=false}
     * ({@link CityCatalogue#markDeleted}). Idempotent — retiring an already-retired city returns it
     * unchanged and does NOT re-audit. Never hard-deletes, so any user/event referencing it by name
     * survives. Audits {@link AuditAction#CITY_RETIRED} on the actual transition.
     */
    @Transactional
    public CityCatalogue retire(VerifiedUser caller, long id) {
        CityCatalogue city = loadIncludingRetired(id);
        if (city.isDeleted()) {
            return city; // already retired — idempotent no-op
        }
        city.markDeleted(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.CITY_RETIRED,
                TARGET_CITY,
                String.valueOf(city.getId()),
                Map.of("name", city.getName()));
        return city;
    }

    /**
     * Restore a retired city ({@link CityCatalogue#restore}). Idempotent mirror of {@link #retire}.
     * Re-checks active-name uniqueness first: another active row may have taken this name while it was
     * retired → 409 on collision. Audits {@link AuditAction#CITY_RESTORED} on the actual transition.
     */
    @Transactional
    public CityCatalogue restore(VerifiedUser caller, long id) {
        CityCatalogue city = loadIncludingRetired(id);
        if (!city.isDeleted()) {
            return city; // already active — idempotent no-op
        }
        ensureNameFree(city.getName(), city.getId());
        city.restore(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.CITY_RESTORED,
                TARGET_CITY,
                String.valueOf(city.getId()),
                Map.of("name", city.getName()));
        return city;
    }

    // --- helpers ---

    /** Load a city by id including a tombstoned one (the admin paths); 404 if truly absent. */
    private CityCatalogue loadIncludingRetired(long id) {
        return catalogue.findByIdIncludingRetired(id).orElseThrow(CityAdminService::notFound);
    }

    /**
     * Guard the active-name-uniqueness invariant: throw a 409 {@link ConflictException} if an ACTIVE
     * (non-tombstoned) row other than {@code excludeId} already holds {@code name}. Pass
     * {@code excludeId = null} for a create, or the row's own id for a rename/restore.
     */
    private void ensureNameFree(String name, Long excludeId) {
        if (catalogue.countActiveByNameExcludingId(name, excludeId) > 0) {
            throw new ConflictException("An active city with that name already exists.");
        }
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("City not found.");
    }

    /**
     * Normalise an admin-supplied optional text (icon glyph / image path) for storage: trim it, and
     * treat a blank/whitespace-only value as {@code null} — a clean "unset" — so the column never holds
     * an empty string. A {@code null} input passes straight through.
     */
    private static String normaliseText(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
