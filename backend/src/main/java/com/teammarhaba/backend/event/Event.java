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

    /**
     * Default ticket price when an admin creates an event without naming one: £5.00, i.e. 500 pence
     * (TM-475). Mirrored by the {@code price_pence} column's {@code DEFAULT 500} in migration V21, so
     * a create that omits the price and a legacy backfilled row land on the same value.
     */
    public static final int DEFAULT_PRICE_PENCE = 500;

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

    /**
     * Optional coarse locality, e.g. {@code "London"} (TM-408). Two roles: the only location hint
     * the public API exposes before reveal, and the key into the config-driven per-city reveal
     * default. {@code null} = no hint / no per-city default.
     */
    @Column(name = "city")
    private String city;

    /**
     * Optional reference to a reusable {@link Venue} this event is held at (TM-519), held as a plain
     * FK id (not a JPA association) to stay decoupled from the {@code Venue} aggregate's own
     * {@code @SQLRestriction} — the same convention as {@link #createdBy}. {@code null} = a one-off
     * free-text location (or a legacy event): {@link #locationText} remains the authoritative display
     * line, so referencing a venue is additive and back-compatible. When set, the venue's editable
     * details (address, photo, capacity, …) are read live from the venue, so a venue edit propagates
     * to every event pointing at it. The exact venue address is admin-only; the public surface still
     * renders the reveal-gated {@code locationText} (TM-408), so a reference never leaks the address.
     */
    @Column(name = "venue_id")
    private Long venueId;

    /**
     * Per-event override of the location-reveal window, in whole hours before {@code startAt}
     * (TM-408). {@code null} = inherit — {@link LocationRevealPolicy} then falls back to the
     * per-city default and finally the app default (24h).
     */
    @Column(name = "location_reveal_hours")
    private Integer locationRevealHours;

    /**
     * Per-event override of the booking cutoff, in whole hours before {@code startAt} (TM-413).
     * {@code null} = inherit — {@link BookingCutoffPolicy} then falls back to the per-city default
     * and finally the app default (1h). Once {@code now >= startAt − cutoffHours} the RSVP,
     * waitlist-join and claim endpoints refuse a new join with a {@code 409}.
     */
    @Column(name = "booking_cutoff_hours")
    private Integer bookingCutoffHours;

    /**
     * Per-event override of the cancellation window, in whole hours before {@code startAt} (TM-414):
     * an un-RSVP inside it counts as a late cancellation. {@code null} = inherit — {@link
     * CancellationPolicy} then falls back to the per-city default and finally the app default (24h),
     * the same event → city → app-default order as the reveal window above.
     */
    @Column(name = "cancellation_window_hours")
    private Integer cancellationWindowHours;

    /**
     * Whether this event's {@code WAITLISTED} attendees are also members of its group chat (TM-446).
     * Shipped default {@code false} (both on a fresh entity and via the column's {@code DEFAULT
     * false}): only {@code GOING} attendees plus the host are in the thread. When {@code true}, a
     * waitlisted member joins the thread and {@link EventChatLifecycleService} keeps their membership
     * in sync as they convert to {@code GOING} or leave. The lifecycle enforces this; the DB only
     * carries the flag.
     */
    @Column(name = "include_waitlist_in_chat", nullable = false)
    private boolean includeWaitlistInChat = false;

    /**
     * Per-event override of the group-chat close/lock window, in whole hours <em>after</em> the event
     * ends (TM-446). {@code null} = inherit — {@link EventChatClosePolicy} then falls back to the
     * per-city default and finally the app default of <b>never close</b>, the same event → city →
     * app-default order as the reveal ({@link #locationRevealHours}) and cutoff
     * ({@link #bookingCutoffHours}) windows above. A closed thread is read-only (a soft-close on the
     * conversation, never a hard delete).
     */
    @Column(name = "chat_close_hours")
    private Integer chatCloseHours;

    /**
     * Optional opening message for the event's group chat (TM-710); {@code null}/blank = none. When set,
     * it is auto-posted once as an ANNOUNCEMENT the first time the event's chat opens (the lazy thread
     * creation on the first GOING landing — {@link EventChatLifecycleService}). Admin-set on
     * create/edit. TEXT column (no fixed entity cap; the admin API bounds the length at the edge).
     */
    @Column(name = "opening_message")
    private String openingMessage;

    /**
     * One-shot idempotency guard for the opening-message auto-post (TM-710); {@code null} until the
     * event's chat has opened at least once, non-null = the opening message has already been posted at
     * that instant. The auto-post fires only when {@link #openingMessage} is non-blank AND this stamp is
     * {@code null}, and stamps it in the same transaction as the post — so a re-open / redeploy /
     * replayed thread-create never duplicates the announcement. Stamped via {@link #markOpeningMessagePosted}.
     */
    @Column(name = "opening_message_posted_at")
    private Instant openingMessagePostedAt;

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

    /**
     * Inclusive lower edge of the event's target age band (TM-415, migration V16); {@code null} = no
     * lower bound. Paired with {@link #ageMax}: both {@code null} = open to all ages (no restriction,
     * the common case). The self-reported {@link com.teammarhaba.backend.user.User#getAge() User.age}
     * must fall within the band widened by the app-level ±tolerance grace — the hard eligibility guard
     * lives in {@code AgeEligibilityPolicy}, not here; this field only carries the band.
     */
    @Column(name = "age_min")
    private Integer ageMin;

    /** Inclusive upper edge of the target age band (TM-415); {@code null} = no upper bound. */
    @Column(name = "age_max")
    private Integer ageMax;

    /**
     * Ticket price in minor units — pence — of a single implied currency, GBP (TM-475, migration
     * V21). Stored as an integer of pence, not a decimal of pounds: exact (no binary-float
     * rounding), it sums cleanly and maps 1:1 onto what the feed checkout charges. Always set: the
     * admin form supplies it, and an omitted value falls back to {@link #DEFAULT_PRICE_PENCE} (£5) —
     * so this is never {@code null} and never negative (admin-layer {@code price >= 0} validation,
     * with a DB {@code CHECK} backstop). {@code 0} means a free event.
     */
    @Column(name = "price_pence", nullable = false)
    private int pricePence = DEFAULT_PRICE_PENCE;

    /**
     * Whether the event is gated as premium (TM-475, migration V21) — the flag the membership
     * entitlement reads to decide gating. Admin-set on create/edit; defaults to {@code false} (a
     * normal, un-gated event) both on a fresh entity and via the column's {@code DEFAULT false}.
     */
    @Column(name = "is_premium", nullable = false)
    private boolean premium = false;

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

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    /** The referenced reusable venue's id (TM-519), or {@code null} for a one-off free-text location. */
    public Long getVenueId() {
        return venueId;
    }

    public void setVenueId(Long venueId) {
        this.venueId = venueId;
    }

    public Integer getLocationRevealHours() {
        return locationRevealHours;
    }

    public void setLocationRevealHours(Integer locationRevealHours) {
        this.locationRevealHours = locationRevealHours;
    }

    public Integer getBookingCutoffHours() {
        return bookingCutoffHours;
    }

    public void setBookingCutoffHours(Integer bookingCutoffHours) {
        this.bookingCutoffHours = bookingCutoffHours;
    }

    public Integer getCancellationWindowHours() {
        return cancellationWindowHours;
    }

    public void setCancellationWindowHours(Integer cancellationWindowHours) {
        this.cancellationWindowHours = cancellationWindowHours;
    }

    /** Whether waitlisted attendees are also group-chat members (TM-446); default {@code false}. */
    public boolean isIncludeWaitlistInChat() {
        return includeWaitlistInChat;
    }

    public void setIncludeWaitlistInChat(boolean includeWaitlistInChat) {
        this.includeWaitlistInChat = includeWaitlistInChat;
    }

    public Integer getChatCloseHours() {
        return chatCloseHours;
    }

    public void setChatCloseHours(Integer chatCloseHours) {
        this.chatCloseHours = chatCloseHours;
    }

    /** The event's optional group-chat opening message (TM-710), or {@code null} when none is set. */
    public String getOpeningMessage() {
        return openingMessage;
    }

    public void setOpeningMessage(String openingMessage) {
        this.openingMessage = openingMessage;
    }

    /**
     * When the opening message was auto-posted (TM-710), or {@code null} if it never has been — the
     * idempotency guard for the one-shot auto-post.
     */
    public Instant getOpeningMessagePostedAt() {
        return openingMessagePostedAt;
    }

    /**
     * Whether the event has a non-blank opening message still waiting to be auto-posted (TM-710): a
     * configured message that has not yet been stamped as posted. {@code false} when there is no opening
     * message, it is blank, or it has already been posted once — so the auto-post never fires twice.
     */
    public boolean hasPendingOpeningMessage() {
        return openingMessage != null && !openingMessage.isBlank() && openingMessagePostedAt == null;
    }

    /**
     * Stamp the opening message as posted at {@code when} (TM-710) — the idempotency guard flip.
     * First-moment-wins: a no-op once already stamped, so two racing thread-creates (serialised behind
     * the RSVP tx's {@code SELECT ... FOR UPDATE} on the events row, but belt-and-braces here too) can
     * never both post. Callers must check {@link #hasPendingOpeningMessage} first.
     */
    public void markOpeningMessagePosted(Instant when) {
        if (this.openingMessagePostedAt == null) {
            this.openingMessagePostedAt = when;
        }
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

    public Integer getAgeMin() {
        return ageMin;
    }

    public void setAgeMin(Integer ageMin) {
        this.ageMin = ageMin;
    }

    public Integer getAgeMax() {
        return ageMax;
    }

    public void setAgeMax(Integer ageMax) {
        this.ageMax = ageMax;
    }

    /** {@code true} when this event targets an age group (at least one band edge is set). */
    public boolean hasAgeRestriction() {
        return ageMin != null || ageMax != null;
    }

    /** Ticket price in pence (minor units, GBP); {@code 0} = free. Never negative (TM-475). */
    public int getPricePence() {
        return pricePence;
    }

    public void setPricePence(int pricePence) {
        this.pricePence = pricePence;
    }

    /** {@code true} when this event is gated as premium (TM-475). */
    public boolean isPremium() {
        return premium;
    }

    public void setPremium(boolean premium) {
        this.premium = premium;
    }

    /**
     * Human-readable band for the eligibility 409 copy (TM-415): a full band {@code "25–30"}, a
     * single cohort {@code "28"} (min == max), or a half-open band {@code "18 and up"} /
     * {@code "up to 12"}. Only meaningful when {@link #hasAgeRestriction()} — an open band has no
     * label. The grace is not advertised: the label names the configured band, not the widened one.
     */
    public String ageBandLabel() {
        if (ageMin != null && ageMax != null) {
            return ageMin.equals(ageMax) ? ageMin.toString() : ageMin + "–" + ageMax;
        }
        return ageMin != null ? ageMin + " and up" : "up to " + ageMax;
    }

    public EventStatus getStatus() {
        return status;
    }

    /** {@code true} while the event is live (not cancelled). */
    public boolean isPublished() {
        return status == EventStatus.PUBLISHED;
    }

    /**
     * The public-API visibility rule (TM-393): {@code PUBLISHED} and {@code when} inside the
     * [{@code visibilityStart}, {@code visibilityEnd}] window. Cancelled or out-of-window events
     * are <em>hidden</em> — the public endpoints 404 them (soft-deleted rows never even load,
     * thanks to the {@code @SQLRestriction}).
     */
    public boolean isVisibleAt(Instant when) {
        return isPublished() && !when.isBefore(visibilityStart) && !when.isAfter(visibilityEnd);
    }

    /**
     * {@code true} once the event has started — the cut-off after which attendance changes
     * (RSVP, un-RSVP, claim) are refused with a {@code 409} (TM-393).
     */
    public boolean hasStartedBy(Instant when) {
        return !when.isBefore(startAt);
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
