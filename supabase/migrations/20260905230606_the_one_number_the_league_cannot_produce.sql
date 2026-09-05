-- ═══════════════════════════════════════════════════════════════════════════
-- THE ONE NUMBER THE LEAGUE CANNOT PRODUCE (2026-09-05, V47)
--
-- The league measures a DIFFERENCE between two configs of the same brain. It
-- can never say whether either plays well. This is the absolute score, from
-- the only reference in the building: the hold em push/fold solver charts.
--
--   agreement = mean over probed spots of the solver's frequency for the
--               action the horse actually chose
--
-- Near 1 = the horse takes the solver's line. Near 0 = it folds what the
-- solver jams. A mixed spot caps at the solver's own mix, deliberately:
-- taking either side of a 50/50 is not a mistake.
--
-- It is NOT exploitability and is not named that - true exploitability needs
-- a best-response calculation. It is agreement with a reference over the
-- spots that reference covers, which is hold em push/fold only, and the row
-- says so in `reference`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.horse_solver_agreement (
  run_date    date not null,
  reference   text not null,
  spots       int  not null default 0,
  agreement   numeric not null default 0,
  pure_misses int  not null default 0,
  created_at  timestamptz not null default now(),
  primary key (run_date, reference)
);

comment on table public.horse_solver_agreement is
  'V47: nightly absolute score of the brain against the hold em push/fold solver charts - the mean solver frequency of the action the horse chose, over the spots the charts cover. Not exploitability; agreement with a reference. Written by HorseLeague after the matchups.';

alter table public.horse_solver_agreement enable row level security;

create or replace function public.fn_horse_solver_agreement_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_solver_agreement as t (run_date, reference, spots, agreement, pure_misses)
    values (
      (r->>'run_date')::date,
      coalesce(r->>'reference', 'gto_charts'),
      coalesce((r->>'spots')::int, 0),
      coalesce((r->>'agreement')::numeric, 0),
      coalesce((r->>'pure_misses')::int, 0)
    )
    on conflict (run_date, reference) do update set
      spots = excluded.spots,
      agreement = excluded.agreement,
      pure_misses = excluded.pure_misses,
      created_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fn_horse_solver_agreement_add(jsonb) from public, authenticated, anon;
grant execute on function public.fn_horse_solver_agreement_add(jsonb) to service_role;

create or replace function public.fn_audit_solver_agreement(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
  prev numeric;
begin
  for r in
    select * from horse_solver_agreement
     where run_date > p_day - 3 and run_date <= p_day + 1
     order by run_date desc limit 1
  loop
    select agreement into prev from horse_solver_agreement
     where reference = r.reference and run_date < r.run_date
     order by run_date desc limit 1;
    if r.spots < 50 then
      v := v || jsonb_build_object('severity','warn','category','gto','code','solver_agreement_thin',
        'title','Solver agreement probed only ' || r.spots || ' spots on ' || r.run_date,
        'evidence', jsonb_build_object('spots', r.spots, 'reference', r.reference),
        'recommendation','The push/fold chart store is nearly empty in this process (GtoChartsLoader). The probe reports what it could reach; a thin sample is a loader problem, not a brain one.');
    elsif prev is not null and r.agreement < prev - 0.03 then
      v := v || jsonb_build_object('severity','critical','category','gto','code','solver_agreement_dropped',
        'title','Solver agreement fell to ' || round(r.agreement, 3) || ' from ' || round(prev, 3),
        'evidence', jsonb_build_object('agreement', r.agreement, 'previous', prev, 'spots', r.spots,
                                       'pure_misses', r.pure_misses, 'reference', r.reference),
        'recommendation','The brain moved AWAY from the solver on spots it used to agree with. This is the one measurement the league cannot make, and a drop after a deploy is a regression in a preflop layer. Diff the day''s engine deploys against HorsePreflop and the GTO consult.');
    else
      v := v || jsonb_build_object('severity','info','category','gto','code','solver_agreement',
        'title','Solver agreement ' || round(r.agreement, 3) || ' over ' || r.spots || ' spots (' || r.pure_misses || ' pure misses)',
        'evidence', jsonb_build_object('agreement', r.agreement, 'previous', prev, 'spots', r.spots,
                                       'pure_misses', r.pure_misses, 'reference', r.reference),
        'recommendation','The absolute score: the mean solver frequency of the action the horse chose, hold em push/fold only. A pure miss is a spot where the solver is 90%+ one way and the horse went the other.');
    end if;
  end loop;
  if v = '[]'::jsonb then
    v := v || jsonb_build_object('severity','info','category','gto','code','solver_agreement_missing',
      'title','No solver agreement row in the last three days',
      'evidence', jsonb_build_object('day', p_day),
      'recommendation','HorseLeague writes it after the nightly matchups. If the league ran and this is absent, the probe threw - check horse_error_log for HorseLeague.agreement.');
  end if;
  return v;
end $$;

revoke all on function public.fn_audit_solver_agreement(date) from public, authenticated, anon;
grant execute on function public.fn_audit_solver_agreement(date) to service_role;

do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into d;
  if position('fn_audit_solver_agreement(p_day)' in d) > 0 then
    return;
  end if;
  d := replace(d,
    'v_findings := v_findings || fn_audit_frequency_leaks(p_day);',
    'v_findings := v_findings || fn_audit_frequency_leaks(p_day);' || chr(10) ||
    '  -- 2026-09-05 V47: the absolute score the league cannot produce.' || chr(10) ||
    '  v_findings := v_findings || fn_audit_solver_agreement(p_day);');
  execute d;
end $patch$;
