package com.teammarhaba.backend.interests;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One interest a user picked (TM-773, interests epic) — a per-user, append-only FREE-TEXT SNAPSHOT.
 *
 * <p><b>The snapshot invariant (this entity's whole reason to exist):</b> {@link #label} and
 * {@link #category} are TEXT COPIES taken from the catalogue at pick time and are frozen — they are
 * the user's own free-text record and are <em>independent of the catalogue row's later
 * edit/retire/delete</em>. If an admin renames, retires (soft-delete / {@code active=false}), or even
 * hard-deletes the source {@link InterestCatalogue} interest, the values saved here DO NOT CHANGE.
 * This is the user's explicit design and is enforced at the schema level: see
 * {@link #sourceInterestId}.
 *
 * <p>Schema is owned by Flyway ({@code V45__create_interests}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. Conventions:
 *
 * <ul>
 *   <li><b>Append-only log</b> — no soft-delete and no {@code @Version} (unlike the catalogue),
 *       mirroring {@code EventAttendance}: I1 only inserts and reads; edit/replace semantics belong to
 *       later tickets.</li>
 *   <li><b>{@code sourceInterestId} is a soft provenance pointer only</b> — a plain {@code Long}, NOT
 *       a JPA association and NOT a DB foreign key. There is deliberately no {@code REFERENCES} clause
 *       on the column, so no {@code ON DELETE CASCADE} and no {@code ON DELETE SET NULL} can ever
 *       touch it; deleting the catalogue row leaves this id (and the copied label/category) intact.</li>
 *   <li><b>{@code userId} is a real FK</b> to {@code users(id)} with {@code ON DELETE CASCADE} — this
 *       is per-user data that dies with a hard-removed account (a soft-delete tombstone never fires
 *       the cascade). It is still stored as a plain {@code Long}, not a JPA association, to stay
 *       decoupled from the {@code User} aggregate's own {@code @SQLRestriction} (same convention as
 *       {@code EventAttendance}/{@code DeviceToken}). Resolve people through {@code UserRepository}.</li>
 * </ul>
 */
@Entity
@Table(name = "user_interest")
public class UserInterest {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** {@code users.id} of the owner (real FK, {@code ON DELETE CASCADE}); stored as a plain id. */
    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    /** Free-text COPY of the catalogue label at pick time — frozen, independent of the catalogue. */
    @Column(name = "label", nullable = false)
    private String label;

    /** Free-text COPY of the catalogue category at pick time — frozen, independent of the catalogue. */
    @Column(name = "category", nullable = false)
    private String category;

    /**
     * Soft provenance pointer to the source catalogue row — a plain {@code Long}, deliberately NOT a
     * JPA association and NOT a DB foreign key, so no cascade/set-null can ever mutate or remove this
     * snapshot when the catalogue changes. {@code null} for a snapshot with no known source.
     */
    @Column(name = "source_interest_id")
    private Long sourceInterestId;

    /** DB-authoritative pick instant ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** Required by JPA. */
    protected UserInterest() {
    }

    /**
     * A new snapshot: {@code label}/{@code category} are the free-text COPIES to freeze,
     * {@code sourceInterestId} is the (optional) provenance hint to the catalogue row picked from.
     */
    public UserInterest(Long userId, String label, String category, Long sourceInterestId) {
        this.userId = userId;
        this.label = label;
        this.category = category;
        this.sourceInterestId = sourceInterestId;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public String getLabel() {
        return label;
    }

    public String getCategory() {
        return category;
    }

    public Long getSourceInterestId() {
        return sourceInterestId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
