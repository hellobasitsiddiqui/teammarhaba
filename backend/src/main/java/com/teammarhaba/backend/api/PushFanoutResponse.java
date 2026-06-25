package com.teammarhaba.backend.api;

import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;

/**
 * The result of the manual test-push trigger {@code POST /api/v1/admin/users/{id}/test-push} (TM-284),
 * so an admin can see how a real send fanned out across the account's devices: how many were targeted,
 * accepted by FCM, pruned (token reported unregistered), or left after a transient failure.
 *
 * @param targeted  devices attempted (the user's registered tokens at send time)
 * @param delivered tokens FCM accepted
 * @param pruned    tokens removed because FCM reported them unregistered/invalid
 * @param failed    tokens that hit a transient/other error and were kept
 */
public record PushFanoutResponse(int targeted, int delivered, int pruned, int failed) {

    static PushFanoutResponse from(PushFanout fanout) {
        return new PushFanoutResponse(
                fanout.targeted(), fanout.delivered(), fanout.pruned(), fanout.failed());
    }
}
