-- Synthetic contract fixture only. Actual exported business functions are
-- loaded separately. Production triggers, RLS and HTTP auth are not emulated.
create schema auth;
create schema extensions;
create table public.profiles (
  id uuid primary key,
  is_vip boolean not null default false,
  vip_tier text,
  vip_expires_at timestamptz,
  diamonds integer not null default 0,
  diamond_balance integer not null default 0,
  updated_at timestamptz default now()
);
create table public.throw_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  throwable_id text not null,
  paid_diamonds boolean not null,
  created_at timestamptz not null default now()
);
create index on public.throw_usage(user_id, created_at);
create table public.throwable_use_receipts (
  user_id uuid not null references profiles(id),
  request_id uuid not null,
  throwable_id text not null,
  result jsonb not null,
  primary key (user_id, request_id)
);
create table public.feature_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  feature text not null,
  uses_remaining integer not null check (uses_remaining >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create table public.diamond_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  amount numeric,
  transaction_type text,
  type text,
  description text,
  balance_after integer,
  metadata jsonb,
  reference_id text,
  created_at timestamptz,
  counterparty text,
  issuance_class text
);
