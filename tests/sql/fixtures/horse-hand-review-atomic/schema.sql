-- Minimal pre-migration schema for 20261007020953_horse_hand_review_atomic_publication.
-- No foreign keys, no live data, no external service connections.
--
-- The table and function DDL below is copied verbatim from the migrations that
-- installed them, in apply order:
--   20260826144505_horse_hand_reviews.sql            (both tables, indexes, RLS)
--   20260906093726_every_tag_carries_its_own_ev.sql  (leak_net_bb and the
--                                                     current fn_hhr_rollup_add)
-- plus the Supabase role set and its default privileges, so a REVOKE in the
-- migration under test is exercised against grants that really exist.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Supabase grants every new public table, sequence and function to the API
-- roles by default; the migration has to take those away itself.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── 20260826144505_horse_hand_reviews.sql ──────────────────────────────────
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

create unique index if not exists uq_hhr_hand_horse
  on public.horse_hand_reviews (hand_id, horse_user_id);
create index if not exists idx_hhr_horse_time
  on public.horse_hand_reviews (horse_user_id, played_at desc);
create index if not exists idx_hhr_played
  on public.horse_hand_reviews (played_at desc);
create index if not exists idx_hhr_tags
  on public.horse_hand_reviews using gin (leak_tags);

alter table public.horse_hand_reviews enable row level security;

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

alter table public.horse_review_rollup enable row level security;

-- ── 20260906093726_every_tag_carries_its_own_ev.sql (lines 73-113) ─────────
alter table public.horse_review_rollup
  add column if not exists leak_net_bb jsonb not null default '{}'::jsonb;

create or replace function public.fn_hhr_rollup_add(
  p_horse uuid, p_day date, p_variant text, p_is_win boolean,
  p_net_bb numeric, p_tags text[])
returns void
language plpgsql security definer set search_path = public as $function$
declare t text; counts jsonb; nets jsonb;
begin
  insert into horse_review_rollup as r (horse_user_id, day, game_variant, big_wins, big_losses, sum_net_bb, leak_counts, leak_net_bb)
  values (p_horse, p_day, p_variant,
          case when p_is_win then 1 else 0 end,
          case when p_is_win then 0 else 1 end,
          coalesce(p_net_bb, 0), '{}'::jsonb, '{}'::jsonb)
  on conflict (horse_user_id, day, game_variant) do update set
    big_wins   = r.big_wins   + excluded.big_wins,
    big_losses = r.big_losses + excluded.big_losses,
    sum_net_bb = r.sum_net_bb + excluded.sum_net_bb,
    updated_at = now();
  if p_tags is not null and array_length(p_tags, 1) > 0 then
    select leak_counts, leak_net_bb into counts, nets from horse_review_rollup
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
    foreach t in array p_tags loop
      counts = jsonb_set(counts, array[t], to_jsonb(coalesce((counts->>t)::int, 0) + 1));
      -- The SAME hand's net against every tag it carries. A hand with three
      -- tags contributes its net to all three: each tag is a separate claim
      -- about that hand, and each is judged on the hands that carry it.
      nets = jsonb_set(nets, array[t],
               to_jsonb(round(coalesce((nets->>t)::numeric, 0) + coalesce(p_net_bb, 0), 2)));
    end loop;
    update horse_review_rollup set leak_counts = counts, leak_net_bb = nets, updated_at = now()
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
  end if;
end $function$;

revoke all on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) from public, authenticated, anon;
grant execute on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) to service_role;

-- 20260912102321_revoke_dead_client_write_grants_rls_denied: the API roles keep
-- no write grant on either table.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, MAINTAIN ON TABLE
  public.horse_hand_reviews, public.horse_review_rollup FROM anon, authenticated;
