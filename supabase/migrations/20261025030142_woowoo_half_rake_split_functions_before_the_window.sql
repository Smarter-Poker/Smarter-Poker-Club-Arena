-- 20261025030142_woowoo_half_rake_split_functions_before_the_window.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.12):
--
-- Owner ruling (Dan, 2026-10-24): half of WooWoo's earned cash rake is removed
-- from his credit and given to KingFish. 20261024223153 (applied straight to
-- production, recorded byte-exact in this repo) carried that rule as a pg_cron
-- job, 'woowoo-half-rake-to-kingfish', recomputing every five minutes. A job
-- that adjusts a figure after the fact is exactly what 10.12 forbids, and it
-- is measurably wrong between ticks: read 2026-10-25 03:01 UTC, the stored
-- 2026-10-25 rows said 7851 cents while the hands already written said 7878.
--
-- The rule stays, with its exact numbers. The mechanism moves to write time:
-- the split is recorded in the same transaction that writes WooWoo's hand
-- fact, so the reporting rows are never behind the hands.
--
-- This file installs only the two functions. Neither takes a lock on a live
-- table (CREATE FUNCTION locks nothing in public.ca_hand_facts), so it goes
-- through the ordinary applier. The triggers that call them need SHARE ROW
-- EXCLUSIVE on public.ca_hand_facts, a hot table (~51 inserts a second,
-- 30,574 rows in the ten minutes to 2026-10-25 02:58 UTC), so they are in the
-- queued daily-window migration 20261025030249, which also retires the job.
-- Until that window both functions exist and nothing calls them.
--
-- THE RULE, UNCHANGED FROM 20261024223153:
--   scope   every public.ca_hand_facts row of WooWoo
--           (69f2cefa-017d-49f3-ac3e-61505633747c) with tournament_id IS NULL
--           and played_at > 2026-10-24 22:21:59.97593+00 (the first cut).
--           No ca_hand_facts.club_id filter, exactly as the job: WooWoo's cash
--           facts carry the union club (Midway Union) while he is funded by
--           KINGS CLUB, and the job counted every cash fact.
--   day     (played_at AT TIME ZONE 'UTC')::date.
--   amount  round(sum(coalesce(rake_paid, 0)) * 50)::bigint cents per day,
--           rounded once on the day total, never per hand.
--   rows    'woowoo-half-split-<day>'          +half  WooWoo, KINGS CLUB
--           'kingfish-from-woowoo-split-<day>' -half  KingFish
--           (47965354-0e56-43ef-931c-ddaab82af765), KINGS CLUB
--           in smarter_private.player_fee_redemptions, same reasons, same keys.
--   zero    a day whose half is <= 0 writes nothing and leaves an existing
--           row as it is, exactly as the job did (amount_cents <> 0 is a
--           CHECK on the table).
-- Reporting only: fee redemptions adjust earned-rake / fee displays; no chips
-- move. The rule names one user by id and never reads is_horse (10.5).
--
-- WHY A RECOUNT, NOT AN INCREMENT. The day amount is rounded on the day total,
-- so an increment of a rounded half loses the half cent the job keeps. The
-- trigger recounts the day (~100-200 facts, index
-- ca_hand_facts_cash_member_time_idx) and writes the same number the job would.
--
-- WHY IT CANNOT MISS A CONCURRENT HAND. WooWoo can sit at several tables, so
-- two of his facts can commit at once. The first writer of a day creates its
-- row with INSERT ... ON CONFLICT DO NOTHING; every other writer finds the row,
-- takes it FOR UPDATE (waiting for whoever holds it to commit) and only then
-- recounts, in a new statement whose READ COMMITTED snapshot includes what the
-- holder committed. The last writer to commit therefore always writes the full
-- day. No advisory lock and no new table: the day row is the lock.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (to_regprocedure('smarter_private.fn_woowoo_half_rake_day_cents(date)') IS NOT NULL AND to_regprocedure('smarter_private.tr_woowoo_half_rake_split()') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (to_regprocedure('smarter_private.fn_woowoo_half_rake_day_cents(date)'), to_regprocedure('smarter_private.tr_woowoo_half_rake_split()')) AND (has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE'))))

BEGIN;
SET LOCAL lock_timeout = '2s';

-- The day amount, in cents: the job's own expression, restricted to one UTC day.
CREATE OR REPLACE FUNCTION smarter_private.fn_woowoo_half_rake_day_cents(p_day date)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, smarter_private, pg_temp
AS $day$
  SELECT coalesce(round(sum(coalesce(f.rake_paid, 0)) * 50), 0)::bigint
    FROM public.ca_hand_facts f
   WHERE f.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
     AND f.tournament_id IS NULL
     AND f.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz
     AND f.played_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND f.played_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
$day$;

REVOKE ALL ON FUNCTION smarter_private.fn_woowoo_half_rake_day_cents(date) FROM PUBLIC, anon, authenticated;

-- Fired by the three row triggers 20261025030249 creates on public.ca_hand_facts.
-- Their WHEN clauses already restrict it to WooWoo's cash facts after the cut;
-- the checks below repeat them so the function is right on its own.
CREATE OR REPLACE FUNCTION smarter_private.tr_woowoo_half_rake_split()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, smarter_private, pg_temp
AS $split$
DECLARE
  c_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_woowoo constant uuid := '69f2cefa-017d-49f3-ac3e-61505633747c';
  c_kingfish constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_cutoff constant timestamptz := '2026-10-24 22:21:59.97593+00';
  c_woowoo_reason constant text := 'Owner-directed standing rule (Dan, 2026-10-24): half of WooWoo''s earned rake for this day is removed from his credit and given to KingFish.';
  c_kingfish_reason constant text := 'Owner-directed standing rule (Dan, 2026-10-24): KingFish is credited with the half of WooWoo''s earned rake removed for this day.';
  v_days date[] := ARRAY[]::date[];
  v_day date;
  v_key text;
  v_half bigint;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.user_id = c_woowoo AND OLD.tournament_id IS NULL AND OLD.played_at > c_cutoff THEN
      v_days := v_days || (OLD.played_at AT TIME ZONE 'UTC')::date;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.user_id = c_woowoo AND NEW.tournament_id IS NULL AND NEW.played_at > c_cutoff THEN
      v_days := v_days || (NEW.played_at AT TIME ZONE 'UTC')::date;
    END IF;
  END IF;

  -- Days in order, so a fact moved across days can never deadlock another.
  FOR v_day IN SELECT DISTINCT d FROM unnest(v_days) AS d ORDER BY 1 LOOP
    v_key := to_char(v_day, 'YYYY-MM-DD');

    -- The first writer of a day creates both rows.
    SELECT smarter_private.fn_woowoo_half_rake_day_cents(v_day) INTO v_half;
    IF v_half > 0 THEN
      INSERT INTO smarter_private.player_fee_redemptions
             (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
      VALUES ('woowoo-half-split-' || v_key, c_club, c_woowoo, v_day, v_half, c_woowoo_reason, now())
      ON CONFLICT (operation_key) DO NOTHING;
      IF FOUND THEN
        INSERT INTO smarter_private.player_fee_redemptions AS r
               (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
        VALUES ('kingfish-from-woowoo-split-' || v_key, c_club, c_kingfish, v_day, -v_half, c_kingfish_reason, now())
        ON CONFLICT (operation_key) DO UPDATE
          SET amount_cents = EXCLUDED.amount_cents, recorded_at = now()
          WHERE r.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents;
        CONTINUE;
      END IF;
    END IF;

    -- The day row exists: wait for whoever holds it, then recount with what
    -- they committed (a new statement, so a new READ COMMITTED snapshot).
    PERFORM 1 FROM smarter_private.player_fee_redemptions
      WHERE operation_key = 'woowoo-half-split-' || v_key
      FOR UPDATE;
    CONTINUE WHEN NOT FOUND;   -- no row and nothing to split: as the job
    SELECT smarter_private.fn_woowoo_half_rake_day_cents(v_day) INTO v_half;
    CONTINUE WHEN v_half <= 0; -- the job never wrote a non-positive day

    UPDATE smarter_private.player_fee_redemptions
       SET amount_cents = v_half, recorded_at = now()
     WHERE operation_key = 'woowoo-half-split-' || v_key
       AND amount_cents IS DISTINCT FROM v_half;
    INSERT INTO smarter_private.player_fee_redemptions AS r
           (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
    VALUES ('kingfish-from-woowoo-split-' || v_key, c_club, c_kingfish, v_day, -v_half, c_kingfish_reason, now())
    ON CONFLICT (operation_key) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents, recorded_at = now()
      WHERE r.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents;
  END LOOP;

  RETURN NULL;
END;
$split$;

REVOKE ALL ON FUNCTION smarter_private.tr_woowoo_half_rake_split() FROM PUBLIC, anon, authenticated;

COMMIT;
