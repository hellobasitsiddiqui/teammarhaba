package com.teammarhaba.backend.event;

import com.teammarhaba.backend.user.NameLockPredicate;
import com.teammarhaba.backend.user.User;
import java.time.Instant;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The {@link NameLockPredicate} implementation (TM-907): derives, live from event history, whether a
 * user's first/last/display name is locked. Lives in {@code event} because it reads the attendance +
 * reliability facts this package owns; {@link com.teammarhaba.backend.user.UserService} enforces the
 * lock against it through the {@code user}-package interface, so the enforcement point never imports
 * {@code event}.
 *
 * <p><b>Lock trigger (Basit's 2026-07-20 decision):</b> a user is locked once they have real-world
 * event history —
 *
 * <ul>
 *   <li><b>first GOING at a completed event</b> — they held (or hold) a {@code GOING} spot on an
 *       event that has already finished ({@link EventAttendanceRepository#hasGoingAtFinishedEvent},
 *       "finished" per {@link EventPhasePolicy#isFinished}); or</li>
 *   <li><b>a first-event no-show</b> — surfaced through the reliability record: a
 *       late-cancellation strike ({@code users.late_cancel_count > 0}, TM-414/TM-409), the only
 *       server-side "committed then didn't turn up / bailed inside the window" signal the RSVP/cancel
 *       lifecycle produces. There is no distinct check-in/no-show fact yet (TM-673 QR would add one),
 *       so the strike counter is the reliability integrity signal the lock protects.</li>
 * </ul>
 *
 * <p><b>Derived-live, retroactive by construction.</b> Nothing is stamped: the predicate is recomputed
 * at each name write, so an existing user with qualifying history is locked immediately at rollout with
 * no backfill (the retroactive decision) and a user can never be locked/unlocked out of step with a
 * column. The GOING-at-finished check is a single indexed count query; the strike check is a field read
 * already loaded on the entity.
 */
@Service
public class NameLockService implements NameLockPredicate {

    private final EventAttendanceRepository attendance;
    private final EventPhasePolicy phasePolicy;

    public NameLockService(EventAttendanceRepository attendance, EventPhasePolicy phasePolicy) {
        this.attendance = attendance;
        this.phasePolicy = phasePolicy;
    }

    /**
     * Whether {@code user}'s name is locked by their event history — see the class note for the exact
     * trigger. The reliability-strike arm is checked first (a cheap in-memory field read on the already
     * loaded entity) so a user with a strike never pays for the attendance query; only a strike-free
     * user runs the GOING-at-finished-event count. Read-only and safe inside the caller's write
     * transaction (propagation defaults to REQUIRED); a brand-new user with no history returns
     * {@code false} and renames freely.
     */
    @Override
    @Transactional(readOnly = true)
    public boolean isNameLocked(User user) {
        if (user == null || user.getId() == null) {
            return false; // an unprovisioned user has no history — never locked
        }
        // A reliability strike (late cancel / first-event no-show, TM-409/TM-414) is real event
        // history that pinned a record to this identity — lock. Cheap field read; check it first.
        if (user.getLateCancelCount() > 0) {
            return true;
        }
        Instant now = Instant.now();
        return attendance.hasGoingAtFinishedEvent(user.getId(), now, phasePolicy.openEndedStartFloor(now));
    }
}
