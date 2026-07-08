/**
 * Admin → user messaging (epic TM-432, {@code group-admin-messaging}).
 *
 * <p>This package is the home of the admin-messaging domain: targeting a message at an audience,
 * creating the per-campaign conversation, and the sent-history/inbox reads. It grows wave by wave;
 * the <strong>root</strong> piece (wave-0, TM-440) is <em>recipient resolution</em> — turning an
 * {@link com.teammarhaba.backend.messaging.AudienceSpec audience spec} (a user, a city, or one/many
 * events' GOING attendees) into the concrete, distinct set of active {@code users.id} values a send
 * should reach. That resolver ({@link com.teammarhaba.backend.messaging.RecipientResolver}) is a
 * pure read: it owns no schema of its own and only reads the existing {@code users} and
 * {@code event_attendance} tables through their repositories, so soft-delete and de-duplication are
 * enforced exactly once, in one place, for every downstream sender to reuse.
 *
 * <p>The admin send endpoint (TM-441) is the first consumer: it resolves an audience here, then
 * persists the campaign + membership + message and fans out push. Keeping resolution separate from
 * sending is deliberate — it is the single unit-testable rule for "who receives this", independent
 * of any transport.
 */
package com.teammarhaba.backend.messaging;
