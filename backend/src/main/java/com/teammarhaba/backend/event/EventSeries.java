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
import java.time.LocalDate;
import org.hibernate.annotations.SQLRestriction;

/**
 * A recurring event series (TM-789, recurring events v1) — the template + cadence an admin defines
 * once, from which concrete {@link Event} occurrences are generated. This ticket is the
 * <em>data model only</em>: no API, no UI, and no recurrence engine (that is TM-790). It owns the
 * series row, the events → series reference, and the repository.
 *
 * <p>Schema is owned by Flyway ({@code V57__create_event_series}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. It follows the same aggregate conventions as
 * {@link Event} / {@link Venue}: DB-authoritative {@code created_at}, app-managed {@code updated_at},
 * the house soft-delete ({@code deleted_at} + {@code @SQLRestriction}), and a {@code @Version}
 * optimistic-lock counter.
 *
 * <p><b>v1 THIN CUT — DAILY + WEEKLY only.</b> The model is intentionally kept extensible for 3b:
 * {@link #rruleRaw} (a nullable RFC-5545 RRULE), {@link #byMonthDay} and {@link #nthWeekday} are
 * present as columns but <em>never populated in v1</em> — they exist so the monthly / nth-weekday
 * cadences land in 3b without a schema change. Only {@link SeriesFrequency#DAILY} and
 * {@link SeriesFrequency#WEEKLY} are produced/consumed in v1.
 *
 * <p><b>Template snapshot</b> — the series carries a frozen copy of the {@link EventDraft} fields
 * (heading, description, location, capacity, price, the reveal/cutoff/cancellation windows, image,
 * timezone). The engine (TM-790) stamps each generated occurrence from this snapshot, so editing the
 * series template affects only occurrences generated afterwards — occurrence-level edits and
 * edit-scope propagation are deferred to 3b.
 *
 * <p><b>Time model</b> — like {@link Event}, instants ({@link #firstStartAt},
 * {@link #horizonGeneratedUntil}) are UTC {@link Instant}s paired with the IANA {@link #timezone};
 * {@link #untilDate} is a calendar {@link LocalDate} (the local recurrence end, no time-of-day).
 */
@Entity
@Table(name = "event_series")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class EventSeries {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // ---- Recurrence rule ----------------------------------------------------------------------

    /** How often the series repeats. v1: {@code DAILY} | {@code WEEKLY} only. */
    @Enumerated(EnumType.STRING)
    @Column(name = "frequency", nullable = false)
    private SeriesFrequency frequency;

    /** Every-N step: {@code 1} = every day/week, {@code 2} = every other, … Always {@code >= 1}. */
    @Column(name = "interval_value", nullable = false)
    private int interval = 1;

    /**
     * For {@code WEEKLY}: the weekday to pin occurrences to (1 = Monday … 7 = Sunday, ISO-8601), or
     * {@code null} to inherit the weekday of {@link #firstStartAt}. Unused (and {@code null}) for
     * {@code DAILY}. v1 supports a single weekday only — multi-weekday is 3b.
     */
    @Column(name = "by_weekday")
    private Integer byWeekday;

    /**
     * 3b placeholder (day-of-month for a MONTHLY cadence, 1–31 or -1 for last). NOT used in v1 —
     * always {@code null} — but the column exists so monthly lands in 3b without a schema change.
     */
    @Column(name = "by_month_day")
    private Integer byMonthDay;

    /**
     * 3b placeholder (nth weekday of the month, e.g. "2nd Tuesday"). NOT used in v1 — always
     * {@code null} — present so nth-weekday monthly lands in 3b without a schema change.
     */
    @Column(name = "nth_weekday")
    private Integer nthWeekday;

    /**
     * Optional raw RFC-5545 RRULE ({@code null} in v1). The extensibility seam: 3b may store a full
     * rrule here for cadences the structured columns can't express, and the engine would prefer it
     * when present. Kept nullable so v1 (structured DAILY/WEEKLY) never sets it.
     */
    @Column(name = "rrule_raw")
    private String rruleRaw;

    /** IANA timezone id the recurrence is computed in (e.g. {@code "Europe/London"}). */
    @Column(name = "timezone", nullable = false)
    private String timezone;

    /** Anchor: the UTC instant of the first occurrence's start. All later occurrences derive from this. */
    @Column(name = "first_start_at", nullable = false)
    private Instant firstStartAt;

    /**
     * Optional local calendar end of the recurrence (inclusive); {@code null} = open-ended (bounded
     * only by {@link #occurrenceCount} or run indefinitely). Mutually-informative with
     * {@code occurrenceCount}; at most one is typically set.
     */
    @Column(name = "until_date")
    private LocalDate untilDate;

    /** Optional cap on total occurrences; {@code null} = uncapped (bounded by {@link #untilDate} or open). */
    @Column(name = "occurrence_count")
    private Integer occurrenceCount;

    /**
     * Rolling generation watermark: occurrences have been materialised up to (and including) this UTC
     * instant. The engine (TM-790) advances it as it extends the horizon, so a scan knows where to
     * resume. {@code null} = nothing generated yet.
     */
    @Column(name = "horizon_generated_until")
    private Instant horizonGeneratedUntil;

    // ---- Template snapshot (frozen copy of the EventDraft fields) ------------------------------

    @Column(name = "template_heading", nullable = false)
    private String templateHeading;

    @Column(name = "template_description", nullable = false)
    private String templateDescription;

    /** Free-text venue line snapshot — always present, even for online events (e.g. "Online"). */
    @Column(name = "template_location_text", nullable = false)
    private String templateLocationText;

    /** Optional coarse locality snapshot (pre-reveal hint + per-city default key); {@code null} = none. */
    @Column(name = "template_city")
    private String templateCity;

    /** Optional referenced reusable venue id snapshot; {@code null} = one-off free-text location. */
    @Column(name = "template_venue_id")
    private Long templateVenueId;

    /** Max GOING attendees per occurrence; {@code null} = unlimited. */
    @Column(name = "template_capacity")
    private Integer templateCapacity;

    /** Ticket price in pence (minor units, GBP) per occurrence; {@code 0} = free. */
    @Column(name = "template_price_pence", nullable = false)
    private int templatePricePence = Event.DEFAULT_PRICE_PENCE;

    /** Whether occurrences are premium-gated. */
    @Column(name = "template_premium", nullable = false)
    private boolean templatePremium = false;

    /** Optional storage path of the occurrence image; {@code null} = themed placeholder. */
    @Column(name = "template_image_path")
    private String templateImagePath;

    /** Per-occurrence reveal-window override in whole hours before start; {@code null} = inherit. */
    @Column(name = "template_location_reveal_hours")
    private Integer templateLocationRevealHours;

    /** Per-occurrence booking-cutoff override in whole hours before start; {@code null} = inherit. */
    @Column(name = "template_booking_cutoff_hours")
    private Integer templateBookingCutoffHours;

    /** Per-occurrence cancellation-window override in whole hours before start; {@code null} = inherit. */
    @Column(name = "template_cancellation_window_hours")
    private Integer templateCancellationWindowHours;

    // ---- Lifecycle / house columns ------------------------------------------------------------

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    private SeriesStatus status = SeriesStatus.ACTIVE;

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
    protected EventSeries() {
    }

    /**
     * A new {@code ACTIVE} series with the required recurrence anchor + template essentials; the
     * optional recurrence bounds ({@code untilDate}, {@code occurrenceCount}, {@code byWeekday}) and
     * the optional template fields are set separately through the setters.
     */
    public EventSeries(
            SeriesFrequency frequency,
            int interval,
            String timezone,
            Instant firstStartAt,
            String templateHeading,
            String templateDescription,
            String templateLocationText,
            Long createdBy,
            Instant now) {
        this.frequency = frequency;
        this.interval = interval;
        this.timezone = timezone;
        this.firstStartAt = firstStartAt;
        this.templateHeading = templateHeading;
        this.templateDescription = templateDescription;
        this.templateLocationText = templateLocationText;
        this.createdBy = createdBy;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public SeriesFrequency getFrequency() {
        return frequency;
    }

    public void setFrequency(SeriesFrequency frequency) {
        this.frequency = frequency;
    }

    public int getInterval() {
        return interval;
    }

    public void setInterval(int interval) {
        this.interval = interval;
    }

    public Integer getByWeekday() {
        return byWeekday;
    }

    public void setByWeekday(Integer byWeekday) {
        this.byWeekday = byWeekday;
    }

    public Integer getByMonthDay() {
        return byMonthDay;
    }

    public void setByMonthDay(Integer byMonthDay) {
        this.byMonthDay = byMonthDay;
    }

    public Integer getNthWeekday() {
        return nthWeekday;
    }

    public void setNthWeekday(Integer nthWeekday) {
        this.nthWeekday = nthWeekday;
    }

    public String getRruleRaw() {
        return rruleRaw;
    }

    public void setRruleRaw(String rruleRaw) {
        this.rruleRaw = rruleRaw;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public Instant getFirstStartAt() {
        return firstStartAt;
    }

    public void setFirstStartAt(Instant firstStartAt) {
        this.firstStartAt = firstStartAt;
    }

    public LocalDate getUntilDate() {
        return untilDate;
    }

    public void setUntilDate(LocalDate untilDate) {
        this.untilDate = untilDate;
    }

    public Integer getOccurrenceCount() {
        return occurrenceCount;
    }

    public void setOccurrenceCount(Integer occurrenceCount) {
        this.occurrenceCount = occurrenceCount;
    }

    public Instant getHorizonGeneratedUntil() {
        return horizonGeneratedUntil;
    }

    public void setHorizonGeneratedUntil(Instant horizonGeneratedUntil) {
        this.horizonGeneratedUntil = horizonGeneratedUntil;
    }

    public String getTemplateHeading() {
        return templateHeading;
    }

    public void setTemplateHeading(String templateHeading) {
        this.templateHeading = templateHeading;
    }

    public String getTemplateDescription() {
        return templateDescription;
    }

    public void setTemplateDescription(String templateDescription) {
        this.templateDescription = templateDescription;
    }

    public String getTemplateLocationText() {
        return templateLocationText;
    }

    public void setTemplateLocationText(String templateLocationText) {
        this.templateLocationText = templateLocationText;
    }

    public String getTemplateCity() {
        return templateCity;
    }

    public void setTemplateCity(String templateCity) {
        this.templateCity = templateCity;
    }

    public Long getTemplateVenueId() {
        return templateVenueId;
    }

    public void setTemplateVenueId(Long templateVenueId) {
        this.templateVenueId = templateVenueId;
    }

    public Integer getTemplateCapacity() {
        return templateCapacity;
    }

    public void setTemplateCapacity(Integer templateCapacity) {
        this.templateCapacity = templateCapacity;
    }

    public int getTemplatePricePence() {
        return templatePricePence;
    }

    public void setTemplatePricePence(int templatePricePence) {
        this.templatePricePence = templatePricePence;
    }

    public boolean isTemplatePremium() {
        return templatePremium;
    }

    public void setTemplatePremium(boolean templatePremium) {
        this.templatePremium = templatePremium;
    }

    public String getTemplateImagePath() {
        return templateImagePath;
    }

    public void setTemplateImagePath(String templateImagePath) {
        this.templateImagePath = templateImagePath;
    }

    public Integer getTemplateLocationRevealHours() {
        return templateLocationRevealHours;
    }

    public void setTemplateLocationRevealHours(Integer templateLocationRevealHours) {
        this.templateLocationRevealHours = templateLocationRevealHours;
    }

    public Integer getTemplateBookingCutoffHours() {
        return templateBookingCutoffHours;
    }

    public void setTemplateBookingCutoffHours(Integer templateBookingCutoffHours) {
        this.templateBookingCutoffHours = templateBookingCutoffHours;
    }

    public Integer getTemplateCancellationWindowHours() {
        return templateCancellationWindowHours;
    }

    public void setTemplateCancellationWindowHours(Integer templateCancellationWindowHours) {
        this.templateCancellationWindowHours = templateCancellationWindowHours;
    }

    public SeriesStatus getStatus() {
        return status;
    }

    public void setStatus(SeriesStatus status) {
        this.status = status;
    }

    /** {@code true} while the series is live and generating occurrences. */
    public boolean isActive() {
        return status == SeriesStatus.ACTIVE;
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

    /** Bump {@code updatedAt} after edits via the field setters (the caller's responsibility). */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this series has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }
}
