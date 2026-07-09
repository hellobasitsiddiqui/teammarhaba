package com.teammarhaba.backend.messaging;

/**
 * The single audience dimension an admin send targeted (TM-441, epic TM-432). A send picks
 * <em>exactly one</em> target type — a product rule enforced at the API edge ({@code
 * AdminMessageRequest}), even though {@link AudienceSpec}/{@link RecipientResolver} could handle a
 * combined spec. Persisted on {@code admin_message.target_type} by {@code name()} (stored as VARCHAR,
 * same convention as {@code users.role}), so values may be added but existing names must never be
 * renamed/removed — old campaign rows keep referencing them.
 *
 * <ul>
 *   <li>{@code USER} — an explicit set of account ids (the "message these people" case).
 *   <li>{@code CITY} — everyone whose profile city matches (city-wide send).
 *   <li>{@code EVENT} — the {@code GOING} attendees of one or more events (a guest list).
 * </ul>
 */
public enum TargetType {
    USER,
    CITY,
    EVENT
}
