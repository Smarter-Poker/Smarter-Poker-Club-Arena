-- ===========================================================================
-- THE WATCHLIST STOPPED AT V19 (2026-09-01)
--
-- fn_audit_layer_silence carries a HARDCODED list of twenty features. It is a
-- good detector and it works. It also has to be edited by hand every time a
-- layer ships, and it had not been since 2026-08-27.
--
-- MEASURED: of the 60 features that fired in the last seven days, FORTY were
-- unwatched, including every layer from V20 to V32 -
--
--   v20_commit_bar, v20_mzone_wired, v20_pressure_cap, v20_pressure_read,
--   v20_weak2p_demote, v21_dominated_cap, v21_nut_status, v21_scare_cap,
--   v21_scare_commit, v21_war_gate, v23_bounty_call, v23_plan_callonce,
--   v23_plan_fold, v23_river_read, v23_spin, v24_bounty_pull, v26_prize_read,
--   v27_gto_bb_defend, v27_gto_open_jam, v29_gto_flop_defend,
--   v29_gto_flop_open, v30_gto_river_open, v30_gto_turn_open, v31_gto_open,
--   v32_defend_call, v32_defend_fold, v32_defend_no_range,
--   v32_defend_pass_strong
--
-- A silent V32 would never have been reported. v23_river_read fired ZERO on
-- 2026-08-31 after 4,205 fires two days earlier and nothing said so.
--
-- The root cause is the hand-maintained list, so a longer hand-maintained
-- list is not the fix. These two checks derive the watchlist from what each
-- layer has ACTUALLY DONE, so every future layer is covered on the day it
-- first fires, with nothing to remember.
--
--   layer_went_silent   fired on 2+ of the previous 7 days, zero today
--   layer_fire_collapse fires per 1,000 decisions fell below 40% of its own
--                       trailing median
--
-- Rates, never raw counts: the fleet's daily volume swings by 40% and a busy
-- day would otherwise mask a layer that stopped firing.
--
-- TUNED, NOT GUESSED. Backtested before shipping, and re-verified after apply:
--   2026-08-28  0 alarms
--   2026-08-29  1 alarm   icm_legacy
--   2026-08-30  1 alarm   icm_legacy
--   2026-08-31  5 alarms  v23_river_read went silent; icm_legacy,
--                         v16_unblocker, v18_self_image and v15_nut_status
--                         collapsed
-- Nothing on a quiet day, and on the day the V29-V32 solver stack displaced
-- the heuristic layers it names precisely those layers. A 30% floor missed
-- v18_self_image, which is the case that motivated the check, so the floor is
-- 40%.
--
-- TIER 3. Rollback at the foot. One transaction, per the production DDL
-- policy: a PostgREST schema reload costs ~28s on this database.
-- ===========================================================================
begin;

create or replace function public.fn_audit_layer_drift(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  v_already text[];
  r record;
begin
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';

  -- Below this the day tells us nothing about any layer, and
  -- fn_audit_layer_silence already raises telemetry_dark for it.
  if v_decides < 1000 then
    return v_findings;
  end if;

  -- Whatever the curated detector already reported, this one stays quiet
  -- about. Read from its OUTPUT rather than re-listing its features, so the
  -- two cannot drift apart.
  select coalesce(array_agg(f->'evidence'->>'feature'), '{}')
    into v_already
    from jsonb_array_elements(fn_audit_layer_silence(p_day)) f
   where f->>'code' = 'layer_silent';

  -- ── 1. A layer that was firing and stopped ────────────────────────────
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

  -- ── 2. A layer that collapsed without going silent ────────────────────
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
    cur as (select feature, rate as cur_rate, fires as cur_fires from rate where day = p_day),
    base as (
      select feature,
             (percentile_cont(0.5) within group (order by rate))::numeric as med_rate,
             count(*) as n_days,
             sum(fires) as prior_fires
        from rate where day < p_day group by feature
    )
    select c.feature, c.cur_rate, c.cur_fires, b.med_rate, b.n_days, b.prior_fires
      from cur c join base b using (feature)
     where b.n_days >= 3
       and b.prior_fires >= 5000          -- a rare layer's noise is not a signal
       and b.med_rate > 0
       and c.cur_rate < b.med_rate * 0.40
       and not (c.feature = any(v_already))
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
        'rate_per_1k_median', round(r.med_rate, 2),
        'pct_drop', round(100 * (1 - r.cur_rate / r.med_rate)),
        'fires_today', r.cur_fires,
        'prior_fires', r.prior_fires,
        'baseline_days', r.n_days
      ),
      'recommendation',
        'Measured per 1,000 decisions, so fleet volume is already divided out - ' ||
        'this is a real change in how often the layer runs. Two innocent ' ||
        'explanations: a SUPERSEDED layer legitimately declines (icm_legacy as ' ||
        'icm_real took over), and a newer layer that RETURNS EARLY displaces the ' ||
        'ones below it (V29-V32 did exactly that to V15-V23 on 2026-08-31). ' ||
        'Both are worth confirming rather than assuming, because the third ' ||
        'explanation is a gate that broke.'
    );
  end loop;

  return v_findings;
end
$function$;

revoke all on function public.fn_audit_layer_drift(date) from public, anon, authenticated;
grant execute on function public.fn_audit_layer_drift(date) to service_role;

do $splice$
declare
  v_def text;
  v_anchor constant text := 'v_findings := v_findings || fn_audit_river_aggression_ev(p_day);';
  v_new constant text := 'v_findings := v_findings || fn_audit_river_aggression_ev(p_day);'
    || E'\n  -- 2026-09-01: layers that stopped firing or collapsed, derived from'
    || E'\n  -- what each layer has actually done - no hand-maintained watchlist.'
    || E'\n  v_findings := v_findings || fn_audit_layer_drift(p_day);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';

  if position('fn_audit_layer_drift(p_day)' in v_def) > 0 then
    raise notice 'layer drift hook already present';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'expected exactly one river-EV hook to anchor on, found %',
      (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  end if;

  execute replace(v_def, v_anchor, v_new);
end
$splice$;

revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;

do $assert$
declare
  v_def text;
  v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
  if position('fn_audit_layer_drift(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the audit does not call the layer-drift check';
  end if;
  if position('fn_audit_river_aggression_ev(p_day)' in v_def) = 0
     or position('fn_audit_nightly_job_health(p_day)' in v_def) = 0
     or position('fn_audit_fleet_health(p_day)' in v_def) = 0
     or position('fn_audit_layer_silence_and_coverage(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: a hook was lost by the splice';
  end if;

  -- Behavioural: the tuning above must reproduce.
  select jsonb_array_length(fn_audit_layer_drift('2026-08-31'::date)) into v_n;
  if v_n < 4 or v_n > 8 then
    raise exception 'POST-APPLY: layer drift produced % findings for 2026-08-31, expected 4 to 8', v_n;
  end if;
end
$assert$;

commit;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- begin;
--   do $rb$
--   declare
--     v_def text;
--     v_hook constant text :=
--       E'\n  -- 2026-09-01: layers that stopped firing or collapsed, derived from'
--       || E'\n  -- what each layer has actually done - no hand-maintained watchlist.'
--       || E'\n  v_findings := v_findings || fn_audit_layer_drift(p_day);';
--   begin
--     select pg_get_functiondef(p.oid) into v_def
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
--     if position(v_hook in v_def) = 0 then
--       raise exception 'ROLLBACK: hook not found in its expected form - undo by hand';
--     end if;
--     execute replace(v_def, v_hook, '');
--   end
--   $rb$;
--   revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
--   grant execute on function public.fn_run_horse_daily_audit(date) to service_role;
--   drop function if exists public.fn_audit_layer_drift(date);
-- commit;
