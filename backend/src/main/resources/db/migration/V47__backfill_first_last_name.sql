-- V47__backfill_first_last_name — seed first/last name for existing accounts (TM-883)
--
-- The first-login onboarding gate (TM-250) captured a single full name and stored it ONLY as
-- display_name, so every account that onboarded before the TM-883 fix has first_name/last_name
-- NULL — the profile identity header and edit form have no first/last name to show. The service
-- now seeds both at capture time; this one-time data backfill applies the same split to the rows
-- that already exist: first word → first_name, remainder → last_name (single word → first_name
-- only), mirroring UserService.completeProfileOnboarding.
--
-- Guards (deliberately conservative — skipping a row is benign, it just keeps today's
-- display_name fallback in the identity header):
--   * only rows where BOTH parts are still NULL — a first/last name a user set themselves via
--     PATCH /me is their own correction and is never overwritten by this heuristic;
--   * only a "name-like" display_name (letters/spaces/periods/apostrophes/hyphens, per the TM-771
--     rule on first/last name inputs) — display_name itself is unconstrained free text, and
--     backfilling e.g. a digit-y value would pre-fill the edit form with input its own validation
--     rejects.
UPDATE users
SET first_name = split_part(btrim(display_name), ' ', 1),
    last_name  = CASE
                     WHEN position(' ' IN btrim(display_name)) = 0 THEN NULL
                     ELSE NULLIF(btrim(substr(btrim(display_name), position(' ' IN btrim(display_name)) + 1)), '')
                 END
WHERE first_name IS NULL
  AND last_name IS NULL
  AND display_name IS NOT NULL
  AND btrim(display_name) ~ '^[[:alpha:]][[:alpha:] .''’-]*$';
