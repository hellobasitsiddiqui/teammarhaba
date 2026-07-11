package com.teammarhaba.backend.event;

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
 * A reusable venue/location (TM-519, events epic) — a named place an admin creates once and events
 * then <em>reference</em> instead of retyping a free-text location each time. Edit the venue once
 * and every event pointing at it reflects the change (the event carries a {@code venueId} reference,
 * not a copied string).
 *
 * <p>Schema is owned by Flyway ({@code V41__create_venues}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. It follows the same aggregate conventions as {@link Event}:
 *
 * <ul>
 *   <li><b>Soft-delete</b> — {@code deletedAt} + the house {@code @SQLRestriction} (TM-114) hide a
 *       tombstoned row from every normal query. This ticket never hard-deletes a venue (a past event
 *       may reference it); retire is via {@link #active}, but the column keeps the venue on the same
 *       lifecycle contract as the other aggregates.</li>
 *   <li><b>Deactivate ≠ delete</b> — {@link #active} is the "offered in the event-create picker"
 *       flag. Deactivating flips it to {@code false} (the place is retired but the record and any
 *       referencing events survive); the admin console still lists it and can reactivate.</li>
 *   <li><b>People as a plain FK</b> — {@code createdBy} holds the creator's {@code users.id} as a
 *       plain id, not a JPA association, to stay decoupled from the {@code User} aggregate's own
 *       {@code @SQLRestriction} (same convention as {@link Event#getCreatedBy()}).</li>
 *   <li><b>Optimistic lock</b> — {@code @Version} gives the usual 409 on concurrent stale writes.</li>
 * </ul>
 *
 * <p><b>Location-reveal (TM-408)</b> — the exact {@link #addressLine} is only ever exposed through the
 * admin venues API (admin-only). The public event surface renders {@code events.location_text} gated
 * by the reveal window, and does not surface a referenced venue's address, so referencing a venue can
 * never leak its exact location before reveal.
 */
@Entity
@Table(name = "venues")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class Venue {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Display name of the place, e.g. "Marhaba Community Hall". Required. */
    @Column(name = "name", nullable = false)
    private String name;

    /** Full street address on one line — the exact location. Required. */
    @Column(name = "address_line", nullable = false)
    private String addressLine;

    /** Optional coarse locality / area tag (e.g. "London"); the searchable dimension. {@code null} = none. */
    @Column(name = "city")
    private String city;

    /** Optional latitude (WGS84 decimal degrees) for a map pin; {@code null} = no pin. */
    @Column(name = "latitude")
    private Double latitude;

    /** Optional longitude (WGS84 decimal degrees) for a map pin; {@code null} = no pin. */
    @Column(name = "longitude")
    private Double longitude;

    /** Optional map-pin link; {@code null} when there is none. */
    @Column(name = "map_url")
    private String mapUrl;

    /** Optional free-text description / directions; {@code null} = none. */
    @Column(name = "notes")
    private String notes;

    /** Optional headline capacity of the place ({@code >= 1} when set); {@code null} = unspecified. */
    @Column(name = "capacity")
    private Integer capacity;

    /** Optional accessibility notes (step-free access, accessible toilets, …); {@code null} = none. */
    @Column(name = "accessibility")
    private String accessibility;

    /** Optional parking notes; {@code null} = none. */
    @Column(name = "parking")
    private String parking;

    /** Optional indoor/outdoor classification; {@code null} = unspecified. */
    @Enumerated(EnumType.STRING)
    @Column(name = "indoor_outdoor")
    private IndoorOutdoor indoorOutdoor;

    /** Optional Firebase Storage path of the venue photo ({@code venue-images/…}); {@code null} = none. */
    @Column(name = "photo_path")
    private String photoPath;

    /** Whether the venue is offered in the event-create picker; deactivate flips it to {@code false}. */
    @Column(name = "active", nullable = false)
    private boolean active = true;

    /** {@code users.id} of the creating admin. Resolve the person through {@code UserRepository}. */
    @Column(name = "created_by", nullable = false, updatable = false)
    private Long createdBy;

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
    protected Venue() {
    }

    /**
     * A new {@code active} venue with the required fields ({@code name}, {@code addressLine}); the
     * optional details are set separately through the setters.
     */
    public Venue(String name, String addressLine, Long createdBy, Instant now) {
        this.name = name;
        this.addressLine = addressLine;
        this.createdBy = createdBy;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getAddressLine() {
        return addressLine;
    }

    public void setAddressLine(String addressLine) {
        this.addressLine = addressLine;
    }

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    public Double getLatitude() {
        return latitude;
    }

    public void setLatitude(Double latitude) {
        this.latitude = latitude;
    }

    public Double getLongitude() {
        return longitude;
    }

    public void setLongitude(Double longitude) {
        this.longitude = longitude;
    }

    public String getMapUrl() {
        return mapUrl;
    }

    public void setMapUrl(String mapUrl) {
        this.mapUrl = mapUrl;
    }

    public String getNotes() {
        return notes;
    }

    public void setNotes(String notes) {
        this.notes = notes;
    }

    public Integer getCapacity() {
        return capacity;
    }

    public void setCapacity(Integer capacity) {
        this.capacity = capacity;
    }

    public String getAccessibility() {
        return accessibility;
    }

    public void setAccessibility(String accessibility) {
        this.accessibility = accessibility;
    }

    public String getParking() {
        return parking;
    }

    public void setParking(String parking) {
        this.parking = parking;
    }

    public IndoorOutdoor getIndoorOutdoor() {
        return indoorOutdoor;
    }

    public void setIndoorOutdoor(IndoorOutdoor indoorOutdoor) {
        this.indoorOutdoor = indoorOutdoor;
    }

    public String getPhotoPath() {
        return photoPath;
    }

    public void setPhotoPath(String photoPath) {
        this.photoPath = photoPath;
    }

    /** {@code true} while the venue is offered in the event-create picker (not deactivated). */
    public boolean isActive() {
        return active;
    }

    /** Set the active flag directly (create-time / edit); {@link #deactivate}/{@link #reactivate} bump updatedAt. */
    public void setActive(boolean active) {
        this.active = active;
    }

    /** Retire the venue (idempotent): drop it from the event-create picker, keep the record + references. */
    public void deactivate(Instant when) {
        this.active = false;
        this.updatedAt = when;
    }

    /** Offer the venue in the picker again (idempotent). */
    public void reactivate(Instant when) {
        this.active = true;
        this.updatedAt = when;
    }

    public Long getCreatedBy() {
        return createdBy;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** Bump {@code updatedAt} after edits via the field setters (the edit API's responsibility). */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this venue has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }
}
