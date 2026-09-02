-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826174955; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- BRAIN TELEMETRY part 1 (2026-08-26). Repo: supabase/migrations/20260826174902_brain_telemetry.sql

create table if not exists public.horse_brain_telemetry (
  day        date not null,
  feature    text not null,
  fires      bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, feature)
);

comment on table public.horse_brain_telemetry is
  'Per-day fire counts of brain layers at LIVE tables only (engine/BrainTelemetry.ts). Proof that deployed logic executes. layer_silent audit findings and the /horses/hand-reviews panel read this.';

alter table public.horse_brain_telemetry enable row level security;

create or replace function public.fn_brain_telemetry_add(p_day date, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when r->>'feature' is null or length(r->>'feature') = 0 or length(r->>'feature') > 64;
    insert into horse_brain_telemetry as t (day, feature, fires)
    values (p_day, r->>'feature', coalesce((r->>'fires')::bigint, 0))
    on conflict (day, feature) do update set
      fires = t.fires + excluded.fires,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.fn_brain_telemetry_add(date, jsonb) from public;
grant execute on function public.fn_brain_telemetry_add(date, jsonb) to service_role;

create or replace function public.ca_brain_telemetry(p_days int default 7)
returns setof public.horse_brain_telemetry
language plpgsql security definer set search_path = public stable as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select * from horse_brain_telemetry
    where day > current_date - least(greatest(coalesce(p_days, 7), 1), 60)
    order by day desc, fires desc;
end $$;
revoke all on function public.ca_brain_telemetry(int) from public;
grant execute on function public.ca_brain_telemetry(int) to authenticated, service_role;

create or replace function public.fn_audit_layer_silence(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  f jsonb;
  feat record;
begin
  select coalesce(sum(fires), 0) into v_decides
  from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return jsonb_build_array(jsonb_build_object(
      'severity', 'critical',
      'category', 'schema',
      'code', 'telemetry_dark',
      'title', 'Brain telemetry recorded ' || v_decides || ' decisions for ' || p_day,
      'evidence', jsonb_build_object('decide_fires', v_decides),
      'recommendation', 'Either BrainTelemetryFlush is not running (check engine logs for the flush service), the deploy predates telemetry, or the fleet was down. Nothing about layer health can be known for this day.'
    ));
  end if;

  for feat in
    select * from (values
      ('preflop_v7',        'critical', 'the V7 preflop engine - every preflop decision should route through it'),
      ('v15_nut_status',    'critical', 'V15 Omaha nut awareness - fires on every made flush/straight in PLO'),
      ('banded_mc_omaha',   'critical', 'Omaha banded equity (the reservoir sampler feeds this path)'),
      ('banded_mc_nlh',     'critical', 'NLH banded equity'),
      ('icm_real',          'warn',     'V16 real ICM - fires on tournament decisions when the context carries stacks+payouts'),
      ('v16_hu_overlay',    'warn',     'V16 heads-up overlay - fires whenever a pot is two-handed postflop'),
      ('v15_eq_capped',     'warn',     'V15 equity cap - fires when dominated hands face aggression'),
      ('v16_reads_cbet',    'warn',     'deep-read c-bet scaling - needs 10+ observed c-bet opportunities per opponent'),
      ('v16_sizecond_bigbet', 'warn',   'size-conditioned sampling - fires when a 20bb+ bet is on the newest street')
    ) as t(feature, severity, why)
  loop
    if not exists (
      select 1 from horse_brain_telemetry
      where day = p_day and feature = feat.feature and fires > 0
    ) then
      f := jsonb_build_object(
        'severity', feat.severity,
        'category', 'logic',
        'code', 'layer_silent',
        'title', 'Deployed layer ' || feat.feature || ' fired ZERO times',
        'evidence', jsonb_build_object('feature', feat.feature, 'decide_fires', v_decides, 'expectation', feat.why),
        'recommendation', 'The code is deployed but never executes at live tables. Find the gate that turned it off - flag defaults, wiring, or an upstream condition that can no longer be true.'
      );
      v_findings := v_findings || f;
    end if;
  end loop;

  return v_findings;
end $$;
revoke all on function public.fn_audit_layer_silence(date) from public;
grant execute on function public.fn_audit_layer_silence(date) to service_role;
