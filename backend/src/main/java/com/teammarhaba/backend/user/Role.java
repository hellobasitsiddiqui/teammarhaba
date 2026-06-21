package com.teammarhaba.backend.user;

/**
 * Account role. Carried on the Firebase ID token as a custom claim (set/enforced in TM-110)
 * and mirrored onto the {@code users} row. {@code USER} is the default for every new account;
 * {@code ADMIN} unlocks the admin surface (TM-111).
 */
public enum Role {
    USER,
    ADMIN
}
