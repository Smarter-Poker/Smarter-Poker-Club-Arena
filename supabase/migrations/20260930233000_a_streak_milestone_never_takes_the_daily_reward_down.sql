-- ============================================================================
-- A STREAK MILESTONE NEVER TAKES THE DAILY REWARD DOWN
-- ============================================================================
--
-- Version 20260930233000, assigned by the swarm lead on 2026-09-30.
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- WHAT WAS WRONG (measured on production, 2026-09-30 23:00-23:50 UTC).
--
-- Claiming a daily reward fires trg_daily_missions_claimed_milestone, which
-- pays any Daily Missions streak milestone that is due (7 days 150, 14 days
-- 400, 30 days 1,000, 60 days 2,500, 100 days and every 30 after 6,000)
-- INSIDE the claim. The milestone is credited under the reference
-- 'daily_mission_milestones:...', and fn_ca_diamond_engine_of filed that
-- under the daily_missions line, whose per-player daily cap is 500 (ruling
-- 18). DR7:user_over_daily_cap has refused instead of warning since
-- 2026-09-26 06:50 UTC (auto:flip_due). So from the thirtieth day of a streak
-- every milestone of 1,000 or more was refused, and because it ran inside the
-- claim the refusal rolled back the ordinary reward (9 to 45 Diamonds) with
-- it. The next claim evaluated the same milestone and was refused the same
-- way, for as long as the streak lasted.
--
-- 160 horses reached thirty days on 2026-09-29 and 2026-09-30 (their streaks
-- began 2026-08-31 and 2026-09-01). fn_ca_horse_claim_due, the horse's claim
-- button (pg_cron ca-horse-claim-due-minute), retried their refused rows
-- every minute, counted them as ordinary cap refusals, and - oldest first,
-- 500 a run - they filled the whole window, so nothing behind them was paid
-- either. The last horse claim landed at 2026-09-30 00:54 UTC. At 23:47,
-- 3,053 horse rewards worth 98,921 Diamonds were owed across 934 horses,
-- fn_ca_diamond_health read `horse claims` critical, and 46 DR0:health_critical
-- rows were open, one per hourly watch. The checker is right; this is the
-- cause. No milestone was forfeited: measured with the recorded freezes, all
-- 160 horses are still on the streak that earned it.
--
-- WHAT IS DECIDED - by Claude on Dan's delegation of 2026-09-30 ("these are
-- all for you to decide not me ... FIX AND FINISH ALL OF THESE"), recorded
-- under ruling 18 in docs/DIAMOND-RULINGS.md. Pay the milestones as promised.
--
--   1. Streak milestones get their own per-player line,
--      daily_mission_milestones, capped at 6,000 a day - the largest
--      milestone - identical for horses, humans and VIP. The ruling 18 cap of
--      500 on ordinary daily-mission rewards stays exactly as it is, and no
--      amount changes.
--   2. A milestone is evaluated and paid apart from the claim. The trigger
--      runs it in its own subtransaction and never raises, so nothing the
--      milestone does can roll back the ordinary reward.
--   3. A refused milestone stays owed and is retried, never forfeited. The
--      milestone row is written the moment the streak reaches it and is the
--      debt; it is paid, one credit per milestone under its own reference, by
--      the first daily claim that can pay it, and every later daily claim of
--      that player tries again until one does. A milestone row is paid when
--      its own credit is in the journal - one source of truth, no flag that
--      could drift from it.
--   4. The sweep never lets a refused row block the rows behind it. A capped
--      row waits for the day its cap resets (the America/Chicago day the earn
--      ledger counts in), a failed row waits ten minutes, and the candidate
--      window skips both (ca_horse_claim_deferrals). A milestone refusal is
--      filed under its own name, CH3:milestone_refused, and counted in its own
--      column of the sweep's result, never as an ordinary cap refusal.
--
-- WHAT DOES NOT CHANGE. Every credit still goes through
-- add_diamonds_to_balance and the register follows the journal as today, so
-- players + house + custody = register holds. No catalog amount changes. The
-- job keeps its name, schedule and command. The tournament switch is not
-- touched.
--
-- WHY THE RETRY IS NOT A BAND-AID (CLAUDE.md 10.12). Nothing here repairs a
-- wrong write and no job is added. The milestone row is a debt the live path
-- records and the live path pays: the claim is "restartable from its own
-- record", the remedy 10.12 names. The horse's claim button is the same
-- button a human presses, and it presses nothing a human would not.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_diamond_engine_of               44a39c35cc96801b5aa22a6ac930ee17
--   fn_award_daily_mission_milestones     077606e4e6fbd8c6c1eaf3c59cce35f9
--   fn_daily_missions_claimed_milestone   a8a8c804fdc1a3f43bbf1b587d2658a3
--   fn_ca_horse_claim_due                 6b0641992be63e1b9d9fe62ce44f4ff9
--
-- @live-proof: (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_mission_milestones') = 6000 AND (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') = 500
-- @live-proof: public.fn_ca_diamond_engine_of('daily_mission_milestone', 'daily_mission_milestone', NULL, NULL, 'daily_mission_milestones:x') = 'daily_mission_milestones'
-- @live-proof: position('fn_award_daily_mission_milestones' IN pg_get_functiondef('public.fn_daily_missions_claimed_milestone()'::regprocedure)) > 0 AND position('EXCEPTION WHEN OTHERS' IN pg_get_functiondef('public.fn_daily_missions_claimed_milestone()'::regprocedure)) > 0
-- @live-proof: position('ca_horse_claim_deferrals' IN pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) > 0 AND position('milestones_refused' IN pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) > 0
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. THE ESTATE IS AS MEASURED
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_n bigint;
BEGIN
  -- The line is sized to the largest milestone the catalog promises.
  IF (SELECT max(reward_diamonds) FROM public.daily_challenge_milestones) IS DISTINCT FROM 6000 THEN
    RAISE EXCEPTION 'the largest streak milestone is % Diamonds, not the 6,000 this line is sized to',
      (SELECT max(reward_diamonds) FROM public.daily_challenge_milestones);
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_engine_daily_caps WHERE engine = 'daily_mission_milestones') THEN
    RAISE EXCEPTION 'a daily_mission_milestones cap line already exists; someone else has been here';
  END IF;
  IF (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') IS DISTINCT FROM 500
     OR (SELECT max_per_user_per_day_vip FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'the ruling 18 daily_missions cap is not 500/500; this migration must not be the thing that moves it';
  END IF;

  -- The owed state is read from the journal: a milestone row is paid when the credit under its own
  -- reference exists. Every row written before today must therefore already read as paid, or the
  -- first claim after this would pay it a second time. Measured 2026-09-30: 2,171 rows, 562,900
  -- Diamonds, every one with its own credit.
  SELECT count(*) INTO v_n
    FROM public.daily_challenge_milestone_claims c
   WHERE NOT EXISTS (
     SELECT 1 FROM public.diamond_transactions t
      WHERE t.user_id = c.user_id
        AND t.reference_id = 'daily_mission_milestones:' || c.user_id::text || ':'
                             || c.streak_run_id::text || ':' || c.milestone_days::text);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% milestone row(s) have no credit under their own reference; the owed state would pay them. Read them before applying.', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-horse-claim-due-minute' AND active
                    AND schedule = '* * * * *' AND command = 'SELECT public.fn_ca_horse_claim_due(500)') THEN
    RAISE EXCEPTION 'ca-horse-claim-due-minute is not scheduled as measured';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is on somewhere; this migration expects it closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. STREAK MILESTONES GET THEIR OWN LINE
-- ---------------------------------------------------------------------------
-- The engine map is pure (IMMUTABLE) and nothing indexes it. Two clauses move: the milestone
-- reference and the milestone transaction type both name the new line; daily_mission_reward and
-- every other daily-mission reference stay on daily_missions, under the 500 cap of ruling 18.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_ca_diamond_engine_of';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '44a39c35cc96801b5aa22a6ac930ee17' THEN
    RAISE EXCEPTION 'fn_ca_diamond_engine_of is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'        WHEN starts_with(p_reference_id, ''daily_mission_milestones:'') THEN ''daily_missions''\n';
  v_new1 := E'        WHEN starts_with(p_reference_id, ''daily_mission_milestones:'') THEN ''daily_mission_milestones''\n';
  v_old2 := E'        WHEN COALESCE(p_transaction_type, p_type) IN (''daily_mission_milestone'', ''daily_mission_reward'') THEN ''daily_missions''\n';
  v_new2 := E'        WHEN COALESCE(p_transaction_type, p_type) = ''daily_mission_milestone'' THEN ''daily_mission_milestones''\n'
         || E'        WHEN COALESCE(p_transaction_type, p_type) = ''daily_mission_reward'' THEN ''daily_missions''\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'engine map: the milestone reference clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'engine map: the milestone type clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2)) <> '44a39c35cc96801b5aa22a6ac930ee17' THEN
    RAISE EXCEPTION 'engine map: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- The line itself. 6,000 is the largest milestone in daily_challenge_milestones (asserted above),
-- so any one milestone always fits in a day; two large ones reached on the same day are the only
-- way to meet it, and then the second waits for the next day rather than being lost (section 2).
INSERT INTO public.diamond_engine_daily_caps (engine, max_per_user_per_day, max_per_user_per_day_vip, note)
VALUES ('daily_mission_milestones', 6000, 6000,
        'Daily Missions streak milestones on their own line (30 days 1,000; 60 days 2,500; 100 days and every 30 after 6,000), sized to the largest milestone so a milestone never meets the ruling 18 cap of 500 on ordinary daily-mission rewards. Identical for horses, humans and VIP. Decided by Claude on Dan''s delegation of 2026-09-30 (docs/DIAMOND-RULINGS.md, ruling 18 amendment; migration 20260930233000).');

-- ---------------------------------------------------------------------------
-- 2. A MILESTONE IS WRITTEN DOWN WHEN IT IS REACHED, AND PAID ON ITS OWN
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF md5(pg_get_functiondef('public.fn_award_daily_mission_milestones(uuid)'::regprocedure)) <> '077606e4e6fbd8c6c1eaf3c59cce35f9' THEN
    RAISE EXCEPTION 'fn_award_daily_mission_milestones is not the pinned text (md5 %)',
      md5(pg_get_functiondef('public.fn_award_daily_mission_milestones(uuid)'::regprocedure));
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_streak_receipt jsonb;
  v_streak integer;
  v_run_id uuid;
  v_started date;
  v_ended date;
  v_max integer;
  v_max_reward numeric;
  v_owed record;
  v_reference text;
  v_credit jsonb;
  v_paid numeric := 0;
  v_refused text;
  v_msg text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions milestone player is required';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  v_streak_receipt := public.get_challenge_streak(p_user_id);
  v_streak := COALESCE((v_streak_receipt ->> 'streak')::integer, 0);
  v_run_id := NULLIF(v_streak_receipt ->> 'streakRunId', '')::uuid;
  v_started := NULLIF(v_streak_receipt ->> 'streakStartedOn', '')::date;
  v_ended := NULLIF(v_streak_receipt ->> 'streakEndedOn', '')::date;

  -- 1. WHAT IS OWED. Every milestone this run has reached is written down once, the moment it is
  --    reached, whether or not it can be paid today. The row is the debt, and nothing removes it
  --    for being unpaid, so a refusal can never forfeit a milestone.
  IF v_streak > 0 AND v_run_id IS NOT NULL AND v_started IS NOT NULL AND v_ended IS NOT NULL THEN
    SELECT max(days) INTO v_max
    FROM public.daily_challenge_milestones;

    SELECT reward_diamonds INTO v_max_reward
    FROM public.daily_challenge_milestones
    WHERE days = v_max;

    INSERT INTO public.daily_challenge_milestone_claims (
      user_id,
      streak_run_id,
      streak_started_on,
      milestone_days,
      reward_diamonds
    )
    SELECT p_user_id, v_run_id, v_started, due.days, due.reward_diamonds
    FROM (
      SELECT days, reward_diamonds
      FROM public.daily_challenge_milestones
      WHERE days <= v_streak
      UNION ALL
      SELECT day, v_max_reward
      FROM generate_series(
        v_max + 30,
        v_max + ((v_streak - v_max) / 30) * 30,
        30
      ) day
    ) due
    ON CONFLICT DO NOTHING;
  END IF;

  -- 2. PAYING WHAT IS OWED. Oldest first, one credit per milestone under its own reference, each in
  --    its own subtransaction: a refusal (the per-player cap of the daily_mission_milestones line,
  --    the issuance freeze, anything) undoes that one credit and nothing else, and files it under
  --    its own name. A milestone is paid when its credit is in the journal, so this reads the
  --    journal rather than a flag beside it. One refused inside this transaction is not tried again
  --    in it - the answer cannot change before the transaction ends - and the player's next daily
  --    claim tries it again, until one pays it.
  v_refused := COALESCE(current_setting('ca.daily_mission_milestones_refused', true), '');
  FOR v_owed IN
    SELECT c.streak_run_id, c.milestone_days, c.reward_diamonds
      FROM public.daily_challenge_milestone_claims c
     WHERE c.user_id = p_user_id
       AND c.reward_diamonds > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.diamond_transactions t
          WHERE t.user_id = c.user_id
            AND t.reference_id = 'daily_mission_milestones:' || c.user_id::text || ':'
                                 || c.streak_run_id::text || ':' || c.milestone_days::text)
     ORDER BY c.claimed_at, c.milestone_days
  LOOP
    v_reference := 'daily_mission_milestones:' || p_user_id::text || ':'
                   || v_owed.streak_run_id::text || ':' || v_owed.milestone_days::text;
    CONTINUE WHEN position(',' || v_reference || ',' IN ',' || v_refused || ',') > 0;
    BEGIN
      v_credit := public.add_diamonds_to_balance(
        p_user_id,
        v_owed.reward_diamonds::integer,
        'daily_mission_milestone',
        'Daily Missions streak circuit',
        v_reference
      );
      IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Daily Missions streak milestone could not be credited: %',
          COALESCE(v_credit ->> 'error', 'unknown');
      END IF;
      v_paid := v_paid + v_owed.reward_diamonds;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_refused := concat_ws(',', NULLIF(v_refused, ''), v_reference);
      PERFORM set_config('ca.daily_mission_milestones_refused', v_refused, true);
      PERFORM public.fn_ca_diamond_incident(
        'CH3:milestone_refused', 'warning', p_user_id, v_owed.reward_diamonds,
        'fn_award_daily_mission_milestones',
        jsonb_build_object(
          'milestone_days', v_owed.milestone_days,
          'streak_run_id', v_owed.streak_run_id,
          'reference_id', v_reference,
          'refused_by', v_msg,
          'owed', true,
          'note', 'The milestone stays owed. The player''s next daily claim pays it; nothing is forfeited.'));
    END;
  END LOOP;

  RETURN v_paid;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_daily_mission_milestones(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE CLAIM NEVER WAITS ON THE MILESTONE
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF md5(pg_get_functiondef('public.fn_daily_missions_claimed_milestone()'::regprocedure)) <> 'a8a8c804fdc1a3f43bbf1b587d2658a3' THEN
    RAISE EXCEPTION 'fn_daily_missions_claimed_milestone is not the pinned text (md5 %)',
      md5(pg_get_functiondef('public.fn_daily_missions_claimed_milestone()'::regprocedure));
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_claimed_milestone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_msg text;
BEGIN
  IF NEW.claimed AND NOT OLD.claimed AND NEW.tier_snapshot = 'daily' THEN
    -- A STREAK MILESTONE NEVER TAKES THE DAILY REWARD DOWN (2026-09-30). The milestone is
    -- evaluated and paid in its own subtransaction. fn_award_daily_mission_milestones already keeps
    -- a refused payment owed without raising; this block is for anything else the step could meet
    -- (a lock, a streak it cannot read), which must not roll the claim back either. The next daily
    -- claim runs the step again, so nothing the streak has reached is lost.
    BEGIN
      PERFORM public.fn_award_daily_mission_milestones(NEW.user_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      PERFORM public.fn_ca_diamond_incident(
        'CH3:milestone_step_failed', 'warning', NEW.user_id, NULL,
        'fn_daily_missions_claimed_milestone',
        jsonb_build_object(
          'challenge_row_id', NEW.id,
          'sqlerrm', v_msg,
          'note', 'The claim stands. The milestone step could not run with it; the next daily claim runs it again.'));
    END;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_daily_missions_claimed_milestone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_daily_missions_claimed_milestone() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. THE SWEEP NEVER QUEUES BEHIND A REFUSAL
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_horse_claim_deferrals (
  challenge_row_id uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  refused_by       text NOT NULL CHECK (refused_by IN ('DR7:user_over_daily_cap', 'CH3:horse_claim_failed')),
  detail           text,
  refusals         integer NOT NULL DEFAULT 1 CHECK (refusals > 0),
  first_refused_at timestamptz NOT NULL DEFAULT now(),
  last_refused_at  timestamptz NOT NULL DEFAULT now(),
  retry_after      timestamptz NOT NULL
);
COMMENT ON TABLE public.ca_horse_claim_deferrals IS
  'When fn_ca_horse_claim_due may next press a horse reward it could not pay. A reward refused by DR7:user_over_daily_cap waits for the America/Chicago day its cap resets; one that failed for any other reason waits ten minutes. The sweep''s candidate window skips a deferred reward, so a refused reward never blocks the rewards behind it. A deferral is forgotten once its reward is claimed, expired or past its seven days. Migration 20260930233000.';
ALTER TABLE public.ca_horse_claim_deferrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_horse_claim_deferrals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ca_horse_claim_deferrals TO service_role;

DO $m$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) <> '6b0641992be63e1b9d9fe62ce44f4ff9' THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due is not the pinned text (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure));
  END IF;
END $m$;

-- The result gains a column, milestones_refused, and a result type cannot change in place. The job
-- calls the function by name (SELECT public.fn_ca_horse_claim_due(500)) and reads no column.
DROP FUNCTION public.fn_ca_horse_claim_due(integer);

CREATE FUNCTION public.fn_ca_horse_claim_due(p_limit integer DEFAULT 500)
 RETURNS TABLE(claimed integer, capped integer, failed integer, ran boolean, milestones_refused integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_claimed integer := 0; v_capped integer := 0; v_failed integer := 0; v_msg text;
  v_cap_resets timestamptz; v_by text; v_retry timestamptz; v_refused text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due: service_role required';
  END IF;

  -- THE PLATFORM FREEZE (CLAUDE.md 13 rule 5). This moves money every minute, and profiles and
  -- diamond_transactions are NOT among the tables zz_freeze_guard protects - so nothing else would
  -- have stopped it crediting inside a :55-:00 break.
  IF public.fn_platform_frozen() THEN
    RETURN QUERY SELECT 0, 0, 0, false, 0;
    RETURN;
  END IF;

  -- xact-scoped: released at commit or rollback, with no unlock path to miss. The session-scoped
  -- form skipped its unlock on a statement timeout, because EXCEPTION WHEN OTHERS does not trap
  -- query_canceled - harmless under pg_cron (the backend exits) and a permanent leak from a pooled
  -- service_role backend, which also holds EXECUTE on this.
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_horse_claim_due')) THEN
    -- `ran = false` and not a zero count: "another run holds the lock" and "nothing was owed" are
    -- different answers and must not share a representation (CLAUDE.md 10.86 rule 1).
    RETURN QUERY SELECT 0, 0, 0, false, 0;
    RETURN;
  END IF;

  -- THE DAY A CAP RESETS (2026-09-30). fn_ca_diamond_earn_ledger counts a player's day in
  -- America/Chicago, so a reward its cap refused cannot be paid before that day's midnight.
  v_cap_resets := (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day')
                  AT TIME ZONE 'America/Chicago';

  -- A deferral lives only as long as the reward it defers is owed.
  DELETE FROM public.ca_horse_claim_deferrals d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.user_daily_challenges u
      WHERE u.id = d.challenge_row_id
        AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
        AND u.completed_at >= now() - interval '7 days');

  -- The milestone step names, per transaction, the milestones it could not pay (20260930233000
  -- section 2). This run counts its own.
  PERFORM set_config('ca.daily_mission_milestones_refused', '', true);

  -- OLDEST FIRST TO CHOOSE, PRIMARY KEY ORDER TO LOCK (2026-09-24).
  --
  -- 33 claims died with `deadlock detected` between 2026-09-09 and 2026-09-22,
  -- across 29 horses. The whole loop is one transaction, so it holds every row
  -- lock it takes until it ends; it took them in completed_at order, while the
  -- four outbox drain shards update one player's rows in a single unordered
  -- bulk UPDATE on the same minute. Overlapping rows taken in two different
  -- orders is the cycle.
  --
  -- fn_expire_daily_challenge_rewards hit this on 2026-09-09 and its body
  -- carries the answer: primary key order gives every caller the same
  -- acquisition order, which is what makes a cycle impossible, and SKIP LOCKED
  -- leaves a row somebody is holding right now for the next run rather than
  -- waiting behind it. A skipped row is not a stranded one; it is still the
  -- oldest thing owed a minute later, so it is picked first next time.
  --
  -- The inner select still chooses by completed_at, so the limit continues to
  -- take what is closest to expiring. Only the order the locks are acquired in
  -- has changed, and the loop now never waits on a challenge row at all.
  --
  -- NOTHING REFUSED IS CHOSEN AGAIN BEFORE IT CAN BE PAID (2026-09-30). Oldest first
  -- used to mean a refused row was chosen again every minute, and on 2026-09-29/30 the
  -- refused rows of 160 horses filled the whole window: nothing behind them was paid for
  -- a day. A deferred row is not a candidate until its retry_after has passed.
  FOR r IN
    WITH oldest AS (
      SELECT u.id
        FROM public.user_daily_challenges u
        JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
       WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at >= now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM public.ca_horse_claim_deferrals d
                          WHERE d.challenge_row_id = u.id AND d.retry_after > now())
       ORDER BY u.completed_at, u.id
       LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    )
    SELECT u.id, u.user_id
      FROM public.user_daily_challenges u
      JOIN oldest o ON o.id = u.id
     ORDER BY u.id
       FOR UPDATE OF u SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
      v_claimed := v_claimed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE '%DR7:user_over_daily_cap%' THEN
        -- COUNTED, NOT FILED. A thousand horses meet the cap daily so an incident would be an
        -- always-on alarm, but returning it means the caller can see a run that paid nothing
        -- because everything was capped - which after DR7 arms is the difference between a
        -- backlog draining and a backlog dying. Since 2026-09-30 this is only ever the reward's
        -- own line: a streak milestone is paid apart from the claim and is counted below, in
        -- milestones_refused, never here.
        v_capped := v_capped + 1;
        v_by := 'DR7:user_over_daily_cap';
        v_retry := v_cap_resets;
      ELSE
        v_failed := v_failed + 1;
        v_by := 'CH3:horse_claim_failed';
        v_retry := now() + interval '10 minutes';
        BEGIN
          PERFORM public.fn_ca_diamond_incident(
            'CH3:horse_claim_failed', 'warning', r.user_id, NULL, 'fn_ca_horse_claim_due',
            jsonb_build_object('challenge_row_id', r.id, 'sqlerrm', v_msg));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
      BEGIN
        INSERT INTO public.ca_horse_claim_deferrals AS d
               (challenge_row_id, user_id, refused_by, detail, retry_after)
        VALUES (r.id, r.user_id, v_by, left(v_msg, 500), v_retry)
        ON CONFLICT (challenge_row_id) DO UPDATE
           SET refused_by = EXCLUDED.refused_by,
               detail = EXCLUDED.detail,
               refusals = d.refusals + 1,
               last_refused_at = now(),
               retry_after = EXCLUDED.retry_after;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'fn_ca_horse_claim_due could not defer challenge row %: %', r.id, SQLERRM;
      END;
    END;
  END LOOP;

  v_refused := NULLIF(current_setting('ca.daily_mission_milestones_refused', true), '');
  RETURN QUERY SELECT v_claimed, v_capped, v_failed, true,
                      COALESCE(cardinality(string_to_array(v_refused, ',')), 0);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_claim_due(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_txt text; v_bad text; r record;
BEGIN
  -- The line: a milestone, and only a milestone, is on it.
  IF public.fn_ca_diamond_engine_of('daily_mission_milestone', 'daily_mission_milestone', NULL, 'Daily Missions streak circuit', 'daily_mission_milestones:u:r:30') <> 'daily_mission_milestones'
     OR public.fn_ca_diamond_engine_of('daily_mission_milestone', 'daily_mission_milestone', NULL, NULL, NULL) <> 'daily_mission_milestones'
     OR public.fn_ca_diamond_engine_of('daily_mission_reward', 'daily_mission_reward', NULL, NULL, NULL) <> 'daily_missions'
     OR public.fn_ca_diamond_engine_of('bonus', 'bonus', NULL, NULL, 'daily_mission_x') <> 'daily_missions'
     OR public.fn_ca_diamond_engine_of('bonus', 'bonus', NULL, NULL, 'daily-missions-historical-multiplier:x') <> 'daily_missions'
     OR public.fn_ca_diamond_engine_of('daily_challenge_claim', 'daily_challenge_claim', NULL, NULL, 'challenge_claim:x:diamonds') <> 'daily_challenges' THEN
    RAISE EXCEPTION 'the engine map does not put a streak milestone, and only a streak milestone, on its own line';
  END IF;
  IF (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_mission_milestones') IS DISTINCT FROM 6000
     OR (SELECT max_per_user_per_day_vip FROM public.diamond_engine_daily_caps WHERE engine = 'daily_mission_milestones') IS DISTINCT FROM 6000 THEN
    RAISE EXCEPTION 'the daily_mission_milestones line is not 6,000 for everyone';
  END IF;
  IF (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') IS DISTINCT FROM 500
     OR (SELECT max_per_user_per_day_vip FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') IS DISTINCT FROM 500
     OR (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_challenges') IS DISTINCT FROM 4000 THEN
    RAISE EXCEPTION 'a cap this migration must not touch has moved';
  END IF;

  -- The milestone step is apart from the claim, and keeps what it cannot pay.
  v_txt := pg_get_functiondef('public.fn_daily_missions_claimed_milestone()'::regprocedure);
  IF position('PERFORM public.fn_award_daily_mission_milestones(NEW.user_id);' IN v_txt) = 0
     OR position('EXCEPTION WHEN OTHERS THEN' IN v_txt) = 0
     OR position('CH3:milestone_step_failed' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the claimed-row trigger does not run the milestone step in its own subtransaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.user_daily_challenges'::regclass
                    AND t.tgname = 'trg_daily_missions_claimed_milestone'
                    AND t.tgfoid = 'public.fn_daily_missions_claimed_milestone()'::regprocedure
                    AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'trg_daily_missions_claimed_milestone is not attached as it was';
  END IF;
  v_txt := pg_get_functiondef('public.fn_award_daily_mission_milestones(uuid)'::regprocedure);
  IF position('ON CONFLICT DO NOTHING' IN v_txt) = 0
     OR position('CH3:milestone_refused' IN v_txt) = 0
     OR position('ca.daily_mission_milestones_refused' IN v_txt) = 0
     OR position('public.add_diamonds_to_balance(' IN v_txt) = 0
     OR position('AND t.reference_id = ''daily_mission_milestones:'' || c.user_id::text' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the milestone step does not record, pay and name as this migration states';
  END IF;

  -- The sweep: one definition, the 2026-09-24 lock order kept, deferrals honoured.
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_ca_horse_claim_due') <> 1 THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due is not exactly one function';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure);
  IF position('SKIP LOCKED' IN v_txt) = 0
     OR position('ORDER BY u.id' IN v_txt) = 0
     OR position('ORDER BY u.completed_at, u.id' IN v_txt) = 0
     OR position('pg_try_advisory_xact_lock' IN v_txt) = 0
     OR position('fn_platform_frozen' IN v_txt) = 0
     OR position('claim_daily_challenge_serialized_body(r.user_id, r.id, NULL)' IN v_txt) = 0
     OR position('d.retry_after > now()' IN v_txt) = 0
     OR position('CH3:horse_claim_failed' IN v_txt) = 0
     OR position('milestones_refused integer' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the horse claim sweep is not the one this migration states';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-horse-claim-due-minute' AND active
                    AND schedule = '* * * * *' AND command = 'SELECT public.fn_ca_horse_claim_due(500)') THEN
    RAISE EXCEPTION 'ca-horse-claim-due-minute is not scheduled as it was';
  END IF;

  -- Nobody outside the server reaches any of it.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('fn_award_daily_mission_milestones', 'fn_daily_missions_claimed_milestone', 'fn_ca_horse_claim_due')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser role', r.proname;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_horse_claim_due(integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role can no longer press the horse claim button';
  END IF;
  IF has_table_privilege('anon', 'public.ca_horse_claim_deferrals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_horse_claim_deferrals', 'SELECT')
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.ca_horse_claim_deferrals'::regclass) THEN
    RAISE EXCEPTION 'ca_horse_claim_deferrals is readable from a browser role or has no row security';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a streak milestone never takes the daily reward down: milestones on their own 6,000 line, paid apart from the claim, owed until paid; the sweep skips what it cannot pay yet';
END $m$;

COMMIT;
