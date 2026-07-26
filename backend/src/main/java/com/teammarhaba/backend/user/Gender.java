package com.teammarhaba.backend.user;

/**
 * A user's self-reported gender (TM-955). A small, closed set of buckets — enough for the TM-832
 * interests M/F split and future segmentation, without pretending to be an exhaustive taxonomy.
 *
 * <p>Stored on the {@code users} row by {@code name()} via {@code EnumType.STRING} (the same
 * convention as {@link Role} and {@link NotificationPref}), so values may be <em>added</em> but
 * existing names must not be renamed/removed. The {@code gender} column is <strong>nullable</strong>:
 * {@code null} = unknown, which is the state of every legacy / pre-existing account (rows created
 * before this field existed, and any account provisioned just-in-time without going through the
 * onboarding gate). {@link #PREFER_NOT_TO_SAY} is a <em>deliberate</em> choice the user made — it is
 * NOT the same as {@code null} (never chose).
 *
 * <p>Required at onboarding (TM-955): a user must pick one of these three (including "prefer not to
 * say") to complete the atomic onboarding gate, exactly as phone is required (TM-880). Editable later
 * in Profile. PRIVATE: returned on {@code GET /me} and editable in the user's own profile, used for
 * the interests split (TM-832) — but never rendered on the public profile ({@code #/profile/public}).
 */
public enum Gender {
    FEMALE,
    MALE,
    PREFER_NOT_TO_SAY;
}
