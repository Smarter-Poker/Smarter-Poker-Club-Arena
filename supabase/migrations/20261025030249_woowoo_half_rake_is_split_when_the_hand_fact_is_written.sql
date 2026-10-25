-- @install-window: daily-maintenance
-- 20261025030249_woowoo_half_rake_is_split_when_the_hand_fact_is_written.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.12):
--
-- Owner ruling (Dan, 2026-10-24): half of WooWoo's earned cash rake is removed
-- from his credit and given to KingFish. 20261024223153 carried it as the
-- pg_cron job 'woowoo-half-rake-to-kingfish' (*/5), which recomputed the day
-- rows in smarter_private.player_fee_redemptions after the fact. This file
-- moves the same rule to write time and retires the job:
--
--   1. three row triggers on public.ca_hand_facts (INSERT; UPDATE OF user_id,
--      tournament_id, played_at, rake_paid; DELETE), each with a WHEN clause
--      that admits only WooWoo's cash facts after the first cut, call
--      smarter_private.tr_woowoo_half_rake_split() (20261025030142). Every
--      other fact - about 51 a second - is filtered in the WHEN clause and
--      never reaches PL/pgSQL. UPDATE and DELETE are covered because
--      ca_append_hand_fact_revision corrects rake_paid and voids facts, and
--      the job's recount saw those too;
--   2. the job is unscheduled and fn_woowoo_half_rake_to_kingfish_sync() is
--      dropped;
--   3. the day rows are written once from the rule, under the trigger lock,
--      so the hands between the job's last tick and this commit are counted
--      (the job's own final pass, not a new repair: nothing runs again);
--   4. the transaction aborts unless every day row equals the rule.
--
-- WHY THE DAILY WINDOW. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- public.ca_hand_facts, which blocks its writers. It is a hot table: 30,574
-- rows were written in the ten minutes to 2026-10-25 02:58 UTC (~51/s), every
-- hand commit writes it, and 57 GB / ~74M rows sit in it. CLAUDE.md section 2
-- rule 10: such a migration is installed only inside the 04:00
-- America/Chicago freeze. Holding that lock to COMMIT is also what makes step
-- 3 exact: no fact can be written between the cutover count and the triggers.
--
-- Equality, measured against production before this was written: the job's
-- GROUP BY day sum and the per-day function body agree on every day since the
-- cut (read-only SELECT at 03:01 UTC: 2026-10-24 4474 = 4474, 2026-10-25
-- 7878 = 7878; read-only probe moments later: 4474 = 4474, 8092 = 8092). At
-- 03:01 the stored 2026-10-25 rows said 7851 while the hands said 7878 - the
-- five-minute staleness this removes.
--
-- Reporting only: no chips move. The rule names one user by id and never
-- reads is_horse (10.5). Amounts stay bigint cents.
--
-- @live-proof: (NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'woowoo-half-rake-to-kingfish') AND to_regprocedure('smarter_private.fn_woowoo_half_rake_to_kingfish_sync()') IS NULL)
-- @live-proof: ((SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.ca_hand_facts'::regclass AND tgname IN ('ca_hand_facts_woowoo_half_rake_split_insert', 'ca_hand_facts_woowoo_half_rake_split_update', 'ca_hand_facts_woowoo_half_rake_split_delete') AND tgenabled = 'O' AND tgfoid = 'smarter_private.tr_woowoo_half_rake_split()'::regprocedure) = 3)
-- @live-proof: NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT (f.played_at AT TIME ZONE 'UTC')::date AS day FROM public.ca_hand_facts f WHERE f.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c' AND f.tournament_id IS NULL AND f.played_at > '2026-10-24 22:21:59.97593+00') d CROSS JOIN LATERAL (SELECT smarter_private.fn_woowoo_half_rake_day_cents(d.day) AS half) h WHERE h.half > 0 AND ((SELECT amount_cents FROM smarter_private.player_fee_redemptions WHERE operation_key = 'woowoo-half-split-' || to_char(d.day, 'YYYY-MM-DD')) IS DISTINCT FROM h.half OR (SELECT amount_cents FROM smarter_private.player_fee_redemptions WHERE operation_key = 'kingfish-from-woowoo-split-' || to_char(d.day, 'YYYY-MM-DD')) IS DISTINCT FROM -h.half))

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The functions come from the ordinary migration 20261025030142. Without them
-- this refuses, rolls back, and stays queued for the next window.
DO $needs$
BEGIN
  IF to_regprocedure('smarter_private.tr_woowoo_half_rake_split()') IS NULL
     OR to_regprocedure('smarter_private.fn_woowoo_half_rake_day_cents(date)') IS NULL THEN
    RAISE EXCEPTION 'woowoo half rake split: 20261025030142 is not installed yet';
  END IF;
END
$needs$;

-- 1. The rule at write time.
CREATE TRIGGER ca_hand_facts_woowoo_half_rake_split_insert
  AFTER INSERT ON public.ca_hand_facts
  FOR EACH ROW
  WHEN (NEW.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
        AND NEW.tournament_id IS NULL
        AND NEW.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz)
  EXECUTE FUNCTION smarter_private.tr_woowoo_half_rake_split();

CREATE TRIGGER ca_hand_facts_woowoo_half_rake_split_update
  AFTER UPDATE OF user_id, tournament_id, played_at, rake_paid ON public.ca_hand_facts
  FOR EACH ROW
  WHEN ((OLD.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
         AND OLD.tournament_id IS NULL
         AND OLD.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz)
        OR (NEW.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
         AND NEW.tournament_id IS NULL
         AND NEW.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz))
  EXECUTE FUNCTION smarter_private.tr_woowoo_half_rake_split();

CREATE TRIGGER ca_hand_facts_woowoo_half_rake_split_delete
  AFTER DELETE ON public.ca_hand_facts
  FOR EACH ROW
  WHEN (OLD.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
        AND OLD.tournament_id IS NULL
        AND OLD.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz)
  EXECUTE FUNCTION smarter_private.tr_woowoo_half_rake_split();

-- 2. The after-the-fact job is gone.
DO $unschedule$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'woowoo-half-rake-to-kingfish') THEN
    PERFORM cron.unschedule('woowoo-half-rake-to-kingfish');
  END IF;
END
$unschedule$;

DROP FUNCTION IF EXISTS smarter_private.fn_woowoo_half_rake_to_kingfish_sync();

-- 3. Cutover: the day rows from the rule, once, while the trigger lock keeps
--    every fact writer out. Same keys, same reasons, same skip of a
--    non-positive day as the trigger and the retired job.
DO $cutover$
DECLARE
  c_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_woowoo constant uuid := '69f2cefa-017d-49f3-ac3e-61505633747c';
  c_kingfish constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  d record;
BEGIN
  FOR d IN
    SELECT x.day, smarter_private.fn_woowoo_half_rake_day_cents(x.day) AS half_cents
      FROM (SELECT DISTINCT (f.played_at AT TIME ZONE 'UTC')::date AS day
              FROM public.ca_hand_facts f
             WHERE f.user_id = c_woowoo AND f.tournament_id IS NULL
               AND f.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz) x
     ORDER BY 1
  LOOP
    CONTINUE WHEN d.half_cents <= 0;
    INSERT INTO smarter_private.player_fee_redemptions AS r
           (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
    VALUES ('woowoo-half-split-' || to_char(d.day, 'YYYY-MM-DD'), c_club, c_woowoo, d.day, d.half_cents,
            'Owner-directed standing rule (Dan, 2026-10-24): half of WooWoo''s earned rake for this day is removed from his credit and given to KingFish.', now()),
           ('kingfish-from-woowoo-split-' || to_char(d.day, 'YYYY-MM-DD'), c_club, c_kingfish, d.day, -d.half_cents,
            'Owner-directed standing rule (Dan, 2026-10-24): KingFish is credited with the half of WooWoo''s earned rake removed for this day.', now())
    ON CONFLICT (operation_key) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents, recorded_at = now()
      WHERE r.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents;
  END LOOP;
END
$cutover$;

-- 4. Prove it, or roll all of it back.
DO $assert$
DECLARE
  v_bad text;
  v_days int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'woowoo-half-rake-to-kingfish') THEN
    RAISE EXCEPTION 'woowoo half rake split: the cron job is still scheduled';
  END IF;
  IF to_regprocedure('smarter_private.fn_woowoo_half_rake_to_kingfish_sync()') IS NOT NULL THEN
    RAISE EXCEPTION 'woowoo half rake split: the sync function still exists';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.ca_hand_facts'::regclass
         AND tgname IN ('ca_hand_facts_woowoo_half_rake_split_insert',
                        'ca_hand_facts_woowoo_half_rake_split_update',
                        'ca_hand_facts_woowoo_half_rake_split_delete')
         AND tgenabled = 'O') <> 3 THEN
    RAISE EXCEPTION 'woowoo half rake split: the three write-time triggers are not all installed';
  END IF;

  -- Every day: the stored rows equal the job's own GROUP BY expression.
  SELECT count(*),
         string_agg(format('%s rule=%s woowoo=%s kingfish=%s', s.day, s.half_cents, w.amount_cents, k.amount_cents), '; ')
           FILTER (WHERE w.amount_cents IS DISTINCT FROM s.half_cents
                      OR k.amount_cents IS DISTINCT FROM -s.half_cents
                      OR s.half_cents IS DISTINCT FROM smarter_private.fn_woowoo_half_rake_day_cents(s.day))
    INTO v_days, v_bad
    FROM (SELECT (f.played_at AT TIME ZONE 'UTC')::date AS day,
                 round(sum(coalesce(f.rake_paid, 0)) * 50)::bigint AS half_cents
            FROM public.ca_hand_facts f
           WHERE f.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid
             AND f.tournament_id IS NULL
             AND f.played_at > '2026-10-24 22:21:59.97593+00'::timestamptz
           GROUP BY 1) s
    LEFT JOIN smarter_private.player_fee_redemptions w
      ON w.operation_key = 'woowoo-half-split-' || to_char(s.day, 'YYYY-MM-DD')
    LEFT JOIN smarter_private.player_fee_redemptions k
      ON k.operation_key = 'kingfish-from-woowoo-split-' || to_char(s.day, 'YYYY-MM-DD')
   WHERE s.half_cents > 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'woowoo half rake split: day rows disagree with the rule: %', v_bad;
  END IF;
  IF v_days < 2 THEN
    RAISE EXCEPTION 'woowoo half rake split: expected at least the 2026-10-24 and 2026-10-25 days, found %', v_days;
  END IF;

  -- The first cut (20261024223153 step 2) is untouched.
  IF (SELECT amount_cents FROM smarter_private.player_fee_redemptions
       WHERE operation_key = 'woowoo-half-earned-rake-20261024') IS DISTINCT FROM 52052
     OR (SELECT amount_cents FROM smarter_private.player_fee_redemptions
          WHERE operation_key = 'kingfish-from-woowoo-half-earned-rake-20261024') IS DISTINCT FROM -52052 THEN
    RAISE EXCEPTION 'woowoo half rake split: the 2026-10-24 first cut (520.52) moved';
  END IF;
END
$assert$;

COMMIT;
