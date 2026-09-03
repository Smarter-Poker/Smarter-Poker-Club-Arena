-- ═══════════════════════════════════════════════════════════════════════════
-- HORSE HAND REVIEW SYSTEM (Dan 2026-08-26)
--
-- "Every hand where a horse wins or loses 20bb needs to be flagged and
--  reviewed, for every horse, across all cash game variants, MTTs, spins and
--  heads up. Track, audit, correct and improve horse decision making."
--
-- The engine writes one row per horse per hand where |net| >= 20bb, at
-- settlement, from exact in-memory figures (SeatPlayer.totalInvested and the
-- winners list) — NOT reconstructed from hand_history.actions, whose
-- reconstruction was measured failing chip conservation in 38% of hands
-- (2026-08-23 self-tuner audit). Leak detectors tag each row at write time.
--
-- Volume: ~485k hands/day, 3.3% reach a 40bb pot, so roughly 15-30k rows/day.
-- Raw rows are pruned at 30 days by sp_prune_horse_hand_reviews(); the
-- per-day rollup is permanent.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.horse_hand_reviews (
  id             bigint generated always as identity primary key,
  hand_id        uuid not null,
  table_id       uuid,
  tournament_id  uuid,
  club_id        uuid,
  played_at      timestamptz not null,
  game_variant   text not null,
  format         text not null default 'cash',
  big_blind      numeric not null,
  horse_user_id  uuid not null,
  seat           int,
  net_amount     numeric not null,
  net_bb         numeric not null,
  is_win         boolean generated always as (net_bb > 0) stored,
  pot_size       numeric,
  hole_cards     jsonb,
  board          jsonb,
  actions        jsonb,
  leak_tags      text[] not null default '{}',
  review_status  text not null default 'auto_reviewed'
                 check (review_status in ('auto_reviewed','flagged','resolved')),
  review_notes   jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.horse_hand_reviews is
  'One row per horse per hand with |net| >= 20bb, written by the engine at settlement (server/src/services/HorseHandReview.ts). Exact nets, never reconstructed. Admin UI: smarter.poker/horses/hand-reviews.';

create unique index if not exists uq_hhr_hand_horse
  on public.horse_hand_reviews (hand_id, horse_user_id);
create index if not exists idx_hhr_horse_time
  on public.horse_hand_reviews (horse_user_id, played_at desc);
create index if not exists idx_hhr_played
  on public.horse_hand_reviews (played_at desc);
create index if not exists idx_hhr_tags
  on public.horse_hand_reviews using gin (leak_tags);

alter table public.horse_hand_reviews enable row level security;
-- Deliberately NO RLS policies: only service_role (engine) writes, and the
-- admin UI reads through the SECURITY DEFINER RPCs below. An authenticated
-- user hitting the table directly gets zero rows.

-- Permanent per-horse per-day rollup, upserted by the engine writer.
create table if not exists public.horse_review_rollup (
  horse_user_id  uuid not null,
  day            date not null,
  game_variant   text not null,
  big_wins       int not null default 0,
  big_losses     int not null default 0,
  sum_net_bb     numeric not null default 0,
  leak_counts    jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (horse_user_id, day, game_variant)
);

comment on table public.horse_review_rollup is
  'Permanent per-horse/day/variant aggregate of 20bb+ hands and leak tags. Feeds the /horses admin dashboard and (next phase) the self-tuner.';

alter table public.horse_review_rollup enable row level security;

-- Engine-side upsert: adds one flagged hand into the rollup.
create or replace function public.fn_hhr_rollup_add(
  p_horse uuid, p_day date, p_variant text, p_is_win boolean,
  p_net_bb numeric, p_tags text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare t text; counts jsonb;
begin
  insert into horse_review_rollup as r (horse_user_id, day, game_variant, big_wins, big_losses, sum_net_bb, leak_counts)
  values (p_horse, p_day, p_variant,
          case when p_is_win then 1 else 0 end,
          case when p_is_win then 0 else 1 end,
          coalesce(p_net_bb, 0), '{}'::jsonb)
  on conflict (horse_user_id, day, game_variant) do update set
    big_wins   = r.big_wins   + excluded.big_wins,
    big_losses = r.big_losses + excluded.big_losses,
    sum_net_bb = r.sum_net_bb + excluded.sum_net_bb,
    updated_at = now();
  if p_tags is not null and array_length(p_tags, 1) > 0 then
    select leak_counts into counts from horse_review_rollup
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
    foreach t in array p_tags loop
      counts = jsonb_set(counts, array[t], to_jsonb(coalesce((counts->>t)::int, 0) + 1));
    end loop;
    update horse_review_rollup set leak_counts = counts, updated_at = now()
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
  end if;
end $$;

revoke all on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) from public;
grant execute on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) to service_role;

-- Admin gate shared by the read RPCs.
create or replace function public.fn_is_horse_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'superadmin', 'god')
  );
$$;
revoke all on function public.fn_is_horse_admin() from public;
grant execute on function public.fn_is_horse_admin() to authenticated, service_role;

-- Flagged-hand listing for the admin UI. All filters optional.
create or replace function public.ca_horse_hand_reviews(
  p_horse uuid default null,
  p_variant text default null,
  p_format text default null,
  p_tag text default null,
  p_win boolean default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100,
  p_offset int default 0
) returns setof public.horse_hand_reviews
language plpgsql security definer set search_path = public stable as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select * from horse_hand_reviews r
    where (p_horse is null or r.horse_user_id = p_horse)
      and (p_variant is null or r.game_variant = p_variant)
      and (p_format is null or r.format = p_format)
      and (p_tag is null or r.leak_tags @> array[p_tag])
      and (p_win is null or r.is_win = p_win)
      and (p_from is null or r.played_at >= p_from)
      and (p_to is null or r.played_at <= p_to)
    order by r.played_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
    offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.ca_horse_hand_reviews(uuid, text, text, text, boolean, timestamptz, timestamptz, int, int) from public;
grant execute on function public.ca_horse_hand_reviews(uuid, text, text, text, boolean, timestamptz, timestamptz, int, int) to authenticated, service_role;

-- Fleet summary: per-horse totals plus fleet-wide leak-tag counts for a window.
create or replace function public.ca_horse_review_summary(p_days int default 7)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare out jsonb;
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  select jsonb_build_object(
    'window_days', p_days,
    'horses', coalesce((
      select jsonb_agg(h order by h->>'sum_net_bb')
      from (
        select jsonb_build_object(
          'horse_user_id', horse_user_id,
          'alias', (select coalesce(p.alias, p.display_name, p.username) from profiles p where p.id = horse_user_id),
          'big_wins', sum(big_wins),
          'big_losses', sum(big_losses),
          'sum_net_bb', round(sum(sum_net_bb), 1),
          'leak_counts', (
            select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
              select k, sum((c.leak_counts->>k)::int) v
              from horse_review_rollup c, lateral jsonb_object_keys(c.leak_counts) k
              where c.horse_user_id = rr.horse_user_id and c.day > current_date - p_days
              group by k
            ) tags
          )
        ) h
        from horse_review_rollup rr
        where day > current_date - p_days
        group by horse_user_id
      ) horses
    ), '[]'::jsonb),
    'fleet_leaks', coalesce((
      select jsonb_object_agg(k, v) from (
        select k, sum((r.leak_counts->>k)::int) v
        from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
        where day > current_date - p_days
        group by k
      ) f
    ), '{}'::jsonb)
  ) into out;
  return out;
end $$;
revoke all on function public.ca_horse_review_summary(int) from public;
grant execute on function public.ca_horse_review_summary(int) to authenticated, service_role;

-- 30-day retention on the raw rows; the rollup is permanent.
create or replace function public.sp_prune_horse_hand_reviews() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from horse_hand_reviews where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.sp_prune_horse_hand_reviews() from public;
grant execute on function public.sp_prune_horse_hand_reviews() to service_role;
