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
 * A meetup event (TM-391, events epic).
 *
 * <p>Schema is owned by Flyway ({@code V11__create_events}); Hibernate runs validate-only, so this
 * mapping must match the table exactly.
 *
 * <p><b>Time model</b> — all instants ({@code startAt}, {@code endAt}, the visibility window) are
 * stored as UTC {@link Instant}s, paired with the event's IANA {@code timezone} id (e.g.
 * {@code "Europe/London"}). The backend never renders local times; clients combine instant +
 * timezone to display, which keeps DST correct without server-side conversion.
 *
 * <p><b>Visibility &amp; lifecycle</b> — an event appears in the listing while {@code now} is inside
 * [{@code visibilityStart}, {@code visibilityEnd}] <em>and</em> the status is
 * {@link EventStatus#PUBLISHED}. {@linkplain #cancel Cancelling} keeps the row readable for its
 * attendees but drops it from the listing; soft-deleting ({@code deletedAt} + the house
 * {@code @SQLRestriction} from TM-114) hides it from every normal query. {@code @Version} gives the
 * usual optimistic-lock 409 on concurrent stale writes.
 *
 * <p><b>People</b> — {@code createdBy} holds the creator's {@code users.id} as a plain FK id, not a
 * JPA association, to stay decoupled from the {@code User} aggregate's {@code @SQLRestriction}
 * (same convention as {@code DeviceToken}). Resolve people through {@code UserRepository}, which
 * hides soft-deleted accounts — never through this table.
 */
@Entity
@Table(name = "events")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class Event {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "heading", nullable = false)
    private String heading;

    @Column(name = "description", nullable = false)
    private String description;

    /** Free-text venue line — always present, even for online events (e.g. "Online"). */
    @Column(name = "location_text", nullable = false)
    private String locationText;

    /** Optional map-pin link; {@code null} when there is none. */
    @Column(name = "map_url")
    private String mapUrl;

    /** Optional join link for online/hybrid events; {@code null} for in-person only. */
    @Column(name = "online_url")
    private String onlineUrl;

    /** IANA timezone id of the event's locale; pairs with the UTC instants for client rendering. */
    @Column(name = "timezone", nullable = false)
    private String timezone;

    @Column(name = "start_at", nullable = false)
    private Instant startAt;

    /** Optional end instant; {@code null} = open-ended. */
    @Column(name = "end_at")
    private Instant endAt;

    @Column(name = "visibility_start", nullable = false)
    private Instant visibilityStart;

    @Column(name = "visibility_end", nullable = false)
    private Instant visibilityEnd;

    /** Max {@code GOING} attendees; {@code null} = unlimited (waitlisting never kicks in). */
    @Column(name = "capacity")
    private Integer capacity;

    /** Optional storage path of the event image; {@code null} = themed placeholder. */
    @Column(name = "image_path")
    private String imagePath;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    private EventStatus status = EventStatus.PUBLISHED;

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
    protected Event() {
    }

    /**
     * A new {@code PUBLISHED} event with the required fields; the optional ones ({@code mapUrl},
     * {@code onlineUrl}, {@code endAt}, {@code capacity}, {@code imagePath}) are set separately.
     */
    public Event(
            String heading,
            String description,
            String locationText,
            String timezone,
            Instant startAt,
            Instant visibilityStart,
            Instant visibilityEnd,
            Long createdBy,
            Instant now) {
        this.heading = heading;
        this.description = description;
        this.locationText = locationText;
        this.timezone = timezone;
        this.startAt = startAt;
        this.visibilityStart = visibilityStart;
        this.visibilityEnd = visibilityEnd;
        this.createdBy = createdBy;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public String getHeading() {
        return heading;
    }

    public void setHeading(String heading) {
        this.heading = heading;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getLocationText() {
        return locationText;
    }

    public void setLocationText(String locationText) {
        this.locationText = locationText;
    }

    public String getMapUrl() {
        return mapUrl;
    }

    public void setMapUrl(String mapUrl) {
        this.mapUrl = mapUrl;
    }

    public String getOnlineUrl() {
        return onlineUrl;
    }

    public void setOnlineUrl(String onlineUrl) {
        this.onlineUrl = onlineUrl;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public Instant getStartAt() {
        return startAt;
    }

    public void setStartAt(Instant startAt) {
        this.startAt = startAt;
    }

    public Instant getEndAt() {
        return endAt;
    }

    public void setEndAt(Instant endAt) {
        this.endAt = endAt;
    }

    public Instant getVisibilityStart() {
        return visibilityStart;
    }

    public void setVisibilityStart(Instant visibilityStart) {
        this.visibilityStart = visibilityStart;
    }

    public Instant getVisibilityEnd() {
        return visibilityEnd;
    }

    public void setVisibilityEnd(Instant visibilityEnd) {
        this.visibilityEnd = visibilityEnd;
    }

    public Integer getCapacity() {
        return capacity;
    }

    public void setCapacity(Integer capacity) {
        this.capacity = capacity;
    }

    /** {@code true} when {@code GOING} slots are capped; {@code false} = unlimited. */
    public boolean hasCapacityLimit() {
        return capacity != null;
    }

    public String getImagePath() {
        return imagePath;
    }

    public void setImagePath(String imagePath) {
        this.imagePath = imagePath;
    }

    public EventStatus getStatus() {
        return status;
    }

    /** {@code true} while the event is live (not cancelled). */
    public boolean isPublished() {
        return status == EventStatus.PUBLISHED;
    }

    /**
     * Call the event off (idempotent): keeps the row readable for attendees/history but drops it
     * from the visible-now listing. Distinct from soft-delete, which hides it everywhere.
     */
    public void cancel(Instant when) {
        this.status = EventStatus.CANCELLED;
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

    /** {@code true} once this event has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }

    /** Soft-delete: tombstone the row so normal queries hide it. Package-private — go via the service. */
    void markDeleted(Instant when) {
        this.deletedAt = when;
        this.updatedAt = when;
    }

    /** Undo a soft-delete, making the event visible to queries again. Idempotent on an active row. */
    void restore(Instant when) {
        this.deletedAt = null;
        this.updatedAt = when;
    }
}
