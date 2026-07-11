package com.teammarhaba.backend.event;

/**
 * Whether a {@link Venue} is an indoor space, an outdoor space, or a mix of both (TM-519). An
 * optional detail of a venue — {@code null} on the entity means "unspecified" — persisted as its
 * {@code name()} via Hibernate {@code EnumType.STRING} (the same convention as {@link EventStatus}),
 * so new values can be added without a DB type change. Old rows keep referencing existing names, so
 * values may be added but never renamed/removed.
 */
public enum IndoorOutdoor {

    /** A fully enclosed/indoor space (hall, café, hired room). */
    INDOOR,

    /** An open-air/outdoor space (park, garden, courtyard). */
    OUTDOOR,

    /** A place with both indoor and outdoor areas (e.g. a venue with a garden). */
    MIXED
}
