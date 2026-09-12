-- 20260912101626_audit_detectors_name_what_they_cannot_tell.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Two daily-audit detectors state a CAUSE they never checked. Both were found
-- by the 2026-09-12 daily horse audit analysis reading the 2026-09-11 row, and
-- both are CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and
-- must have its own name. Neither is a new detector and neither repairs
-- anything - each one stops an existing detector asserting something it has no
-- evidence for.
--
-- 1. fn_audit_layer_drift reports `fallback_went_quiet` with the title
--    "... - the primary path covered every spot". That sentence is a
--    conclusion, and the function never tests it. It is currently FALSE for the
--    biggest thing that has happened to the brain this week:
--
--      gto_miss_no_cell           100,004 fires in the prior week -> 0 on 09-11
--      gto_miss_hand_not_in_cell   18,442                         -> 0
--      gto_miss_empty_store           228                         -> 0
--
--    all three reported as "the primary path covered every spot". Their primary
--    is v31_gto_open, and it fired 62,786 times on 2026-09-08 and ZERO every
--    day since. PR #3849 ("certify and wire the V31 solver corpus", merged
--    2026-09-08) removed v31_gto_open from HorseLogic.ts and pointed the read
--    path at the certified store - and that store is empty: gto_v31_datasets,
--    gto_v31_runtime_cells and gto_v31_source_artifacts all hold 0 rows, and
--    solver_worker_heartbeats and solver_compact_heartbeats have never held
--    one. The fallbacks went quiet because the lane that emits them was
--    retired, not because coverage improved. The panel said the opposite.
--
--    A fallback going quiet has two causes and this function cannot separate
--    them, so it now says so instead of guessing. The title states only what
--    was counted; the recommendation names both causes and the one-line way to
--    tell them apart. Severity stays `info` - the intended direction really is
--    zero, and promoting every retirement to a warning is the alarm-always-on
--    failure 10.84 warns about.
--
-- 2. fn_audit_league_coverage reports `league_card_starved` at warn for any
--    matchup seen in 45 days but not in 7, and tells the reader to "reduce
--    PAIRS_PER_MATCHUP, raise MAX_RUN_MS, or trim the card". All three
--    matchups it named on 2026-09-11 were ALREADY trimmed from the card, on
--    purpose, with written reasoning in HorseLeague.ts:
--
--      v16_ratio_rescale    removed 2026-09-05  (last run 0.00 +/- 0.00)
--      v18_exploit_size     removed 2026-09-01  (last run 0.00 +/- 0.00)
--      v31_gto_suit_aware   removed 2026-09-01  (only run 0.00 +/- 0.00)
--
--    so the finding sends the next agent to tune a budget that is not the
--    problem, and it will keep doing it until the 45-day window rolls past.
--
--    The card lives in TypeScript and this function cannot read it, but it does
--    not need to: an exactly-zero result with an exactly-zero standard error
--    over a full matchup is not a dead heat, it is the signature of two arms
--    that played byte-identical poker, and that inert signature is precisely
--    why each of these was pulled. A stale matchup whose LAST recorded result
--    was 0.00 +/- 0.00 is now reported as `league_matchup_inert` at note,
--    naming the signature. A stale matchup that produced a real measurement and
--    then stopped still gets the original `league_card_starved` warn, which is
--    the case that genuinely is a budget problem.
--
-- NOT CHANGED, DELIBERATELY: the `layer_went_silent` warn on v31_gto_open
-- itself is CORRECT and should be answered by deleting that counter, which is
-- what its own recommendation already says. Retiring the counter is an engine
-- change in HorseDataLedger.ts, not an audit change, and it is recorded as an
-- action on the 2026-09-11 panel rather than smuggled in here.
--
-- One transaction (production DDL policy rule 1). Functions only - no table
-- DDL, no foreign key, no lock on a hot relation (rule 7). Signature,
-- volatility, security and search_path are reproduced exactly as production
-- holds them; the grants are restated because CREATE OR REPLACE re-declares
-- the functions, and they match what production already holds, so no privilege
-- changes.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_audit_layer_drift(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  v_already text[];
  r record;
  /*
   * FALLBACK COUNTERS: SILENCE IS THE GOAL, BUT NOT ALWAYS THE CAUSE
   * Some counters name the DEGRADED path, not a layer: icm_legacy is the flat
   * heuristic used only when TournamentBrainContext arrives without stacks or
   * payouts (icm_real takes over the moment it has them), icm_warming is a
   * context that has not arrived yet, gto_depth_fallback and gto_miss_* are
   * the solver store having no cell for the spot. Zero fires on a big day is
   * the INTENDED direction for all of them, so their silence is info rather
   * than a warning - the six-day icm_legacy migration to icm_real reached
   * exactly zero on 2026-09-04 and this function used to report it as a layer
   * that "was executing and is not any more".
   *
   * What this function CANNOT tell (2026-09-12) is WHY one went quiet. The
   * primary genuinely covering every spot, and the whole lane being retired by
   * a deploy, produce an identical zero here. On 2026-09-11 all three
   * gto_miss_* counters read zero and were reported as "the primary path
   * covered every spot" while their primary, v31_gto_open, had itself been
   * removed from the source by PR #3849 and the certified store it was
   * repointed at was empty. So the title now states only what was counted and
   * the recommendation names both causes. A fallback that starts firing AGAIN
   * is caught by the ratio checks in fn_audit_data_receipts, not here.
   */
  v_fallback_exact constant text[] := array['icm_legacy', 'icm_warming', 'gto_depth_fallback'];
  v_fallback_prefix constant text[] := array['gto_miss_'];
  v_is_fallback boolean;
begin
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return v_findings;
  end if;

  select coalesce(array_agg(f->'evidence'->>'feature'), '{}')
    into v_already
    from jsonb_array_elements(fn_audit_layer_silence(p_day)) f
   where f->>'code' = 'layer_silent';

  -- 1. A layer that was firing and stopped.
  for r in
    with hist as (
      select feature,
             count(*) filter (where day < p_day and fires > 0) as prior_days,
             coalesce(max(fires) filter (where day = p_day), 0) as today,
             coalesce(sum(fires) filter (where day < p_day), 0) as prior_fires,
             max(day) filter (where day < p_day and fires > 0) as last_fired
        from horse_brain_telemetry
       where day between p_day - 7 and p_day and feature <> 'decide'
       group by feature
    )
    select * from hist
     where prior_days >= 2 and today = 0 and not (feature = any(v_already))
     order by prior_fires desc
  loop
    v_is_fallback := r.feature = any(v_fallback_exact)
      or exists (select 1 from unnest(v_fallback_prefix) p where left(r.feature, length(p)) = p);
    if v_is_fallback then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'info',
        'category', 'logic',
        'code', 'fallback_went_quiet',
        'title', 'Fallback ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day,
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'cause_not_determined', true
        ),
        'recommendation',
          'This counter names a degraded path (the legacy ICM heuristic, a ' ||
          'warming context, a solver-store miss), so zero is the intended ' ||
          'direction and this is not a warning. It does NOT by itself mean the ' ||
          'primary path covered every spot - this check cannot tell that from ' ||
          'the whole lane having been retired by a deploy, and the two look ' ||
          'identical here. Separate them in one step: if the fallback primary ' ||
          'is still firing today the coverage reading is the right one; if the ' ||
          'primary also read zero, or its feature name no longer appears in ' ||
          'server/src, the lane was retired and this counter should be deleted ' ||
          'with it. Measured 2026-09-11: all three gto_miss_* counters reached ' ||
          'zero because PR #3849 removed their primary v31_gto_open on ' ||
          '2026-09-08 and repointed the read path at a certified store that ' ||
          'holds no rows - which is the opposite of coverage. If it starts ' ||
          'firing again the receipts audit will say so.'
      );
      continue;
    end if;
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'layer_went_silent',
      'title', 'Layer ' || r.feature || ' fired ' || r.prior_fires ||
               ' times in the previous week and ZERO on ' || p_day,
      'evidence', jsonb_build_object(
        'feature', r.feature,
        'prior_days_active', r.prior_days,
        'prior_fires', r.prior_fires,
        'last_fired', r.last_fired,
        'decide_fires', v_decides
      ),
      'recommendation',
        'This layer was executing and is not any more. Trace the gate: a flag ' ||
        'default, an upstream condition that can no longer be true, or a newer ' ||
        'layer returning before it. A retired layer is a valid answer - if the ' ||
        'feature name no longer exists in the source it is not a regression, ' ||
        'and this finding should be answered by deleting the counter.'
    );
  end loop;

  -- 2. A layer that collapsed without going silent - REPORTED ON THE DAY OF
  --    THE STEP ONLY (2026-09-04).
  for r in
    with dec as (
      select day, sum(fires) filter (where feature = 'decide') as d
        from horse_brain_telemetry
       where day between p_day - 7 and p_day
       group by day
      having sum(fires) filter (where feature = 'decide') > 1000
    ),
    rate as (
      select t.feature, t.day, (t.fires::numeric * 1000) / dec.d as rate, t.fires
        from horse_brain_telemetry t
        join dec on dec.day = t.day
       where t.feature <> 'decide'
    ),
    cur  as (select feature, rate as cur_rate,  fires as cur_fires  from rate where day = p_day),
    prev as (select feature, rate as prev_rate, fires as prev_fires from rate where day = p_day - 1),
    base as (
      select feature,
             (percentile_cont(0.5) within group (order by rate))::numeric as med_rate,
             count(*) as n_days,
             sum(fires) as prior_fires
        from rate where day < p_day group by feature
    )
    select c.feature, c.cur_rate, c.cur_fires, b.med_rate, b.n_days, b.prior_fires,
           p.prev_rate, p.prev_fires
      from cur c
      join base b using (feature)
      left join prev p using (feature)
     where b.n_days >= 3
       and b.prior_fires >= 5000
       and b.med_rate > 0
       and c.cur_rate < b.med_rate * 0.40
       -- THE STEP MUST BE NEW. If yesterday was already below the line, this
       -- is the same step reported again - the median simply has not rolled
       -- past it yet. Reporting it daily for a week is what buried three real
       -- criticals under three false ones on 2026-09-01.
       and (p.prev_rate is null or p.prev_rate >= b.med_rate * 0.40)
       -- AND IT MUST ACTUALLY HAVE FALLEN. icm_legacy went 441 -> 641 fires
       -- and v16_unblocker 2,428 -> 2,512 on the day they were both reported
       -- as collapsing. A layer whose raw count rose is not collapsing today,
       -- whatever a median that straddles a deploy says.
       and (p.prev_fires is null or c.cur_fires < p.prev_fires)
     order by (1 - c.cur_rate / b.med_rate) desc
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'layer_fire_collapse',
      'title', 'Layer ' || r.feature || ' fell to ' ||
               round(100 * (1 - r.cur_rate / r.med_rate)) || '% below its usual rate',
      'evidence', jsonb_build_object(
        'feature', r.feature,
        'rate_per_1k_today', round(r.cur_rate, 2),
        'rate_per_1k_yesterday', round(coalesce(r.prev_rate, 0), 2),
        'rate_per_1k_median', round(r.med_rate, 2),
        'pct_drop', round(100 * (1 - r.cur_rate / r.med_rate)),
        'fires_today', r.cur_fires,
        'fires_yesterday', coalesce(r.prev_fires, 0),
        'prior_fires', r.prior_fires,
        'baseline_days', r.n_days,
        'step_day', p_day
      ),
      'recommendation',
        'Reported ONLY on the day the step happened: yesterday was still near ' ||
        'the median and the raw count fell today, so this is new rather than a ' ||
        'week-old change the median has not caught up with. Measured per 1,000 ' ||
        'decisions, so fleet volume is already divided out. Two innocent ' ||
        'explanations remain and both are worth confirming rather than ' ||
        'assuming: a SUPERSEDED layer legitimately declining (icm_legacy as ' ||
        'icm_real took over), and a newer layer that RETURNS EARLY displacing ' ||
        'the ones below it (V32 did exactly that to v16_reads_tell and ' ||
        'v16_unblocker on 2026-08-31). The third explanation is a broken gate.'
    );
  end loop;

  return v_findings;
end
$function$;

CREATE OR REPLACE FUNCTION public.fn_audit_league_coverage(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_recent int;
  v_stale text[];
  v_inert text[];
begin
  select count(distinct matchup) into v_recent
  from horse_league_results where run_date > p_day - 7;

  -- Seen in the last 45 days, absent from the last 7.
  with stale as (
    select distinct matchup m from horse_league_results where run_date > p_day - 45
    except
    select distinct matchup from horse_league_results where run_date > p_day - 7
  ),
  -- THE LAST THING EACH ONE MEASURED. An exactly-zero result with an
  -- exactly-zero standard error over a full matchup is not a dead heat: it is
  -- two arms that played byte-identical poker, which is the signature of a flag
  -- that no longer reaches a decision. Those get PULLED from the card on
  -- purpose (HorseLeague.ts carries the reasoning for v16_ratio_rescale,
  -- v18_exploit_size and v31_gto_suit_aware), so reporting them as a starved
  -- budget sends the next agent to tune MAX_RUN_MS for no reason.
  last_run as (
    select distinct on (r.matchup) r.matchup, r.bb100, r.stderr
      from horse_league_results r
      join stale on stale.m = r.matchup
     order by r.matchup, r.run_date desc
  )
  select coalesce(array_agg(matchup order by matchup) filter (where not (bb100 = 0 and stderr = 0)), '{}'),
         coalesce(array_agg(matchup order by matchup) filter (where bb100 = 0 and stderr = 0), '{}')
    into v_stale, v_inert
    from last_run;

  if array_length(v_stale, 1) > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'gto',
      'code', 'league_card_starved',
      'title', array_length(v_stale, 1) || ' league matchup(s) unmeasured for 7+ days',
      'evidence', jsonb_build_object('stale_matchups', to_jsonb(v_stale), 'measured_last_7d', v_recent),
      'recommendation', 'The nightly budget is not reaching these matchups even with daily rotation. Their layers are unmeasured - reduce PAIRS_PER_MATCHUP, raise MAX_RUN_MS, or trim the card. A layer nobody measures is a layer nobody can defend. Each of these produced a REAL measurement before it stopped, so the budget is the thing to look at; matchups whose last result was 0.00 +/- 0.00 are reported separately as inert.'
    );
  end if;

  if array_length(v_inert, 1) > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'note',
      'category', 'gto',
      'code', 'league_matchup_inert',
      'title', array_length(v_inert, 1) || ' league matchup(s) stopped running after measuring exactly nothing',
      'evidence', jsonb_build_object('inert_matchups', to_jsonb(v_inert), 'measured_last_7d', v_recent,
                                     'signature', '0.00 bb/100 with 0.00 stderr on the last recorded run'),
      'recommendation', 'Probably not a defect and definitely not a budget problem: the last run of each returned 0.00 bb/100 with 0.00 stderr, which over a full matchup means the two arms played byte-identical poker rather than dead even. A flag that no longer reaches a decision is the usual cause, and the fix is to take the matchup off the card - which is what HorseLeague.ts already did, with the reasoning, for v16_ratio_rescale (dead by precedence under V38), v18_exploit_size (impossible by construction: a mirror matchup cannot produce an exploitable opponent) and v31_gto_suit_aware (too rare to resolve at any affordable sample). Confirm the matchup is commented out on the card and leave it; if it is still ON the card and reporting 0.00 +/- 0.00, that is the defect - the flag is not reaching code.'
    );
  end if;

  if exists (
    select 1 from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
    group by run_date having count(*) < 6
  ) then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'gto',
      'code', 'league_run_partial',
      'title', 'The latest league run completed fewer than 6 matchups',
      'evidence', jsonb_build_object(
        'run_date', (select max(run_date) from horse_league_results where run_date <= p_day + 1),
        'matchups', (select count(*) from horse_league_results
                     where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1))
      ),
      'recommendation', 'Expected with a large card and a fixed budget - the rotation covers the rest over following nights. Only a concern if the same matchups keep leading every night.'
    );
  end if;

  return v_findings;
end
$function$;

-- OPERATOR TELEMETRY, NOT PLAYER SURFACE. CREATE OR REPLACE re-declares both,
-- so the grants are restated rather than inherited silently. This is what
-- production already holds for these two, so no privilege changes. PUBLIC is
-- named as well as the roles because anon inherits whatever PUBLIC holds.
REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_audit_league_coverage(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_league_coverage(date) TO service_role;

COMMIT;
