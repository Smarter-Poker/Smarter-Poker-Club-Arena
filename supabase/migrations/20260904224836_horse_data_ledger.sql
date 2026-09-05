-- ═══════════════════════════════════════════════════════════════════════════
-- HORSE DATA LEDGER (Phase 1 of .agent/plans/HORSE-REALTIME-BUILD-PLAN.md)
-- Dan 2026-09-04: "horses need to know how to access this data, what data
-- they are supposed to be consuming, how to consume it, how to process it
-- and why". server/src/engine/HorseDataLedger.ts is the contract; the engine
-- upserts it here at boot (HorseDataLedgerSync). Two readers:
--   fn_audit_data_receipts(day) - folded into fn_run_horse_daily_audit:
--     data_unread when a receipt fires below its expected share of its
--     denominator, data_stale when a nightly source table has no fresh row.
--   ca_horse_data_ledger(day) - the panel's "What The Horses Consumed".
-- ═══════════════════════════════════════════════════════════════════════════
begin;

create table if not exists public.horse_data_ledger (
  key            text primary key,           -- '<kind>:<name>'
  kind           text not null,
  source         text not null,
  cadence        text not null,
  consumer       text not null,
  note           text not null default '',
  ratio_of       text,
  min_ratio      numeric,
  day_column     text,
  freshness_days int,
  since          text not null default '',
  updated_at     timestamptz not null default now()
);

alter table public.horse_data_ledger enable row level security;
-- No browser policy: written by the engine (service role), read through the
-- admin RPC below. 20260826_daemon_functions_are_not_browser_callable.sql
-- is the pattern.
revoke all on public.horse_data_ledger from anon, authenticated;

comment on table public.horse_data_ledger is
  'Every input the horse brain consumes: source, cadence, consumer, receipt. Upserted at engine boot from server/src/engine/HorseDataLedger.ts.';

-- Fires for one telemetry key on one day; a key ending in * sums its family.
create or replace function public.fn_ledger_fires(p_day date, p_key text)
returns bigint
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(t.fires), 0)::bigint
    from horse_brain_telemetry t
   where t.day = p_day
     and case when right(p_key, 1) = '*'
              then t.feature like replace(left(p_key, length(p_key) - 1), '_', '\_') || '%'
              else t.feature = p_key end;
$$;

create or replace function public.fn_audit_data_receipts(p_day date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_fires bigint;
  v_denom bigint;
  v_ratio numeric;
  v_ledger_rows bigint;
  v_ledger_age interval;
  v_fresh boolean;
  v_table_exists boolean;
begin
  select count(*), now() - max(updated_at) into v_ledger_rows, v_ledger_age
    from horse_data_ledger;

  -- The ledger itself is a datum. No rows = the engine never synced it;
  -- an old sync = the running brain is not the one the ledger describes.
  if v_ledger_rows = 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'critical', 'category', 'schema', 'code', 'data_ledger_missing',
      'title', 'horse_data_ledger is empty - the engine has not synced its contract',
      'evidence', jsonb_build_object('rows', 0),
      'recommendation', 'HorseDataLedgerSync runs at engine boot. Either the engine has not restarted since the ledger shipped or the sync is failing (horse_error_log / container logs, context HorseDataLedgerSync).');
    return v_findings;
  end if;

  -- ── receipts: did each layer fire its expected share? ────────────────
  for r in
    select l.key, split_part(l.key, ':', 2) as feature, l.consumer, l.ratio_of, l.min_ratio, l.note, l.since
      from horse_data_ledger l
     where l.kind = 'receipt'
     order by l.key
  loop
    v_fires := fn_ledger_fires(p_day, r.feature);
    if r.ratio_of is null then
      -- table-mix dependent: only a zero against a big day is worth a line
      continue;
    end if;
    v_denom := fn_ledger_fires(p_day, r.ratio_of);
    if v_denom < 1000 then
      continue; -- the denominator itself is too small to judge anything
    end if;
    v_ratio := v_fires::numeric / v_denom;
    if r.min_ratio is not null and v_ratio < r.min_ratio then
      v_findings := v_findings || jsonb_build_object(
        'severity', case when v_fires = 0 then 'critical' else 'warn' end,
        'category', 'logic',
        'code', 'data_unread',
        'title', r.feature || ' fired ' || v_fires || ' times against ' || v_denom || ' ' || r.ratio_of ||
                 ' (' || round(v_ratio * 100, 3) || '%, ledger expects >= ' || round(r.min_ratio * 100, 3) || '%)',
        'evidence', jsonb_build_object(
          'feature', r.feature, 'fires', v_fires, 'ratio_of', r.ratio_of, 'denominator', v_denom,
          'ratio', round(v_ratio, 6), 'min_ratio', r.min_ratio, 'consumer', r.consumer, 'since', r.since),
        'recommendation', case when v_fires = 0
          then 'A registered consumer produced no receipt all day: the gate in front of ' || r.consumer || ' is closed (flag default, upstream condition, or the layer was removed without retiring its ledger row). Trace the gate in the source before touching the ratio.'
          else 'The consumer runs but far below the share the ledger expects. Either the fleet mix changed (then lower min_ratio in HorseDataLedger.ts with the evidence) or an upstream condition narrowed. ' || r.note end);
    end if;
  end loop;

  -- ── tables: is each nightly/boot source fresh? ───────────────────────
  for r in
    select l.key, split_part(l.key, ':', 2) as tbl, l.cadence, l.consumer, l.day_column, l.freshness_days
      from horse_data_ledger l
     where l.kind = 'table' and l.day_column is not null and l.freshness_days is not null
     order by l.key
  loop
    select exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = r.tbl
    ) into v_table_exists;
    if not v_table_exists then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical', 'category', 'schema', 'code', 'data_stale',
        'title', 'Ledger table ' || r.tbl || ' does not exist',
        'evidence', jsonb_build_object('table', r.tbl),
        'recommendation', 'The ledger names a table the schema does not have. Either the migration was never applied or the ledger row is wrong.');
      continue;
    end if;
    -- freshness: any row whose day column is within freshness_days of p_day
    -- (timestamps and dates both cast to date).
    execute format(
      'select exists (select 1 from public.%I where (%I)::date >= %L::date - %s)',
      r.tbl, r.day_column, p_day, r.freshness_days
    ) into v_fresh;
    if not v_fresh then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical', 'category', 'schema', 'code', 'data_stale',
        'title', r.tbl || ' has no row within ' || r.freshness_days || ' day(s) of ' || p_day,
        'evidence', jsonb_build_object('table', r.tbl, 'day_column', r.day_column,
                                       'freshness_days', r.freshness_days, 'consumer', r.consumer, 'cadence', r.cadence),
        'recommendation', 'A source the brain or its compilers depend on stopped being written. ' || r.consumer || ' is reading stale memory. Find the writer (the ledger names the cadence) and its error log.');
    end if;
  end loop;

  return v_findings;
end
$function$;

-- The panel read: every ledger row with yesterday's fires and a proven flag.
create or replace function public.ca_horse_data_ledger(p_day date default (current_date - 1))
returns table (
  key text, kind text, name text, source text, cadence text, consumer text, note text,
  ratio_of text, min_ratio numeric, fires bigint, denominator bigint, ratio numeric,
  proven text, since text, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    with l as (
      select d.*, split_part(d.key, ':', 2) as name from horse_data_ledger d
    ),
    f as (
      select l.key,
             case when l.kind = 'receipt' then fn_ledger_fires(p_day, l.name) end as fires,
             case when l.kind = 'receipt' and l.ratio_of is not null then fn_ledger_fires(p_day, l.ratio_of) end as denominator
        from l
    )
    select l.key, l.kind, l.name, l.source, l.cadence, l.consumer, l.note,
           l.ratio_of, l.min_ratio, f.fires, f.denominator,
           case when f.denominator > 0 then round(f.fires::numeric / f.denominator, 6) end as ratio,
           case
             when l.kind = 'receipt' and f.fires > 0 then 'yes'
             when l.kind = 'receipt' and l.ratio_of is null then 'mix'
             when l.kind = 'receipt' and coalesce(f.denominator, 0) < 1000 then 'quiet'
             when l.kind = 'receipt' then 'NO'
             when l.cadence = 'legacy_unused' then 'legacy'
             else 'n/a'
           end as proven,
           l.since, l.updated_at
      from l left join f on f.key = l.key
     order by case l.kind when 'receipt' then 0 when 'table' then 1 when 'profile' then 2
                          when 'mind' then 3 when 'param' then 4 when 'state' then 5 else 6 end,
              l.key;
end
$function$;

revoke all on function public.fn_ledger_fires(date, text) from public, anon, authenticated;
revoke all on function public.fn_audit_data_receipts(date) from public, anon, authenticated;
-- The panel read is for a logged-in horse admin (fn_is_horse_admin inside);
-- PUBLIC and anon are named explicitly because anon inherits PUBLIC.
revoke all on function public.ca_horse_data_ledger(date) from public, anon;
grant execute on function public.ca_horse_data_ledger(date) to authenticated;

-- Fold the receipts into the daily audit, next to the other detectors.
-- (Re-declared in full: CREATE OR REPLACE cannot append a line.)
do $$
declare
  v_def text;
  v_anchor constant text := 'v_findings := v_findings || fn_audit_supply_breaches(p_day);';
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into v_def;
  if position('fn_audit_data_receipts' in v_def) > 0 then
    return; -- already folded in
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'fn_run_horse_daily_audit no longer contains the supply-breaches line; fold fn_audit_data_receipts in by hand';
  end if;
  v_def := replace(v_def, v_anchor,
    v_anchor || E'\n  -- Phase 1 of the real-time build plan (2026-09-04): every ledger receipt'
             || E'\n  -- judged against its expected share, every nightly source for freshness.'
             || E'\n  v_findings := v_findings || fn_audit_data_receipts(p_day);');
  execute v_def;
end $$;

commit;
