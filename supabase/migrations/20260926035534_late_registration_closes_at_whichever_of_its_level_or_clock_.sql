-- 20260926035534_late_registration_closes_at_whichever_of_its_level_or_clock_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  LATE REGISTRATION CLOSES AT WHICHEVER OF ITS LEVEL OR CLOCK DEADLINE
--  COMES FIRST
-- ===========================================================================
--
-- THE FINDING, read from rows on 2026-09-26 03:46 UTC. "Sunday Funday
-- Six-Card Closer" (c7f21a83-367c-459e-9639-067fa92516f5) started at
-- 2026-09-21 04:00 with late_reg_levels 9 and late_reg_mins 90, so its
-- advertised late registration ended at 05:30 that night. Five days later it
-- is RUNNING at current_level 3 and fn_tournament_late_registration_open still
-- answers TRUE. It is not alone: 53 of 338 RUNNING tournaments answer TRUE
-- although their own clock deadline has passed, all of them at an early level
-- days after they started.
--
-- THE CAUSE. The canonical admission predicate below is a CASE: when a level
-- cap is configured it reads ONLY the level, and the configured clock is read
-- only when there is no level cap at all. A tournament whose level clock
-- stalls or restarts therefore keeps late registration open for ever, and
-- every door that asks this function - wallet, ticket and horse registration,
-- late-registration capacity, and both satellite delivery authorities
-- (fn_ca_settle_satellite_cohort and fn_settle_satellite_tournament), which
-- since #5253 seat the winner in the same transaction - would admit a new
-- entrant days after the start.
--
-- THE RULE, from the code's own intent. late_reg_mins is not a separate
-- product: every producer derives it from the same ladder as late_reg_levels
-- (mttLateRegistrationMinutes, lateRegLevelsForMinutes: "an event never runs
-- late registration longer than the hour it advertised"). Of the 106
-- REGISTERING events carrying both, none has a clock shorter than its level
-- window. fn_thaw_platform_checkpointed deliberately does not shift
-- started_at + late_reg_mins across the hourly break ("parity with the
-- existing break is the honest behaviour"), so the configured clock is a
-- wall-clock deadline by design and nothing has to be derived. So:
--   * a level cap only       -> open while current_level < cap (unchanged);
--   * a clock only           -> open while now < started_at + mins (unchanged);
--   * both                   -> open only while BOTH are open: whichever
--                               deadline comes first closes it;
--   * neither                -> closed (unchanged).
-- Every other clause (RUNNING, unfinalized pool, non-negative bounds, entry
-- capacity) is byte-for-byte what it was.
--
-- WHAT A CLOSED TARGET DOES TO A SATELLITE WINNER. Both delivery authorities
-- already classify a RUNNING target this function calls closed as
-- delivery_kind 'cash': the winner receives the funded ticket value instead of
-- a seat. That path exists and is unchanged; this migration only stops the
-- wrong answer that bypassed it.
--
-- WHAT THIS MIGRATION DOES NOT DO. It writes no row and alters no running
-- tournament: nobody is unseated, no pool is finalized, no add-on or rebuy
-- window moves. fn_close_tournament_entry_window and the pool-finalization
-- guard keep their own schedule (see the changelog for why that boundary is
-- deliberate). Only future admissions are governed.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy). This migration is exactly one CREATE OR REPLACE FUNCTION.
--
-- ROLLBACK (Tier 3). Re-apply the previous definition (prosrc md5
-- 920def27870ad5babe69dac7622025f7, captured in
-- scripts/ci/fixtures/late-registration-clock/installed-predicate.sql).
-- Nothing here writes a row, so a rollback loses no data.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- PREIMAGE. Replace exactly the definition this migration was written
-- against, with the ACL it holds, and nothing else.
-- ---------------------------------------------------------------------------
DO $preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_tournament_late_registration_open'
       AND oidvectortypes(p.proargtypes) = 'uuid'
       AND md5(p.prosrc) = '920def27870ad5babe69dac7622025f7'
       AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}')
  THEN
    RAISE EXCEPTION
      'LATE_REG_CLOCK_PREIMAGE_CHANGED: fn_tournament_late_registration_open is not the definition this migration replaces';
  END IF;
END
$preimage$;

-- ---------------------------------------------------------------------------
-- The one change: the level window and the clock window must both be open.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND COALESCE(t.current_level,0)>=0
       AND COALESCE(t.late_reg_levels,0)>=0
       AND COALESCE(t.rebuy_levels,0)>=0
       AND COALESCE(t.late_reg_mins,0)>=0
       -- A window must be configured at all.
       AND (
         COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
         OR COALESCE(t.late_reg_mins,0)>0
       )
       -- The level window, when one is configured.
       AND (
         COALESCE(t.late_reg_levels,t.rebuy_levels,0)<=0
         OR COALESCE(t.current_level,0)
              <COALESCE(t.late_reg_levels,t.rebuy_levels,0)
       )
       -- AND the clock window, when one is configured: whichever deadline
       -- passes first closes late registration.
       AND (
         COALESCE(t.late_reg_mins,0)<=0
         OR (
           t.started_at IS NOT NULL
           AND clock_timestamp()
                 <t.started_at+make_interval(mins=>t.late_reg_mins)
         )
       )
       AND (
         public.fn_ca_tournament_is_unlimited(t.id)
         OR t.max_players IS NULL OR t.max_players<=0 OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$function$;

-- The ACL this function has held since it was written. CREATE OR REPLACE
-- preserves the live ACL; these lines make a rebuild from this file alone
-- produce the same one.
REVOKE ALL ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS. Each aborts this migration if what it names is not
-- true of production at apply time. Nothing below writes a row.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_open_past_clock integer;
  v_closer_open boolean;
BEGIN
  -- 1. The rule landed, with the ACL unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_tournament_late_registration_open'
       AND p.prosrc LIKE '%whichever deadline%'
       AND p.prosrc NOT LIKE '%CASE%'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}')
  THEN
    RAISE EXCEPTION 'ABORT: the combined late-registration rule did not land as written';
  END IF;

  -- 2. No RUNNING tournament answers open once its own clock has passed.
  SELECT count(*) INTO v_open_past_clock
    FROM public.tournaments t
   WHERE t.status = 'RUNNING'
     AND COALESCE(t.late_reg_mins, 0) > 0
     AND t.started_at IS NOT NULL
     AND clock_timestamp() >= t.started_at + make_interval(mins => t.late_reg_mins)
     AND public.fn_tournament_late_registration_open(t.id);
  IF v_open_past_clock <> 0 THEN
    RAISE EXCEPTION 'ABORT: % RUNNING tournament(s) still admit past their clock deadline',
      v_open_past_clock;
  END IF;

  -- 3. The tournament that exposed this reports CLOSED while it is running.
  SELECT public.fn_tournament_late_registration_open(t.id) INTO v_closer_open
    FROM public.tournaments t
   WHERE t.id = 'c7f21a83-367c-459e-9639-067fa92516f5' AND t.status = 'RUNNING';
  IF v_closer_open IS TRUE THEN
    RAISE EXCEPTION 'ABORT: Sunday Funday Six-Card Closer still reports late registration open';
  END IF;
END
$assert$;

COMMIT;
