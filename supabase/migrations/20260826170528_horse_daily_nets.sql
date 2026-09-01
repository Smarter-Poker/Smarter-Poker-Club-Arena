-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826170528; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HORSE DAILY NETS (2026-08-26) - real chip results for the self-tuner.
-- Repo file: supabase/migrations/20260826170508_horse_daily_nets.sql

create table if not exists public.horse_daily_nets (
  horse_user_id uuid not null,
  day           date not null,
  game_variant  text not null,
  format        text not null default 'cash',
  hands         int not null default 0,
  net_bb        numeric not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (horse_user_id, day, game_variant, format)
);

comment on table public.horse_daily_nets is
  'Per-horse/day/variant/format aggregate of EXACT settlement nets in big blinds, flushed ~60s by the engine (HorseHandReview.accumulateHorseNets). Feeds the self-tuner real bb100. Never reconstructed from action logs.';

alter table public.horse_daily_nets enable row level security;

create index if not exists idx_hdn_day on public.horse_daily_nets (day desc);

create or replace function public.fn_horse_daily_nets_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_daily_nets as t (horse_user_id, day, game_variant, format, hands, net_bb)
    values (
      (r->>'horse_user_id')::uuid,
      (r->>'day')::date,
      coalesce(r->>'game_variant', 'nlh'),
      coalesce(r->>'format', 'cash'),
      coalesce((r->>'hands')::int, 0),
      coalesce((r->>'net_bb')::numeric, 0)
    )
    on conflict (horse_user_id, day, game_variant, format) do update set
      hands = t.hands + excluded.hands,
      net_bb = t.net_bb + excluded.net_bb,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fn_horse_daily_nets_add(jsonb) from public;
grant execute on function public.fn_horse_daily_nets_add(jsonb) to service_role;

create or replace function public.sp_prune_horse_hand_reviews() returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  delete from horse_hand_reviews where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from horse_daily_nets where day < current_date - 180;
  get diagnostics m = row_count;
  return n + m;
end $$;
