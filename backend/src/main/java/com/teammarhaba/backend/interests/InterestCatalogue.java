package com.teammarhaba.backend.interests;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import org.hibernate.annotations.SQLRestriction;

/**
 * One admin-managed interest in the master catalogue (TM-773, interests epic) — a pickable
 * label ("Coffee &amp; cafés") in a category ("Food &amp; Drink"), with a highlight flag and a
 * sort weight used to float the featured/popular ones to the top of the picker.
 *
 * <p>Schema is owned by Flyway ({@code V45__create_interests}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. It follows the same aggregate conventions as
 * {@code Venue}/{@code Event}:
 *
 * <ul>
 *   <li><b>Retire, never delete</b> — an interest a user has already picked must keep working, so a
 *       catalogue row is never hard-deleted. Retiring is done by soft-delete ({@link #deletedAt} +
 *       the house {@code @SQLRestriction("deleted_at is null")}, TM-114, which hides a tombstoned
 *       row from every normal query) and/or by flipping the separate, visible {@link #active} flag.
 *       The two are independent notions: {@code @SQLRestriction} hides the row entirely, whereas
 *       {@code active} is a plain column the admin console filters on ("offered to users").</li>
 *   <li><b>Snapshots are decoupled</b> — a {@code UserInterest} is a free-text COPY, not a
 *       reference, so editing/retiring/deleting a catalogue row never mutates a user's saved pick
 *       (see {@link UserInterest}). That is why retire-not-delete is safe.</li>
 *   <li><b>updated_at is app-managed</b> — set on create and {@linkplain #touch bumped} on every
 *       mutation (mirrors venues). Present from day one even though I1 ships no mutation path, to
 *       keep the aggregate on the same lifecycle contract when the admin write endpoint (I2) lands.</li>
 *   <li><b>Optimistic lock</b> — {@code @Version} gives the usual 409 on concurrent stale writes.</li>
 * </ul>
 */
@Entity
@Table(name = "interest_catalogue")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class InterestCatalogue {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Display label of the interest, e.g. "Coffee &amp; cafés". Required; unique among active rows. */
    @Column(name = "label", nullable = false)
    private String label;

    /** The grouping bucket, e.g. "Food &amp; Drink". Required. */
    @Column(name = "category", nullable = false)
    private String category;

    /** Whether the interest is featured; the six seed highlights carry a higher {@link #sortWeight}. */
    @Column(name = "highlighted", nullable = false)
    private boolean highlighted;

    /** Ordering weight — higher sorts first (the listing is {@code ORDER BY sort_weight DESC, label}). */
    @Column(name = "sort_weight", nullable = false)
    private int sortWeight;

    /** Whether the interest is offered to users; retire without deleting by flipping this to {@code false}. */
    @Column(name = "active", nullable = false)
    private boolean active = true;

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** App-managed: set on create and {@linkplain #touch bumped} on every mutation. */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Soft-delete marker: {@code null} = active, non-null = tombstoned at that instant. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** Optimistic-lock counter; Hibernate bumps it on every update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected InterestCatalogue() {
    }

    /** A new {@code active} interest with the given label/category, highlight flag and sort weight. */
    public InterestCatalogue(String label, String category, boolean highlighted, int sortWeight, Instant now) {
        this.label = label;
        this.category = category;
        this.highlighted = highlighted;
        this.sortWeight = sortWeight;
        this.active = true;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public String getLabel() {
        return label;
    }

    public String getCategory() {
        return category;
    }

    public boolean isHighlighted() {
        return highlighted;
    }

    public int getSortWeight() {
        return sortWeight;
    }

    /** {@code true} while the interest is offered to users (not retired via the active flag). */
    public boolean isActive() {
        return active;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** Bump {@code updatedAt} after an edit (the future edit API's responsibility). */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this interest has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }

    /** Retire (tombstone) the interest, hiding it via {@code @SQLRestriction}; bumps {@code updatedAt}. */
    void markDeleted(Instant when) {
        this.deletedAt = when;
        this.active = false;
        this.updatedAt = when;
    }

    /** Un-retire a tombstoned interest (clears the soft-delete marker); bumps {@code updatedAt}. */
    void restore(Instant when) {
        this.deletedAt = null;
        this.active = true;
        this.updatedAt = when;
    }
}
