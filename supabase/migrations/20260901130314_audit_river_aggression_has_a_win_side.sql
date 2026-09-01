-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901130314; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_audit_river_aggression_ev(p_day date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_won_n bigint;  v_won_bb numeric;
  v_lost_n bigint; v_lost_bb numeric;
  v_net numeric;   v_total bigint;
begin
  select count(*), coalesce(sum(net_bb), 0) into v_won_n, v_won_bb
    from horse_hand_reviews
   where played_at >= p_day and played_at < p_day + 1
     and 'river_aggr_won' = any(leak_tags);

  select count(*), coalesce(sum(net_bb), 0) into v_lost_n, v_lost_bb
    from horse_hand_reviews
   where played_at >= p_day and played_at < p_day + 1
     and 'river_aggr_lost' = any(leak_tags);

  v_total := v_won_n + v_lost_n;
  if v_total = 0 then
    return v_findings;
  end if;

  -- The win side only exists from the deploy of 2026-09-01 onward. Until a
  -- full day has both, say so plainly rather than reporting half a ledger as
  -- if it were the whole thing.
  if v_won_n = 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'schema',
      'code', 'river_aggr_ev_one_sided',
      'title', 'River aggression has ' || v_lost_n || ' losing hands recorded and no winning ones',
      'evidence', jsonb_build_object('lost_hands', v_lost_n, 'lost_bb', round(v_lost_bb, 1)),
      'recommendation',
        'The river_aggr_won mirror had not started recording for this day, so ' ||
        'the loss total below has no denominator and no cap should be tuned ' ||
        'against it. Expect both sides from the first full day after the ' ||
        '2026-09-01 engine deploy.'
    );
    return v_findings;
  end if;

  v_net := v_won_bb + v_lost_bb;

  v_findings := v_findings || jsonb_build_object(
    'severity', case when v_net < 0 then 'warn' else 'info' end,
    'category', 'gto',
    'code', 'river_aggression_ev',
    'title',
      'River aggression netted ' || round(v_net, 1) || 'bb over ' || v_total || ' showdowns',
    'evidence', jsonb_build_object(
      'won_hands', v_won_n,
      'won_bb', round(v_won_bb, 1),
      'lost_hands', v_lost_n,
      'lost_bb', round(v_lost_bb, 1),
      'net_bb', round(v_net, 1),
      'bb_per_hand', round(v_net / v_total, 2),
      'win_rate', round(v_won_n::numeric / v_total, 3)
    ),
    'recommendation',
      case when v_net < 0
        then 'Betting the river is losing money across BOTH outcomes, which ' ||
             'the loss-only tag could never establish. Now a cap is worth ' ||
             'testing: flag it, add a league matchup, and do not claim an ' ||
             'improvement without significance.'
        else 'Betting the river is profitable across both outcomes. The large ' ||
             'river_aggr_lost total is the cost of a winning line, not a leak ' ||
             '- do not tighten the river caps on the strength of it.'
      end
  );

  return v_findings;
end
$function$;

revoke all on function public.fn_audit_river_aggression_ev(date) from public, anon, authenticated;
grant execute on function public.fn_audit_river_aggression_ev(date) to service_role;

do $splice$
declare
  v_def text;
  v_anchor constant text := 'v_findings := v_findings || fn_audit_nightly_job_health(p_day);';
  v_new constant text := 'v_findings := v_findings || fn_audit_nightly_job_health(p_day);'
    || E'\n  -- 2026-09-01: river aggression judged on EV across BOTH outcomes.'
    || E'\n  v_findings := v_findings || fn_audit_river_aggression_ev(p_day);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';

  if position('fn_audit_river_aggression_ev(p_day)' in v_def) > 0 then
    raise notice 'river EV hook already present';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'expected exactly one nightly-job-health hook to anchor on, found %',
      (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  end if;

  execute replace(v_def, v_anchor, v_new);
end
$splice$;

revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;

do $assert$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
  if position('fn_audit_river_aggression_ev(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the audit does not call the river EV check';
  end if;
  if position('fn_audit_nightly_job_health(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the nightly-job hook was lost by the splice';
  end if;
  if position('fn_audit_fleet_health(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the fleet-health hook was lost by the splice';
  end if;
  if position('fn_audit_layer_silence_and_coverage(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the layer-silence hook was lost by the splice';
  end if;
end
$assert$;
