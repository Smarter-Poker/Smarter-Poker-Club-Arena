-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829125551; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- How long does a horse actually take to think? Nothing had ever measured it.
-- Full notes in the repo migration
-- 20260829140000_measure_how_long_a_horse_takes_to_think.sql.
-- The code carried a documented "<15ms" budget and no timer anywhere:
-- performance.now() appeared four times in the whole server tree, all four in
-- an offline unit test. A budget nobody measures is a comment.

create table if not exists public.horse_decision_latency (
  day       date        not null,
  scope     text        not null,
  samples   bigint      not null default 0,
  total_ms  double precision not null default 0,
  max_ms    double precision not null default 0,
  buckets   bigint[]    not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (day, scope)
);

comment on table public.horse_decision_latency is
  'How long a live horse decision takes, per day and variant family. Written every minute by the engine flush. Before 2026-08-29 nothing in the platform measured decision latency at all - the "<15ms" budget in the code was never checked against reality.';
comment on column public.horse_decision_latency.buckets is
  'Histogram counts. Upper edges in ms: 1, 2, 5, 10, 15, 25, 50, 100, 200, then an overflow slot for anything slower.';

alter table public.horse_decision_latency enable row level security;

create or replace function public.fn_horse_decision_latency_add(
  p_day  date,
  p_rows jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  insert into public.horse_decision_latency as h (day, scope, samples, total_ms, max_ms, buckets, updated_at)
  select p_day,
         r->>'scope',
         coalesce((r->>'samples')::bigint, 0),
         coalesce((r->>'totalMs')::double precision, 0),
         coalesce((r->>'maxMs')::double precision, 0),
         coalesce(
           (select array_agg(coalesce(b::bigint, 0) order by ord)
              from jsonb_array_elements_text(coalesce(r->'buckets', '[]'::jsonb))
                   with ordinality as t(b, ord)),
           '{}'::bigint[]
         ),
         now()
    from jsonb_array_elements(p_rows) r
   where coalesce(r->>'scope', '') <> ''
  on conflict (day, scope) do update
     set samples  = h.samples + excluded.samples,
         total_ms = h.total_ms + excluded.total_ms,
         max_ms   = greatest(h.max_ms, excluded.max_ms),
         buckets  = (
           select array_agg(coalesce(h.buckets[i], 0) + coalesce(excluded.buckets[i], 0) order by i)
             from generate_series(
                    1,
                    greatest(coalesce(array_length(h.buckets, 1), 0),
                             coalesce(array_length(excluded.buckets, 1), 0))
                  ) as i
         ),
         updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.fn_horse_decision_latency_add(date, jsonb) is
  'Additively fold one minute of decision-latency histograms into horse_decision_latency. Additive so a retry after a failed flush is safe; max_ms is a max rather than a sum, because summing two peaks would invent a decision that never happened.';

revoke all on function public.fn_horse_decision_latency_add(date, jsonb) from public, anon, authenticated;
grant execute on function public.fn_horse_decision_latency_add(date, jsonb) to service_role;

do $$
declare
  v_samples bigint;
  v_max     double precision;
  v_b       bigint[];
begin
  perform public.fn_horse_decision_latency_add('1999-01-01'::date,
    '[{"scope":"__assert__","samples":3,"totalMs":9,"maxMs":5,"buckets":[1,1,1,0]}]'::jsonb);
  perform public.fn_horse_decision_latency_add('1999-01-01'::date,
    '[{"scope":"__assert__","samples":2,"totalMs":4,"maxMs":3,"buckets":[2,0,0,0]}]'::jsonb);

  select samples, max_ms, buckets into v_samples, v_max, v_b
    from public.horse_decision_latency where day = '1999-01-01' and scope = '__assert__';

  if v_samples <> 5 then
    raise exception 'latency samples did not accumulate: got %, expected 5', v_samples;
  end if;
  if v_max <> 5 then
    raise exception 'max_ms must be a max, not a sum: got %, expected 5', v_max;
  end if;
  if v_b[1] <> 3 or v_b[2] <> 1 then
    raise exception 'histogram buckets did not fold element-wise: got %', v_b;
  end if;

  delete from public.horse_decision_latency where day = '1999-01-01' and scope = '__assert__';
end;
$$;
