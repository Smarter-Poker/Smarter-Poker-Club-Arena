-- ===========================================================================
-- RIVER AGGRESSION HAS A WIN SIDE (2026-09-01)
--
-- RECORDED AFTER THE FACT. This migration was applied to production via the
-- Supabase MCP alongside PR #2470 and the file was not committed with it -
-- caught by the verification pass the same day. The definition below is the
-- one that is live; re-running it is a no-op (CREATE OR REPLACE plus an
-- idempotent splice).
--
-- WHY IT EXISTS. river_aggr_lost was the largest single line in the
-- 2026-08-31 audit: 1,545 hands, -97,229bb, roughly five times the whole
-- day's horse net of -19,984bb, and it dominated the tag mix of nine of the
-- ten bleeding horses. It could not be acted on, because detectLeaks returns
-- early on any winning hand - so the tag exists only on losses and has no
-- denominator. A horse that bets every river and one that value-bets
-- perfectly leave identical evidence. Capping the river on that number would
-- be tuning against a sample selected for being negative.
--
-- The engine side (PR #2470) records river_aggr_won on the winning outcome.
-- This function reports both, and says plainly when only one side exists.
-- ===========================================================================
begin;

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

-- Splice the call into the audit by reading the live definition rather than
-- retyping 11.5KB of plpgsql. Idempotent and self-asserting.
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

commit;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- begin;
--   do $rb$
--   declare
--     v_def text;
--     v_hook constant text :=
--       E'\n  -- 2026-09-01: river aggression judged on EV across BOTH outcomes.'
--       || E'\n  v_findings := v_findings || fn_audit_river_aggression_ev(p_day);';
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
--   drop function if exists public.fn_audit_river_aggression_ev(date);
-- commit;
