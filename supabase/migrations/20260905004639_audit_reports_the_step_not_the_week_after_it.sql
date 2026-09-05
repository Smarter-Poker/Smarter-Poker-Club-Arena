-- ============================================================================
-- THE AUDIT REPORTS THE STEP, NOT THE WEEK AFTER IT (2026-09-04)
-- ============================================================================
-- Two detector defects found by reading the panel Dan actually reads, both of
-- which manufacture criticals that bury the real ones.
--
-- 1. layer_fire_collapse fires for a WEEK after any deliberate precedence
--    change. On 2026-09-01 all three of its findings were false:
--      icm_legacy      130.75 -> 23.18 -> 5.71 -> 0.84 -> 0.80 -> 0.46 -> 0.69
--                      per 1k decides: a planned six-day migration to icm_real,
--                      not an event on the audited day at all.
--      v16_reads_tell  8.01 on 08-30 -> 3.72 on 08-31, then flat
--      v16_unblocker  10.44 on 08-30 -> 2.52 on 08-31, then flat
--    Both v16 layers stepped on the SAME day, 08-31, because V32 (deployed
--    08-30) returns early on facing-bet call and fold - exactly where those
--    two read heuristics used to run. That is the intended precedence, and
--    both layers' fires actually ROSE day-over-day into 09-01 (441 -> 641 and
--    2,428 -> 2,512) while the detector called them collapses, because it
--    compares today against a 7-day MEDIAN that straddles the deploy.
--
--    A step is news once, on the day it happens. Two conditions now say so:
--    the previous day must still have been near the median (so the step is
--    NEW), and the raw fire count must actually have fallen (so a layer
--    recovering is never reported as collapsing).
--
-- 2. bust_sweep_lag reported seat TENURE as though it were sweep LAG.
--    `oldest_minutes` was measured from table_seats.joined_at - how long the
--    player had been SEATED, not how long they had been busted-but-unswept.
--    Proof from 2026-09-02: a flagged seat joined at 14:28:45 in a tournament
--    that started at 14:31:36, so the "lag" predated the tournament. The same
--    column drove the critical escalation at > 45. There is no bust timestamp
--    to use - neither table_seats nor tournament_players carries one, and
--    eliminated_at is stamped only once elimination succeeds, which is the
--    thing that has not happened. So the metric is renamed to what it is, and
--    the escalation moves to a signal that is unambiguous and needs no new
--    column: RUNNING tournaments that are already decided and have not paid.
--
--    The underlying cause is NOT a predicate mismatch and is not fixed here:
--    the engine runs 1,300+ table engines in one Node process at 60-98% CPU,
--    and the 5s elimination sweep cannot be scheduled. See the changelog.
--
-- One transaction, per the production DDL policy: two CREATE OR REPLACEs
-- coalesce into a single PostgREST schema reload instead of two 28s ones.
-- ============================================================================

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

COMMIT;
