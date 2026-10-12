-- The fixture world for the Diamond cash rake path, on an isolated PostgreSQL 17.
--
-- Never production. Every table below carries only the columns the doors under
-- test read or write, with the types production has (read 2026-10-05 from
-- information_schema). The doors themselves are NOT reimplemented here: the
-- migration under test is applied verbatim, and the pre-migration settler is
-- loaded from production's own pg_get_functiondef text so the BEFORE cases
-- measure what the estate actually runs.
--
-- Fixture amounts are chosen to be legible (100, 200, 1000). The rake figures
-- are NOT fixture amounts: they come from ca_diamond_economics, which the
-- migration seeds, which is the whole point of the exercise.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  asset text NOT NULL DEFAULT 'chips',
  is_platform boolean NOT NULL DEFAULT false,
  union_id uuid NULL
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  username text,
  full_name text,
  diamonds bigint NOT NULL DEFAULT 0,
  -- CLAUDE.md 10.5. This column exists in the fixture for ONE purpose: to prove
  -- that no door under test reads it. A horse pays rake, is attributed rake and
  -- is swept like any other player, and the cases assert exactly that.
  is_horse boolean NOT NULL DEFAULT false
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  union_id uuid NULL,
  tournament_id uuid NULL,
  game_variant text NOT NULL DEFAULT 'nlh',
  status text NOT NULL DEFAULT 'running',
  small_blind numeric NOT NULL,
  big_blind numeric NOT NULL,
  max_players integer NOT NULL DEFAULT 6,
  rake_percent numeric NOT NULL DEFAULT 0,
  rake_cap_bb numeric NOT NULL DEFAULT 0,
  bbj_percent numeric NOT NULL DEFAULT 0,
  insurance_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  occupancy_id uuid NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at timestamptz NULL,
  stack numeric NOT NULL DEFAULT 0
);

CREATE TABLE public.poker_diamond_custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  arena_id uuid NOT NULL,
  purpose text NOT NULL,
  target_id uuid NOT NULL,
  entry_key text NOT NULL,
  balance bigint NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  seat_id uuid NULL,
  seat_joined_at timestamptz NULL,
  occupancy_id uuid NULL,
  CONSTRAINT poker_diamond_custody_balance_is_whole CHECK (balance >= 0)
);

CREATE TABLE public.poker_diamond_hand_receipts (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.diamond_purchase_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  issued integer NOT NULL,
  consumed integer NOT NULL DEFAULT 0,
  refunded integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  arena_reserved bigint NOT NULL DEFAULT 0
);

CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  amount bigint NOT NULL,
  released_at timestamptz NULL,
  consumed bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (custody_id, lot_id)
);

CREATE TABLE public.diamond_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  type text NOT NULL,
  transaction_type text,
  amount integer NOT NULL,
  balance_after bigint,
  reference_id text,
  description text,
  source text,
  issuance_class text,
  counterparty text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ca_mint_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id text NOT NULL UNIQUE,
  action text NOT NULL,
  asset text NOT NULL,
  holder_type text NOT NULL,
  holder_id uuid NOT NULL,
  holder_label text,
  amount numeric NOT NULL,
  balance_before numeric NOT NULL,
  balance_after numeric NOT NULL,
  supply_after numeric NOT NULL,
  reason text NOT NULL,
  performed_by uuid,
  performed_by_label text,
  db_role text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  chip_ledger_id uuid,
  diamond_tx_id uuid,
  origin text
);

CREATE TABLE public.ca_diamond_house (
  id smallint PRIMARY KEY,
  balance bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.diamond_spin_days (
  owner_id uuid NOT NULL,
  day date NOT NULL,
  status text NOT NULL,
  pending_diamonds bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);

CREATE TABLE public.ca_arena_settings (
  id smallint PRIMARY KEY,
  club_id uuid,
  cash_games_enabled boolean NOT NULL DEFAULT false,
  tournaments_enabled boolean NOT NULL DEFAULT false,
  settlement_window_days integer NOT NULL DEFAULT 14,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The guard declaration machinery, in production's shape, so the migration's
-- fn_ca_declare_guard_redefinition call is exercised rather than stubbed away.
CREATE TABLE public.ca_guard_defs (
  proname text PRIMARY KEY,
  def_hash text NOT NULL,
  declared_ref text,
  declared_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_guard_def_history (
  proname text NOT NULL,
  def_hash text NOT NULL,
  def_text text,
  PRIMARY KEY (proname, def_hash)
);

-- The four chip rake tables the migration fences. Columns the fence reads.
CREATE TABLE public.rake_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  table_id uuid,
  amount numeric NOT NULL DEFAULT 0
);
CREATE TABLE public.rake_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  table_id uuid,
  rake_record_id uuid,
  amount numeric NOT NULL DEFAULT 0
);
CREATE TABLE public.rake_distribution_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  union_id uuid,
  amount numeric NOT NULL DEFAULT 0
);
CREATE TABLE public.club_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  rake_balance numeric NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
