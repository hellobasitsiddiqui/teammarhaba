-- V48__users_phone_unique — defence-in-depth uniqueness for the verified phone (TM-931, subticket B
-- of TM-923). One versioned migration in two ordered steps: (a) dedup existing rows so the index can
-- be built, then (b) create the unique partial index on the normalized phone.
--
-- WHY normalized: users.phone is stored E.164 but the stored pattern (UserService.E164_PHONE /
-- OnboardingRequest.phone) permits separators (' ', '(', ')', '.', '/', '-') between digits, so two
-- accounts could hold the SAME number in different shapes ("+44 20 7946 0958" vs "+442079460958").
-- The index key strips every non [0-9+] character (regexp_replace(phone, '[^0-9+]', '', 'g')) so those
-- collide as one number. Scoped WHERE phone IS NOT NULL AND deleted_at IS NULL so absent phones and
-- soft-deleted (tombstoned) accounts never participate in — or block — uniqueness.
--
-- (a) DEDUP. Existing rows may already hold duplicate self-reported numbers (phone was non-unique and
-- unverified before this ticket), which would break CREATE UNIQUE INDEX. Per normalized-phone group
-- over ACTIVE rows only (deleted_at IS NULL), keep the phone on exactly ONE deterministic winner —
-- most recent last_active_at (NULLS LAST, so an account that has actually used the API beats one that
-- never has), tie-break lowest id — and NULL out users.phone on every loser.
--
-- A NULLed loser is DELIBERATE and aligned with subticket C (TM-932): an active account with no
-- stored E.164 phone is exactly what the TM-880 completion gate (UserService.requirePhoneOnRecord /
-- the client's needsPhoneNumber router) re-routes back through #/onboarding, where C's forced
-- re-verify makes them prove the number over OTP. So dedup doesn't lose the account — it re-gates it.
UPDATE users
   SET phone = NULL
 WHERE deleted_at IS NULL
   AND phone IS NOT NULL
   AND id NOT IN (
       SELECT DISTINCT ON (regexp_replace(phone, '[^0-9+]', '', 'g')) id
         FROM users
        WHERE deleted_at IS NULL
          AND phone IS NOT NULL
        ORDER BY regexp_replace(phone, '[^0-9+]', '', 'g'),
                 last_active_at DESC NULLS LAST,
                 id ASC
   );

-- (b) The defence-in-depth unique index. Guarantees one verified number maps to exactly one active
-- account at the DB layer, so the TM-923 uniqueness promise holds even if a future code path forgets
-- to check. A mirror-write that trips this surfaces as DataIntegrityViolationException and is mapped
-- to a 409 "already registered" by GlobalExceptionHandler (scoped by this index name).
CREATE UNIQUE INDEX users_phone_normalized_uq
    ON users ((regexp_replace(phone, '[^0-9+]', '', 'g')))
 WHERE phone IS NOT NULL AND deleted_at IS NULL;
