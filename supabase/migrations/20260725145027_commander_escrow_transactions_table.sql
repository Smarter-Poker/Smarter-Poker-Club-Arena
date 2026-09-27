-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725145027 "commander_escrow_transactions_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ba21d1e110ec072f2ef937091504358b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander audit 2026-07-25: the entire pages/api/escrow/* family (and the
-- Stripe webhook escrow branches) referenced commander_escrow_transactions,
-- which never existed in production. Tier 2: new table only.

create table if not exists public.commander_escrow_transactions (
  id uuid primary key default gen_random_uuid(),
  home_game_id uuid references public.commander_home_games(id) on delete set null,
  venue_id integer,
  player_id uuid not null,
  amount numeric(10,2) not null check (amount > 0),
  status text not null default 'pending'
    check (status in ('pending','held','released','refunded','failed','cancelled')),
  payment_method text default 'pending',
  payment_reference text,
  held_at timestamptz,
  released_at timestamptz,
  released_to uuid,
  refunded_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cet_home_game on public.commander_escrow_transactions (home_game_id);
create index if not exists idx_cet_player on public.commander_escrow_transactions (player_id);
create index if not exists idx_cet_status on public.commander_escrow_transactions (status);

alter table public.commander_escrow_transactions enable row level security;

-- Players may read their own escrow rows (API uses service role for writes).
drop policy if exists cet_select_own on public.commander_escrow_transactions;
create policy cet_select_own on public.commander_escrow_transactions
  for select using (auth.uid() = player_id);

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='commander_escrow_transactions') then
    raise exception 'commander_escrow_transactions was not created';
  end if;
end $$;
