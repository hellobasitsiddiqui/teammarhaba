package com.teammarhaba.backend.city;

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
 * One admin-managed city in the master catalogue (TM-1089) — a pickable place ("London") with a
 * country, a default icon glyph, a geo point (lat/long) and a big empty-state image path, on a
 * highlight-free sort weight used to keep popular/curated cities at the top of the picker.
 *
 * <p>Replaces the hardcoded city list ({@code CITY_OPTIONS} / {@code ALLOWED_CITIES}). Schema is
 * owned by Flyway ({@code V54__create_cities}); Hibernate runs validate-only, so this mapping must
 * match the table exactly. It follows the same aggregate conventions as {@code InterestCatalogue}:
 *
 * <ul>
 *   <li><b>Retire, never delete</b> — a city a user (or event) already references by name must keep
 *       working, so a catalogue row is never hard-deleted. Retiring is done by soft-delete
 *       ({@link #deletedAt} + the house {@code @SQLRestriction("deleted_at is null")}, TM-114, which
 *       hides a tombstoned row from every normal query) and/or by flipping the separate, visible
 *       {@link #active} flag. The two are independent: {@code @SQLRestriction} hides the row entirely,
 *       whereas {@code active} is a plain column the admin console filters on ("offered to users").</li>
 *   <li><b>References are decoupled</b> — a user's saved {@code city} (and an event's city) is a
 *       free-text COPY, not a foreign key, so editing/retiring/deleting a catalogue row never mutates
 *       a user's or event's saved value. That is why retire-not-delete is safe.</li>
 *   <li><b>updated_at is app-managed</b> — set on create and {@linkplain #touch bumped} on every
 *       mutation (mirrors venues/interests).</li>
 *   <li><b>Optimistic lock</b> — {@code @Version} gives the usual 409 on concurrent stale writes.</li>
 * </ul>
 *
 * <p>The {@link #iconEmoji} and {@link #imagePath} are STORED here but their consumption (the
 * Events-tab heading icon, the Home empty-state image) is a deliberate follow-up — this aggregate
 * only makes the fields available and round-trippable.
 */
@Entity
@Table(name = "city_catalogue")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class CityCatalogue {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Display name of the city, e.g. "London". Required; unique among active rows. */
    @Column(name = "name", nullable = false)
    private String name;

    /** The country the city sits in, e.g. "United Kingdom". Required (admin free-text). */
    @Column(name = "country", nullable = false)
    private String country;

    /**
     * A small emoji glyph shown beside the city name (e.g. a flag), or {@code null} for none. NULLABLE
     * by design — a city without an icon is valid; the client falls back to no glyph (mirrors
     * {@code interest_catalogue.emoji}, TM-805).
     */
    @Column(name = "icon_emoji")
    private String iconEmoji;

    /** Latitude of the city centre (decimal degrees, WGS-84), or {@code null} if unset. */
    @Column(name = "geo_lat")
    private Double geoLat;

    /** Longitude of the city centre (decimal degrees, WGS-84), or {@code null} if unset. */
    @Column(name = "geo_lng")
    private Double geoLng;

    /**
     * Storage path of the big empty-state image (e.g. {@code "city-images/london.jpg"}), served via
     * {@code downloadUrlForPath}, or {@code null} if none. STORED here, not yet rendered on Home
     * (deferred follow-up).
     */
    @Column(name = "image_path")
    private String imagePath;

    /** Ordering weight — higher sorts first (the listing is {@code ORDER BY sort_weight DESC, name}). */
    @Column(name = "sort_weight", nullable = false)
    private int sortWeight;

    /** Whether the city is offered to users; retire without deleting by flipping this to {@code false}. */
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
    protected CityCatalogue() {
    }

    /** A new {@code active} city with the given name/country and sort weight (icon/geo/image set separately). */
    public CityCatalogue(String name, String country, int sortWeight, Instant now) {
        this.name = name;
        this.country = country;
        this.sortWeight = sortWeight;
        this.active = true;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    /** Rename the city (admin edit). Does NOT bump {@code updatedAt} — the service calls {@link #touch} once. */
    public void setName(String name) {
        this.name = name;
    }

    public String getCountry() {
        return country;
    }

    /** Change the country (admin edit). Does not bump {@code updatedAt} (see {@link #setName}). */
    public void setCountry(String country) {
        this.country = country;
    }

    /** The emoji icon shown beside the city name, or {@code null} if none. */
    public String getIconEmoji() {
        return iconEmoji;
    }

    /** Set/clear the icon glyph (admin edit). Does not bump {@code updatedAt} (see {@link #setName}). */
    public void setIconEmoji(String iconEmoji) {
        this.iconEmoji = iconEmoji;
    }

    public Double getGeoLat() {
        return geoLat;
    }

    /** Set/clear the latitude (admin edit). Does not bump {@code updatedAt} (see {@link #setName}). */
    public void setGeoLat(Double geoLat) {
        this.geoLat = geoLat;
    }

    public Double getGeoLng() {
        return geoLng;
    }

    /** Set/clear the longitude (admin edit). Does not bump {@code updatedAt} (see {@link #setName}). */
    public void setGeoLng(Double geoLng) {
        this.geoLng = geoLng;
    }

    public String getImagePath() {
        return imagePath;
    }

    /** Set/clear the big empty-state image path (admin edit). Does not bump {@code updatedAt}. */
    public void setImagePath(String imagePath) {
        this.imagePath = imagePath;
    }

    public int getSortWeight() {
        return sortWeight;
    }

    /** Change the ordering weight (admin edit). Does not bump {@code updatedAt} (see {@link #setName}). */
    public void setSortWeight(int sortWeight) {
        this.sortWeight = sortWeight;
    }

    /** {@code true} while the city is offered to users (not retired via the active flag). */
    public boolean isActive() {
        return active;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** Bump {@code updatedAt} after an edit. */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this city has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }

    /** Retire (tombstone) the city, hiding it via {@code @SQLRestriction}; bumps {@code updatedAt}. */
    void markDeleted(Instant when) {
        this.deletedAt = when;
        this.active = false;
        this.updatedAt = when;
    }

    /** Un-retire a tombstoned city (clears the soft-delete marker); bumps {@code updatedAt}. */
    void restore(Instant when) {
        this.deletedAt = null;
        this.active = true;
        this.updatedAt = when;
    }
}
