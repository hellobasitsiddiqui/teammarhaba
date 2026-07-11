package com.teammarhaba.backend.event;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin-side venue management (TM-519): create, list/search, edit, and deactivate reusable venues —
 * the service behind {@code /api/v1/admin/venues}. Authorization ({@code hasRole('ADMIN')}) is
 * enforced at the controller; this service owns the domain rules, mirroring {@link EventAdminService}:
 *
 * <ul>
 *   <li><b>Audited</b> — every mutation appends a house audit row ({@link AuditService}, TM-113) in
 *       the same transaction, so an action and its audit trail commit or roll back together.</li>
 *   <li><b>No existence leak</b> — a missing id is always a plain 404
 *       ({@link ResourceNotFoundException}), the TM-111 pattern.</li>
 *   <li><b>Deactivate ≠ delete</b> — deactivating flips {@code active} to {@code false} and keeps the
 *       row (a past event may reference it); it is idempotent, and a repeat deactivate neither
 *       re-audits nor re-touches. Reactivate is the mirror.</li>
 *   <li><b>No-op edit is silent</b> — a PATCH that changes nothing is a clean no-op: no audit row,
 *       no {@code updatedAt} bump.</li>
 * </ul>
 *
 * <p>Unlike {@link EventAdminService} there is no lifecycle-event seam: venues are library records,
 * not scheduled things attendees follow, so nothing subscribes to venue mutations.
 */
@Service
public class VenueAdminService {

    /** Audit {@code target_type} for venue rows (mirrors {@link EventAdminService#TARGET_EVENT}). */
    static final String TARGET_VENUE = "Venue";

    private final VenueRepository venues;
    private final UserService users;
    private final AuditService audit;
    private final EntityManager entityManager;

    public VenueAdminService(
            VenueRepository venues, UserService users, AuditService audit, EntityManager entityManager) {
        this.venues = venues;
        this.users = users;
        this.audit = audit;
        this.entityManager = entityManager;
    }

    /**
     * The admin listing: the full venue inventory, filtered by an optional case-insensitive search
     * over name/city and an optional active-only flag (the event-create picker passes
     * {@code activeOnly = true}; the console passes {@code false} to see deactivated venues too). Only
     * soft-deleted rows are hidden (the entity's {@code @SQLRestriction}).
     */
    @Transactional(readOnly = true)
    public Page<Venue> list(String query, boolean activeOnly, Pageable pageable) {
        String q = (query == null || query.isBlank()) ? null : query.trim();
        return venues.search(q, activeOnly, pageable);
    }

    /** One venue by id; 404 if absent or soft-deleted (no existence leak). */
    @Transactional(readOnly = true)
    public Venue get(long id) {
        return venues.findById(id).orElseThrow(VenueAdminService::notFound);
    }

    /**
     * Create an {@code active} venue owned by the calling admin. The creator's {@code users.id} is
     * resolved through the JIT-provisioning path (TM-112), so a first-action admin always has a row.
     * Audits {@link AuditAction#VENUE_CREATED}.
     */
    @Transactional
    public Venue create(VerifiedUser caller, VenueDraft draft) {
        Instant now = Instant.now();
        User creator = users.provision(caller);
        Venue venue = new Venue(draft.name(), draft.addressLine(), creator.getId(), now);
        venue.setCity(draft.city());
        venue.setLatitude(draft.latitude());
        venue.setLongitude(draft.longitude());
        venue.setMapUrl(draft.mapUrl());
        venue.setNotes(draft.notes());
        venue.setCapacity(draft.capacity());
        venue.setAccessibility(draft.accessibility());
        venue.setParking(draft.parking());
        venue.setIndoorOutdoor(draft.indoorOutdoor());
        venue.setPhotoPath(draft.photoPath());

        Venue saved = venues.saveAndFlush(venue);
        // created_at is DB-authoritative (DEFAULT now(), insertable = false): re-read it so the 201
        // body carries the real timestamp instead of null (same as EventAdminService.create).
        entityManager.refresh(saved);

        audit.record(
                caller.uid(),
                AuditAction.VENUE_CREATED,
                TARGET_VENUE,
                String.valueOf(saved.getId()),
                Map.of("name", saved.getName()));
        return saved;
    }

    /**
     * Partial edit: apply the patch's non-{@code null}, actually-changed fields, audit
     * {@link AuditAction#VENUE_UPDATED} with the changed field names. A patch that changes nothing is
     * a clean no-op (no audit, no {@code updatedAt} bump). Because a venue is referenced (not copied)
     * by events, a name/address/detail edit here reflects everywhere it's used.
     */
    @Transactional
    public Venue update(VerifiedUser caller, long id, VenuePatch patch) {
        Venue venue = venues.findById(id).orElseThrow(VenueAdminService::notFound);

        List<String> changed = new ArrayList<>();
        applyIfChanged(patch.name(), venue.getName(), venue::setName, "name", changed);
        applyIfChanged(patch.addressLine(), venue.getAddressLine(), venue::setAddressLine, "addressLine", changed);
        applyIfChanged(patch.city(), venue.getCity(), venue::setCity, "city", changed);
        applyIfChanged(patch.latitude(), venue.getLatitude(), venue::setLatitude, "latitude", changed);
        applyIfChanged(patch.longitude(), venue.getLongitude(), venue::setLongitude, "longitude", changed);
        applyIfChanged(patch.mapUrl(), venue.getMapUrl(), venue::setMapUrl, "mapUrl", changed);
        applyIfChanged(patch.notes(), venue.getNotes(), venue::setNotes, "notes", changed);
        applyIfChanged(patch.capacity(), venue.getCapacity(), venue::setCapacity, "capacity", changed);
        applyIfChanged(
                patch.accessibility(), venue.getAccessibility(), venue::setAccessibility, "accessibility", changed);
        applyIfChanged(patch.parking(), venue.getParking(), venue::setParking, "parking", changed);
        applyIfChanged(
                patch.indoorOutdoor(), venue.getIndoorOutdoor(), venue::setIndoorOutdoor, "indoorOutdoor", changed);
        applyIfChanged(patch.photoPath(), venue.getPhotoPath(), venue::setPhotoPath, "photoPath", changed);

        if (changed.isEmpty()) {
            return venue; // nothing actually changed: no touch, no audit
        }
        venue.touch(Instant.now()); // dirty-checking flushes on commit

        audit.record(
                caller.uid(),
                AuditAction.VENUE_UPDATED,
                TARGET_VENUE,
                String.valueOf(venue.getId()),
                Map.of("fields", List.copyOf(changed)));
        return venue;
    }

    /**
     * Deactivate — retire the venue from the event-create picker while keeping the record (and any
     * referencing events). Idempotent: deactivating an already-inactive venue returns it unchanged and
     * does <em>not</em> re-audit. Audits {@link AuditAction#VENUE_DEACTIVATED} on the actual transition.
     */
    @Transactional
    public Venue deactivate(VerifiedUser caller, long id) {
        Venue venue = venues.findById(id).orElseThrow(VenueAdminService::notFound);
        if (!venue.isActive()) {
            return venue; // already inactive — idempotent no-op
        }
        venue.deactivate(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.VENUE_DEACTIVATED,
                TARGET_VENUE,
                String.valueOf(venue.getId()),
                Map.of("name", venue.getName()));
        return venue;
    }

    /**
     * Reactivate — offer the venue in the picker again. Idempotent mirror of {@link #deactivate}:
     * reactivating an already-active venue is a no-op that does not re-audit. Audits
     * {@link AuditAction#VENUE_REACTIVATED} on the actual transition.
     */
    @Transactional
    public Venue reactivate(VerifiedUser caller, long id) {
        Venue venue = venues.findById(id).orElseThrow(VenueAdminService::notFound);
        if (venue.isActive()) {
            return venue; // already active — idempotent no-op
        }
        venue.reactivate(Instant.now());
        audit.record(
                caller.uid(),
                AuditAction.VENUE_REACTIVATED,
                TARGET_VENUE,
                String.valueOf(venue.getId()),
                Map.of("name", venue.getName()));
        return venue;
    }

    /** Apply {@code value} when it is present and different, recording the field name if it changed. */
    private static <T> void applyIfChanged(T value, T current, Consumer<T> setter, String field, List<String> changed) {
        if (value != null && !Objects.equals(value, current)) {
            setter.accept(value);
            changed.add(field);
        }
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("Venue not found.");
    }
}
