-- 20260908101106_audit_counts_entries_not_survivors.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE DAILY HORSE AUDIT WAS COUNTING SURVIVORS AS IF THEY WERE ENTRIES.
--
-- tournaments.current_players is a LIVE counter: it is decremented as players
-- bust, so by the time an event is COMPLETED it reads 1-3 (whoever was left).
-- fn_audit_overlays and fn_audit_empty_freerolls both read it as "entries".
--
-- Measured on the 2026-09-07 audit (day analysed 2026-09-08):
--
--   Sunday Funday Main Event   reported "4820.00 overlay" from current_players=2
--                              real: 165 entries x 90.00 = 14850.00 funded
--                              against a 5000.00 guarantee - BEATEN by 9850.00
--   Sunday Funday High Roller  reported "3432.50 overlay" from current_players=1
--                              real: 66 entries x 67.50 = 4455.00 vs 3500.00 gtd
--   Morning Free Buy (NLH)     reported "started with 1 of 200 players"
--                              real: 200 of 200 - a full house
--   Prime Time Free Buy (NLH)  reported "started with 1 of 300 players"
--                              real: 300 of 300
--
-- ELEVEN of the twenty-four CRITICAL findings that day were this one bug, and
-- not one real overlay existed: every guarantee on 2026-09-07 was exceeded.
-- The recommendation text sent every reader to HorseOverlayGuard, which was
-- working correctly the whole time. A detector that cries wolf on the guard
-- that is doing its job is worse than no detector, because the next agent
-- spends the day in the wrong file.
--
-- The honest entry count is tournament_players (one row per entrant), and the
-- honest prize-pool contribution adds rebuys and add-ons, which fund the pool
-- too - Prime Time Main Event on 2026-09-07 was 69 entries + 16 rebuys + 62
-- add-ons = 3502.50 funded against a 1000.00 guarantee.
--
-- Fixing the count does not blunt the detector, it arms it: the same day had
-- genuinely thin freerolls (12 of 200, 24 of 500) that the broken version
-- could not distinguish from the full ones.
--
-- THIRD FIX, SAME CLASS: fn_audit_tuner_health resolved its run as p_day + 1
-- and warned tuner_no_rows when that date was empty. The audit generates at
-- ~06:35 UTC; HorseSelfTuner writes between 08:06 and 09:38 UTC every day
-- (measured across 2026-09-05..08). So the audit asks for a run that has not
-- happened yet, and the warn fires on timing rather than on anything wrong.
-- Worse, that branch RETURNS EARLY, so tuner_regressed_the_fleet and
-- tuner_tightened_the_fleet - two CRITICAL detectors written for the
-- 2026-09-04 and 2026-09-06 incidents - cannot fire on any day the race is
-- lost. On 2026-09-08 the tuner was healthy (106/624 regressed = 17.0%,
-- 120/624 tightened = 19.2%, both well under the 0.40 bar, 624/624 studied
-- from horse_daily_play), so nothing was missed this time. The point is that
-- nothing would have been reported if it had not been.
--
-- The fix evaluates the newest tuner run in [p_day, p_day + 1] and reports
-- which one it read, so a lagging tuner is visible instead of silencing the
-- checks below it. tuner_no_rows now means what it says: no tuner run for two
-- days.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- Entries funded into the prize pool, counted from the entrant rows.
-- STABLE so the audit's planner can inline it; SECURITY DEFINER to match the
-- audit functions that call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_funding(p_tournament_id uuid)
RETURNS TABLE (entries int, rebuys int, addons int, funded numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    count(*)::int,
    coalesce(sum(tp.rebuys), 0)::int,
    count(*) FILTER (WHERE tp.add_on)::int,
    round(
      count(*) * coalesce(t.buy_in_amount, 0)
      + coalesce(sum(tp.rebuys), 0) * coalesce(t.rebuy_cost, 0)
      + count(*) FILTER (WHERE tp.add_on) * coalesce(t.addon_cost, 0)
    , 2)
  FROM tournaments t
  LEFT JOIN tournament_players tp ON tp.tournament_id = t.id
  WHERE t.id = p_tournament_id
  GROUP BY t.buy_in_amount, t.rebuy_cost, t.addon_cost;
$function$;

COMMENT ON FUNCTION public.fn_tournament_entry_funding(uuid) IS
  'Entries, rebuys, add-ons and the money they put into the prize pool. Counted '
  'from tournament_players. NEVER use tournaments.current_players for this - it '
  'is a live survivor counter and reads 1-3 on a completed event.';

-- ---------------------------------------------------------------------------
-- fn_audit_overlays: shortfall against what entries actually funded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_overlays(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v jsonb := '[]'::jsonb; r record; total numeric := 0; n int := 0;
begin
  for r in
    select t.name, t.guaranteed_prize gtd, t.buy_in_amount bi,
           f.entries, f.rebuys, f.addons, f.funded,
           (t.guaranteed_prize - f.funded) short
    from tournaments t
    cross join lateral fn_tournament_entry_funding(t.id) f
    where t.guaranteed_prize > 0 and t.buy_in_amount > 0
      and t.started_at >= p_day and t.started_at < p_day + 1
      and (t.guaranteed_prize - f.funded) > 0
    order by 9 desc limit 10
  loop
    total := total + r.short; n := n + 1;
    v := v || jsonb_build_object(
      'severity', case when r.short >= 200 then 'critical' else 'warn' end,
      'category', 'logic', 'code', 'tournament_overlay',
      'title', r.name || ' started with a ' || round(r.short, 2) || ' overlay',
      'evidence', jsonb_build_object('guarantee', r.gtd, 'buy_in', r.bi,
                                     'entries', r.entries, 'rebuys', r.rebuys,
                                     'addons', r.addons, 'funded', r.funded,
                                     'shortfall', r.short),
      'recommendation', 'The overlay guard did not fill this event before it started. Check HorseOverlayGuard logs for that window: it may have been starved of eligible horses (events/both lane, under the four-table cap) or the event may have started sooner than the guard cycle. Entries are counted from tournament_players; current_players is a survivor count and is not the field size.'
    );
  end loop;
  if n > 0 then
    v := v || jsonb_build_object(
      'severity', 'info', 'category', 'logic', 'code', 'overlay_total',
      'title', 'Club covered ' || round(total, 2) || ' in overlays across ' || n || ' event(s)',
      'evidence', jsonb_build_object('events', n, 'total_overlay', round(total, 2)),
      'recommendation', 'Total is the money the guarantee cost beyond what entries funded.'
    );
  end if;
  return v;
end $function$;

-- ---------------------------------------------------------------------------
-- fn_audit_empty_freerolls: field size from entrant rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_empty_freerolls(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v jsonb := '[]'::jsonb; r record;
begin
  for r in
    select t.name, f.entries cur, coalesce(t.max_players,0) maxp
    from tournaments t
    cross join lateral fn_tournament_entry_funding(t.id) f
    where coalesce(t.buy_in_amount,0) = 0
      and t.started_at >= p_day and t.started_at < p_day + 1
      and coalesce(t.max_players,0) > 0
      and f.entries < greatest(6, coalesce(t.max_players,0) * 0.15)
    order by f.entries asc limit 8
  loop
    v := v || jsonb_build_object(
      'severity','warn','category','logic','code','freeroll_started_empty',
      'title', r.name || ' started with ' || r.cur || ' of ' || r.maxp || ' players',
      'evidence', jsonb_build_object('entries', r.cur, 'capacity', r.maxp),
      'recommendation','Every playing horse should register for a freeroll. Check HorseOverlayGuard freeroll lines for that window - it may have been outside the fill band, or every candidate was outside its activity window or at the four-table cap.'
    );
  end loop;
  return v;
end $function$;

-- ---------------------------------------------------------------------------
-- fn_audit_tuner_health: read the newest tuner run in the window, and never
-- let a missing run silence the two critical checks underneath it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_tuner_health(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v jsonb := '[]'::jsonb;
  v_rows int;
  v_regress int;
  v_tight int;
  v_play int;
  v_play_age int;
  v_run date;
begin
  -- The accounting the rule depends on, first: a verdict below is only
  -- meaningful once the drop is fully attributed.
  v := v || fn_audit_fleet_drop_identity(p_day);

  -- THE AUDIT RUNS BEFORE THE TUNER DOES. Measured 2026-09-05..08: the audit
  -- generates at ~06:35 UTC, HorseSelfTuner writes between 08:06 and 09:38.
  -- Asking only for p_day + 1 loses that race and returns early, taking
  -- tuner_regressed_the_fleet and tuner_tightened_the_fleet down with it.
  -- Take the newest run in the window instead, and say which one was read.
  select max(run_date) into v_run
    from horse_self_tune_log
   where run_date in (p_day, p_day + 1);

  if v_run is null then
    v := v || jsonb_build_object('severity','warn','category','logic','code','tuner_no_rows',
      'title','No self-tune rows for ' || p_day || ' or ' || (p_day + 1) || ' - the leak profiles did not move',
      'evidence', jsonb_build_object('looked_for', jsonb_build_array(p_day, p_day + 1)),
      'recommendation','HorseSelfTuner is the only writer of profiles.horse_profile.leaks*; every night it does not run, the brain reads stale verdicts. See the nightly_job_health finding for the claim.');
    return v;
  end if;

  select count(*),
         count(*) filter (where array_to_string(reasons, ' ') like '%regress dials halfway%'),
         count(*) filter (where array_to_string(reasons, ' ') like '%too loose%'),
         count(*) filter (where (stats->>'study_source')::int = 1)
    into v_rows, v_regress, v_tight, v_play
    from horse_self_tune_log where run_date = v_run;

  if v_run = p_day then
    v := v || jsonb_build_object('severity','info','category','logic','code','tuner_run_lagging',
      'title','Read the ' || v_run || ' tuner run; ' || (p_day + 1) || ' had not been written when the audit ran',
      'evidence', jsonb_build_object('read_run_date', v_run, 'expected_run_date', p_day + 1, 'rows', v_rows),
      'recommendation','Normal when the audit generates before the tuner window (about 06:35 UTC against 08:06-09:38). The checks below were still evaluated, against the run named here. If this note appears with a stale date for several days running, the tuner itself has stopped.');
  end if;

  if v_regress::numeric / v_rows > 0.4 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_regressed_the_fleet',
      'title', v_regress || ' of ' || v_rows || ' tuned horses regressed to neutral on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'regressed', v_regress, 'share', round(v_regress::numeric / v_rows, 3)),
      'recommendation','The regression rule is reading the DROP as a leak again (2026-09-04: 221 of 383). It must judge net_bb + rake_bb + bbj_bb and only a horse under the fleet p25 - see RegressionContext in HorseSelfTuner.ts, TheTunerDoesNotFightTheRake.law.test.ts and TheDropIsTheRakeAndTheJackpot.law.test.ts. Read the drop-identity finding above this one first: if the attribution is short, this number is the shortfall, not 221 broken horses.');
  end if;

  -- A MASS TIGHTENING IS THE SAME CLASS OF BUG (2026-09-06). It ran three
  -- nights running - 104/429, 180/386, 216/383 - because floored tables were
  -- measured against the winning-player band. Whenever half the fleet is
  -- moved the same way, the input is wrong before the dials are.
  if v_tight::numeric / v_rows > 0.40 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_tightened_the_fleet',
      'title', v_tight || ' of ' || v_rows || ' tuned horses were tightened for "too loose" on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'tightened', v_tight, 'share', round(v_tight::numeric / v_rows, 3)),
      'recommendation','Half the fleet is not individually too loose - the measurement is. Check that horse_daily_play.floored is being written (a floored table REQUIRES loose play) and that loadPlayRows still filters floored = false. `tightness` is a GLOBAL dial, so a horse tightened for its floored table plays nittier at every ordinary table it sits at.');
  end if;

  select count(distinct day) into v_play_age from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_age >= 6 and v_play::numeric / v_rows < 0.6 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','tuner_studied_from_stream',
      'title', (v_rows - v_play) || ' of ' || v_rows || ' tuned horses came from the hand_history stream, not horse_daily_play',
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'from_play_rows', v_play, 'play_days_in_window', v_play_age),
      'recommendation','horse_daily_play has a week of rows, so the tuner should study nearly every horse from it. Either the settlement compiler (HorseHandReview.accumulateHorsePlay) is off (HORSE_PLAY_ROLLUP_ENABLED) or loadPlayRows is failing (horse_error_log context HorseSelfTuner.playRows).');
  end if;
  return v;
end $function$;

-- ---------------------------------------------------------------------------
-- LOCK DOWN. These are operator/engine telemetry: nothing a browser reaches.
-- The three existing functions already grant only postgres + service_role in
-- production; stating it here keeps CREATE OR REPLACE from ever widening them
-- and closes fn_tournament_entry_funding, which is new and would otherwise
-- inherit the Postgres default of EXECUTE to PUBLIC.
--
-- PUBLIC is named as well as the roles: anon and authenticated inherit
-- whatever PUBLIC holds, so revoking the roles alone reads as a fix and does
-- nothing. Verified 2026-09-08 that no RLS policy expression references any of
-- these four, so revoking cannot deny a SELECT anywhere.
--
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so these cost no schema
-- reload (club-arena CLAUDE.md section 2, rule 5).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_tournament_entry_funding(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_audit_overlays(date)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_audit_empty_freerolls(date)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_audit_tuner_health(date)       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_tournament_entry_funding(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_audit_overlays(date)           TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_audit_empty_freerolls(date)    TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_audit_tuner_health(date)       TO service_role;

COMMIT;
