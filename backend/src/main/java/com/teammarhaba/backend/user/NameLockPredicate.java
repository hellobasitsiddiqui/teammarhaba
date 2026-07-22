package com.teammarhaba.backend.user;

/**
 * The name-lock predicate (TM-907): whether a user's first/last name and display name are locked
 * because they now have real-world event history — a GOING spot at a completed event, or a
 * reliability strike (a first-event late cancellation / no-show). Once locked, an <em>already-set</em>
 * name can no longer be changed by the user (the identity people met, and the reliability record
 * pinned to it, can't be laundered by a rename); an admin can still correct it with an audit trail.
 *
 * <p>Deliberately an interface in the {@code user} package, implemented in {@code event}
 * ({@code NameLockService}), so the enforcement point ({@link UserService}) stays free of an
 * {@code event}-package import: the fact source (attendance + reliability) depends on {@code user},
 * not the other way round. Spring injects the single implementation by type.
 *
 * <p><b>Derived-live, not stamped.</b> Implementations compute this at each name write from live
 * event history — so an existing user with qualifying history is locked immediately at rollout with
 * no backfill migration (TM-907's retroactive decision falls out for free), and a user's lock can
 * never drift out of sync with a stamped column.
 */
public interface NameLockPredicate {

    /**
     * Whether {@code user}'s name is locked by their event history. A brand-new user with no history
     * returns {@code false} (renames freely — current behaviour); a user who has held a GOING spot at
     * a finished event, or carries a reliability strike, returns {@code true}.
     */
    boolean isNameLocked(User user);
}
