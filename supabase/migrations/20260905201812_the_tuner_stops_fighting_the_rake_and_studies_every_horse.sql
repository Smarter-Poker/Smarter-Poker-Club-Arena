-- ═══════════════════════════════════════════════════════════════════════════
-- THE TUNER STOPS FIGHTING THE RAKE, AND STUDIES EVERY HORSE (2026-09-05)
--
-- Measured on 2026-09-04: the fleet's cash net was -32.0 bb/100 over 2.67M
-- seat-hands, and hand_history rake (198,206bb) + BBJ drop (23,954bb) for the
-- day equalled the horse loss (220,971bb) to within one percent. The horses
-- play each other (40 human hands in 263,033), so the fleet's loss IS the
-- rake. HorseSelfTuner's "real bb100 < -15 -> regress every dial halfway to
-- neutral" therefore fired on 221 of the 383 horses it studied that night,
-- erasing the +/-0.01 nudges the leak tags had made. Nothing here was a play
-- leak; it was the house edge being read as a personality defect.
--
-- Two things change in the schema:
--
--   1. horse_daily_nets.rake_bb - the horse's weighted-contributed share of
--      the rake, in big blinds, accumulated at settlement by the same
--      allocator the money pipeline uses (allocateWeightedShareCents). The
--      tuner reads (net_bb + rake_bb) as the rake-adjusted result, which is
--      what a human means by "am I beating the game".
--
--   2. horse_daily_play - per-horse/day/format counts of VPIP / PFR / 3-bet /
--      fold-to-3-bet / saw-flop / WWSF / postflop aggression, compiled at
--      settlement by HorsePlayStats (the tuner's own accumulator) and flushed
--      additively like horse_daily_nets. The tuner used to derive these by
--      streaming 120,000 hand_history rows a night - eleven hours of a
--      263,000-hand day - so only 383 of 1,000 horses ever reached the
--      300-hand bar. With this table every horse's full seven days is a few
--      rows.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.horse_daily_nets
  add column if not exists rake_bb numeric not null default 0;

comment on column public.horse_daily_nets.rake_bb is
  'Weighted-contributed rake paid by this horse, in big blinds, over the same hands as net_bb. net_bb + rake_bb is the rake-adjusted result the self-tuner judges by.';

create or replace function public.fn_horse_daily_nets_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_daily_nets as t (horse_user_id, day, game_variant, format, hands, net_bb, rake_bb)
    values (
      (r->>'horse_user_id')::uuid,
      (r->>'day')::date,
      coalesce(r->>'game_variant', 'nlh'),
      coalesce(r->>'format', 'cash'),
      coalesce((r->>'hands')::int, 0),
      coalesce((r->>'net_bb')::numeric, 0),
      coalesce((r->>'rake_bb')::numeric, 0)
    )
    on conflict (horse_user_id, day, game_variant, format) do update set
      hands = t.hands + excluded.hands,
      net_bb = t.net_bb + excluded.net_bb,
      rake_bb = t.rake_bb + excluded.rake_bb,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fn_horse_daily_nets_add(jsonb) from public;
grant execute on function public.fn_horse_daily_nets_add(jsonb) to service_role;

create table if not exists public.horse_daily_play (
  horse_user_id      uuid not null,
  day                date not null,
  format             text not null default 'cash',
  hands              int not null default 0,
  vpip               int not null default 0,
  pfr                int not null default 0,
  three_bets         int not null default 0,
  three_bet_opps     int not null default 0,
  open_raises        int not null default 0,
  faced_3bets        int not null default 0,
  fold_to_3bets      int not null default 0,
  saw_flop           int not null default 0,
  won_when_saw_flop  int not null default 0,
  post_aggr          int not null default 0,
  post_passive       int not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (horse_user_id, day, format)
);

comment on table public.horse_daily_play is
  'Per-horse/day/format frequency counts (VPIP, PFR, 3-bet, fold-to-3-bet, saw flop, WWSF, postflop aggression) compiled at settlement by HorsePlayStats - the self-tuner''s own accumulator - and flushed additively ~60s by HorseHandReview. The tuner studies every horse from this table; hand_history is a fallback only.';

alter table public.horse_daily_play enable row level security;
-- service_role only.

create index if not exists idx_hdp_day on public.horse_daily_play (day desc);

create or replace function public.fn_horse_daily_play_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_daily_play as t (
      horse_user_id, day, format, hands, vpip, pfr, three_bets, three_bet_opps,
      open_raises, faced_3bets, fold_to_3bets, saw_flop, won_when_saw_flop,
      post_aggr, post_passive)
    values (
      (r->>'horse_user_id')::uuid,
      (r->>'day')::date,
      coalesce(r->>'format', 'cash'),
      coalesce((r->>'hands')::int, 0),
      coalesce((r->>'vpip')::int, 0),
      coalesce((r->>'pfr')::int, 0),
      coalesce((r->>'three_bets')::int, 0),
      coalesce((r->>'three_bet_opps')::int, 0),
      coalesce((r->>'open_raises')::int, 0),
      coalesce((r->>'faced_3bets')::int, 0),
      coalesce((r->>'fold_to_3bets')::int, 0),
      coalesce((r->>'saw_flop')::int, 0),
      coalesce((r->>'won_when_saw_flop')::int, 0),
      coalesce((r->>'post_aggr')::int, 0),
      coalesce((r->>'post_passive')::int, 0)
    )
    on conflict (horse_user_id, day, format) do update set
      hands = t.hands + excluded.hands,
      vpip = t.vpip + excluded.vpip,
      pfr = t.pfr + excluded.pfr,
      three_bets = t.three_bets + excluded.three_bets,
      three_bet_opps = t.three_bet_opps + excluded.three_bet_opps,
      open_raises = t.open_raises + excluded.open_raises,
      faced_3bets = t.faced_3bets + excluded.faced_3bets,
      fold_to_3bets = t.fold_to_3bets + excluded.fold_to_3bets,
      saw_flop = t.saw_flop + excluded.saw_flop,
      won_when_saw_flop = t.won_when_saw_flop + excluded.won_when_saw_flop,
      post_aggr = t.post_aggr + excluded.post_aggr,
      post_passive = t.post_passive + excluded.post_passive,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fn_horse_daily_play_add(jsonb) from public;
-- Default privileges hand `authenticated` EXECUTE on every new function; a
-- daemon RPC is not browser-callable (20260826_daemon_functions_are_not_browser_callable).
revoke execute on function public.fn_horse_daily_play_add(jsonb) from authenticated, anon;
grant execute on function public.fn_horse_daily_play_add(jsonb) to service_role;

-- Retention rides the existing daily prune.
create or replace function public.sp_prune_horse_hand_reviews() returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int; k int;
begin
  delete from horse_hand_reviews where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from horse_daily_nets where day < current_date - 180;
  get diagnostics m = row_count;
  delete from horse_daily_play where day < current_date - 180;
  get diagnostics k = row_count;
  return n + m + k;
end $$;

-- Restated so the definer-authorization gate can read it from this file: the
-- prune is a daemon sweep, not browser-callable (20260826_daemon_functions_are_not_browser_callable).
revoke all on function public.sp_prune_horse_hand_reviews() from public, authenticated, anon;
grant execute on function public.sp_prune_horse_hand_reviews() to service_role;
