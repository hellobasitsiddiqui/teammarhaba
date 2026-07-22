-- V48__dedup_phone_and_unique_index — verified-phone uniqueness at the DB (TM-934, subticket E of TM-923)
--
-- TM-923 makes the mandatory phone OTP-verified + unique (strict 1:1) via Firebase phone-credential
-- linking. This migration lands the DB half of that contract — a normalized-phone partial UNIQUE
-- index — and moved here from TM-931/B (see the 2026-07-21 scope-change note on TM-934) so the index
-- and the e2e fixtures that make it satisfiable ship together.
--
-- Normalization: users.phone is stored as lenient E.164 free text (V5) — a leading '+' then 7–15
-- digits with separators (space, parens, dot, slash, dash) permitted BETWEEN digits (UserService
-- .E164_PHONE / UpdateMeRequest). So "+44 7700 900123" and "+447700900123" are the SAME number stored
-- two ways. The uniqueness key must therefore compare the digits only — strip every non-digit
-- (including the '+', which is always leading) via regexp_replace(phone, '[^0-9]', '', 'g'). Two rows
-- whose phones differ only by separator/'+' formatting collide, which is exactly what 1:1 requires.
--
-- Scope of uniqueness: only ACTIVE, non-soft-deleted rows with a phone on record. A partial index
-- WHERE phone IS NOT NULL AND deleted_at IS NULL — so NULL phones never collide (many accounts have
-- no phone yet), and a soft-deleted account's number is freed for a live account to (re)claim.

-- ---------------------------------------------------------------------------
-- Step 1 — DEDUP: NULL the losers in each normalized-phone group among active, non-deleted rows.
--
-- Before a UNIQUE index can be created it must already hold. Existing data may contain duplicate
-- phones (the pre-uniqueness world — e.g. every e2e persona shared +447700900123). For each group of
-- active rows sharing a normalized phone, keep a DETERMINISTIC winner and NULL the phone on the rest.
--
-- Winner rule (deterministic, re-runnable): the row with the SMALLEST id (oldest account) wins; all
-- others in the group have their phone set to NULL. Soft-deleted rows (deleted_at IS NOT NULL) are
-- NOT considered here at all — they're outside the partial index, so they neither win nor lose and
-- keep their phone untouched (a soft-deleted row sharing a number with a live one does not force the
-- live one to be NULLed). id is the users PK (see V1__init) and is never NULL, so the ordering is
-- total and the winner is unambiguous.
UPDATE users u
SET phone = NULL
WHERE u.phone IS NOT NULL
  AND u.deleted_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM users w
      WHERE w.deleted_at IS NULL
        AND w.phone IS NOT NULL
        AND regexp_replace(w.phone, '[^0-9]', '', 'g') = regexp_replace(u.phone, '[^0-9]', '', 'g')
        AND w.id < u.id
  );

-- ---------------------------------------------------------------------------
-- Step 2 — the partial UNIQUE index on the normalized phone, scoped to active, non-deleted rows.
--
-- CONCURRENTLY is deliberately NOT used: Flyway runs each migration in a transaction and CREATE INDEX
-- CONCURRENTLY cannot run inside one. Table volume is small; a brief lock is acceptable. The
-- expression must match Step 1's normalization exactly so the dedup guarantees the index can build.
CREATE UNIQUE INDEX users_phone_normalized_uq
    ON users (regexp_replace(phone, '[^0-9]', '', 'g'))
    WHERE phone IS NOT NULL AND deleted_at IS NULL;
