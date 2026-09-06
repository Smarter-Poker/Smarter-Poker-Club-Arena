-- ═══════════════════════════════════════════════════════════════════════════
-- A READ IS SCOPED TO THE GAME IT WAS LEARNED IN (2026-09-05, V45)
--
-- horse_mind_stats is one row per player across every game they ever played.
-- A PLO6 VPIP (structurally ~60%) polluted the same player's NLH read; their
-- heads-up stats polluted their 6-max read. HorseMind now keeps a scoped
-- overlay keyed (user, `family:size`) - holdem|omaha x hu|short|full - fed by
-- the same observation as the pooled row, read in preference once it holds
-- 40 hands. This table persists it under the same GREATEST merge as
-- horse_mind_stats, for the same reason: a read that resets on every deploy
-- is a read for nobody, and the players it exists for are the people who
-- play a few hundred hands.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.horse_mind_stats_scoped (
  user_id            text not null,
  scope              text not null,
  hands              integer not null default 0,
  vpip               integer not null default 0,
  pfr                integer not null default 0,
  three_bet          integer not null default 0,
  aggr               integer not null default 0,
  passive            integer not null default 0,
  folds              integer not null default 0,
  faced_aggr         integer not null default 0,
  cbet_opps          integer not null default 0,
  cbet_folds         integer not null default 0,
  f3b_opps           integer not null default 0,
  f3b_folds          integer not null default 0,
  bigbet_sd          integer not null default 0,
  bigbet_sd_strong   integer not null default 0,
  river_bet_opps     integer not null default 0,
  river_bet_folds    integer not null default 0,
  checks             integer not null default 0,
  post_aggr          integer not null default 0,
  post_passive       integer not null default 0,
  snap_bet_sd        integer not null default 0,
  snap_bet_sd_strong integer not null default 0,
  tank_bet_sd        integer not null default 0,
  tank_bet_sd_strong integer not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (user_id, scope),
  constraint horse_mind_stats_scoped_scope_check check (scope ~ '^(holdem|omaha):(hu|short|full)$')
);

comment on table public.horse_mind_stats_scoped is
  'V45: HorseMind opponent counters per (player, card family x table size). Fed by the same observation as horse_mind_stats; read in preference once a scope holds 40 hands. GREATEST-merged by upsert_horse_mind_stats_scoped. No recency columns: the recency window stays pooled.';

alter table public.horse_mind_stats_scoped enable row level security;
create index if not exists idx_hmss_hands on public.horse_mind_stats_scoped (hands desc);

create or replace function public.upsert_horse_mind_stats_scoped(rows jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r jsonb;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(rows) loop
    continue when r->>'user_id' is null or length(r->>'user_id') = 0 or length(r->>'user_id') > 128;
    continue when r->>'scope' is null or (r->>'scope') !~ '^(holdem|omaha):(hu|short|full)$';
    insert into public.horse_mind_stats_scoped as t
      (user_id, scope, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       river_bet_opps, river_bet_folds, checks, post_aggr, post_passive,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong, updated_at)
    values
      (r->>'user_id', r->>'scope',
       coalesce((r->>'hands')::integer, 0),
       coalesce((r->>'vpip')::integer, 0),
       coalesce((r->>'pfr')::integer, 0),
       coalesce((r->>'three_bet')::integer, 0),
       coalesce((r->>'aggr')::integer, 0),
       coalesce((r->>'passive')::integer, 0),
       coalesce((r->>'folds')::integer, 0),
       coalesce((r->>'faced_aggr')::integer, 0),
       coalesce((r->>'cbet_opps')::integer, 0),
       coalesce((r->>'cbet_folds')::integer, 0),
       coalesce((r->>'f3b_opps')::integer, 0),
       coalesce((r->>'f3b_folds')::integer, 0),
       coalesce((r->>'bigbet_sd')::integer, 0),
       coalesce((r->>'bigbet_sd_strong')::integer, 0),
       coalesce((r->>'river_bet_opps')::integer, 0),
       coalesce((r->>'river_bet_folds')::integer, 0),
       coalesce((r->>'checks')::integer, 0),
       coalesce((r->>'post_aggr')::integer, 0),
       coalesce((r->>'post_passive')::integer, 0),
       coalesce((r->>'snap_bet_sd')::integer, 0),
       coalesce((r->>'snap_bet_sd_strong')::integer, 0),
       coalesce((r->>'tank_bet_sd')::integer, 0),
       coalesce((r->>'tank_bet_sd_strong')::integer, 0),
       now())
    on conflict (user_id, scope) do update set
      hands = greatest(t.hands, excluded.hands),
      vpip = greatest(t.vpip, excluded.vpip),
      pfr = greatest(t.pfr, excluded.pfr),
      three_bet = greatest(t.three_bet, excluded.three_bet),
      aggr = greatest(t.aggr, excluded.aggr),
      passive = greatest(t.passive, excluded.passive),
      folds = greatest(t.folds, excluded.folds),
      faced_aggr = greatest(t.faced_aggr, excluded.faced_aggr),
      cbet_opps = greatest(t.cbet_opps, excluded.cbet_opps),
      cbet_folds = greatest(t.cbet_folds, excluded.cbet_folds),
      f3b_opps = greatest(t.f3b_opps, excluded.f3b_opps),
      f3b_folds = greatest(t.f3b_folds, excluded.f3b_folds),
      bigbet_sd = greatest(t.bigbet_sd, excluded.bigbet_sd),
      bigbet_sd_strong = greatest(t.bigbet_sd_strong, excluded.bigbet_sd_strong),
      river_bet_opps = greatest(t.river_bet_opps, excluded.river_bet_opps),
      river_bet_folds = greatest(t.river_bet_folds, excluded.river_bet_folds),
      checks = greatest(t.checks, excluded.checks),
      post_aggr = greatest(t.post_aggr, excluded.post_aggr),
      post_passive = greatest(t.post_passive, excluded.post_passive),
      snap_bet_sd = greatest(t.snap_bet_sd, excluded.snap_bet_sd),
      snap_bet_sd_strong = greatest(t.snap_bet_sd_strong, excluded.snap_bet_sd_strong),
      tank_bet_sd = greatest(t.tank_bet_sd, excluded.tank_bet_sd),
      tank_bet_sd_strong = greatest(t.tank_bet_sd_strong, excluded.tank_bet_sd_strong),
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.upsert_horse_mind_stats_scoped(jsonb) from public, authenticated, anon;
grant execute on function public.upsert_horse_mind_stats_scoped(jsonb) to service_role;
