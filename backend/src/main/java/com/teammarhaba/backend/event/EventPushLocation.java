package com.teammarhaba.backend.event;

import java.time.Instant;
import org.springframework.stereotype.Component;

/**
 * The single place a push decides how to show an event's location (TM-416). Both notify lanes — the
 * {@link EventReminderService} T-24h/T-1h reminders (TM-394) and the {@link EventLifecycleNotifier}
 * "location changed" update (TM-397) — route their location line through here so the exact venue is
 * only ever put on the wire once {@link LocationRevealPolicy} says the reveal window has opened.
 *
 * <p>Before reveal ({@code now < revealsAt}) the exact address/map link is withheld exactly as the
 * public events API withholds it (TM-408, {@code EventQueryService}); a push shows honest placeholder
 * copy that names <em>when</em> the venue unlocks rather than the venue itself. This closes the leak
 * a shorter-than-default reveal window would otherwise open: an event revealing at T-2h would embed
 * its address in the T-24h reminder without this gate. After reveal the venue is shown as before.
 *
 * <p>Keeping the reveal decision and the placeholder copy here — not at each call site — is the
 * ticket's "one shared helper, not per-call logic": the resolver stays a pure time calculation
 * ({@link LocationRevealPolicy}) and this component is the one adapter from "is it revealed" to
 * "what may a push say".
 */
@Component
public class EventPushLocation {

    private final LocationRevealPolicy reveal;

    public EventPushLocation(LocationRevealPolicy reveal) {
        this.reveal = reveal;
    }

    /**
     * Whether the exact venue is safe to put in a push at {@code now}. Callers that compose their own
     * sentence around the venue (the lifecycle "now at …" line) branch on this; callers that just want
     * the location slot filled use {@link #line}.
     */
    public boolean isRevealed(Event event, Instant now) {
        return reveal.isRevealed(event, now);
    }

    /**
     * The location line a push may show for {@code event} at {@code now}: the exact
     * {@link Event#getLocationText() venue} once the reveal window has opened, otherwise honest
     * placeholder copy that never names the address or map link.
     */
    public String line(Event event, Instant now) {
        return reveal.isRevealed(event, now) ? event.getLocationText() : placeholder(event);
    }

    /**
     * Honest pre-reveal copy, e.g. {@code "Location shared ~24h before — check the app"}. It uses the
     * event's own resolved window, so a 2h-reveal event says {@code ~2h} and the shipped default says
     * {@code ~24h}; a zero-hour window degrades to {@code "shortly before"} rather than {@code ~0h}.
     */
    private String placeholder(Event event) {
        int hours = reveal.revealHoursFor(event);
        String window = hours <= 0 ? "shortly before" : "~" + hours + "h before";
        return "Location shared " + window + " — check the app";
    }
}
