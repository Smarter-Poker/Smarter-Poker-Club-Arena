-- ============================================================================
-- THE TABLES THE PINNED READERS TOUCH, IN PRODUCTION'S SHAPE
-- ============================================================================
--
-- Columns, types, nullability, keys and CHECKs as read from production
-- (information_schema.columns and pg_constraint, project kuklfnapbkmacvwxktbh,
-- 2026-10-04) for every relation the six pinned readers and the migration
-- under test actually touch. Columns none of them reads are left out and the
-- file says so, rather than pretending to be a schema dump.
--
-- Two postures matter and are reproduced deliberately:
--
--   * GRANTS. A fresh cluster grants EXECUTE on a new function to PUBLIC,
--     which production does not. The migration's closing block refuses to
--     commit if any of the three changed readers is reachable by anon or
--     authenticated, so the fixture has to hold production's posture or the
--     check would fire on a difference between an empty cluster and
--     production rather than on anything the migration did. PUBLIC is
--     therefore revoked below, and the two roles exist so the privilege
--     question can be asked at all. Nothing here weakens that check: it is
--     asked, in full, against roles that are present.
--
--   * clubs CHECK poker_arena_diamond_identity. A diamonds club is forbidden
--     a chip treasury, chip pool, promo balance or insurance balance. The
--     migration leans on it ("the only figure a diamonds club could ever
--     contribute to a chip report is a Diamond seat stack"), so the fixture
--     carries the constraint rather than the claim.
--
-- Two stubs, both named: fn_platform_frozen() and fn_ca_guard_watchlist().
-- Neither is pinned and neither is what this fixture proves.
--   * fn_platform_frozen() is only reached by fn_ca_capture_freeze_mark's
--     'pre' branch, where it decides how long to WAIT. The fixture answers
--     true so a mark is taken at once instead of sleeping 25 seconds.
--   * fn_ca_guard_watchlist() returns the estate's 68 watched guard names,
--     none of which is in this fixture. It returns the empty array here, so
--     the migration's watchlist comparison runs and finds nothing off its
--     baseline - which is the true answer for a cluster with no watched
--     guard in it. The production run of that check is the one that counts,
--     and the migration is the thing that runs it.
-- ============================================================================

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.clubs (
  id                uuid PRIMARY KEY,
  name              text,
  asset             text NOT NULL DEFAULT 'chips',
  is_platform       boolean NOT NULL DEFAULT false,
  is_union          boolean DEFAULT false,
  union_id          uuid,
  chip_pool         numeric DEFAULT 0,
  chip_treasury     numeric DEFAULT 0,
  promo_balance     numeric DEFAULT 0,
  insurance_balance numeric DEFAULT 0,
  CONSTRAINT clubs_asset_check CHECK (asset = ANY (ARRAY['chips'::text, 'diamonds'::text])),
  CONSTRAINT poker_arena_diamond_identity CHECK (
    ((asset = 'chips'::text) AND (NOT is_platform))
    OR ((asset = 'diamonds'::text) AND is_platform AND (union_id IS NULL)
        AND (NOT COALESCE(is_union, false))
        AND (COALESCE(chip_treasury, (0)::numeric) = (0)::numeric)
        AND (COALESCE(chip_pool, (0)::numeric) = (0)::numeric)
        AND (COALESCE(promo_balance, (0)::numeric) = (0)::numeric)
        AND (COALESCE(insurance_balance, (0)::numeric) = (0)::numeric))));

CREATE TABLE public.club_members (
  club_id       uuid NOT NULL,
  user_id       uuid NOT NULL,
  chip_balance  numeric DEFAULT 0,
  promo_balance numeric DEFAULT 0,
  PRIMARY KEY (club_id, user_id));

CREATE TABLE public.tables (
  id            uuid PRIMARY KEY,
  club_id       uuid,
  name          text,
  tournament_id uuid);

CREATE TABLE public.table_seats (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id  uuid NOT NULL,
  club_id   uuid,
  user_id   uuid NOT NULL,
  stack     numeric,
  left_at   timestamptz);

CREATE TABLE public.wallets (
  user_id        uuid PRIMARY KEY,
  balance        numeric NOT NULL DEFAULT 0,
  locked_balance numeric DEFAULT 0);

CREATE TABLE public.wallet_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,
  category   text NOT NULL,
  amount     numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.chip_supply_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at            timestamptz NOT NULL DEFAULT now(),
  wallets_total       numeric NOT NULL,
  wallets_locked      numeric NOT NULL,
  table_stacks        numeric NOT NULL,
  tx_credits          numeric NOT NULL,
  tx_debits           numeric NOT NULL,
  wallet_count        integer NOT NULL,
  seat_count          integer NOT NULL,
  credits_by_category jsonb NOT NULL DEFAULT '{}'::jsonb,
  debits_by_category  jsonb NOT NULL DEFAULT '{}'::jsonb,
  delta_holdings      numeric,
  delta_tx_net        numeric,
  unexplained_delta   numeric,
  tournament_stacks   numeric,
  club_wallets_total  numeric);

CREATE TABLE public.ca_freeze_circulation_marks (
  mark_at        timestamptz NOT NULL DEFAULT now(),
  window_hour    timestamptz NOT NULL,
  kind           text NOT NULL,
  member_wallets numeric NOT NULL,
  on_the_felt    numeric NOT NULL,
  total          numeric NOT NULL,
  PRIMARY KEY (window_hour, kind),
  CONSTRAINT ca_freeze_circulation_marks_kind_check CHECK (kind = ANY (ARRAY['pre'::text, 'post'::text])));

CREATE TABLE public.ca_arena_settings (
  id                     integer PRIMARY KEY,
  club_id                uuid,
  cash_games_enabled     boolean NOT NULL DEFAULT false,
  tournaments_enabled    boolean NOT NULL DEFAULT false,
  settlement_window_days integer NOT NULL DEFAULT 14,
  note                   text,
  updated_at             timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.profiles (
  id       uuid PRIMARY KEY,
  diamonds bigint NOT NULL DEFAULT 0);

CREATE TABLE public.ca_diamond_house (
  id         integer PRIMARY KEY,
  balance    numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_diamond_house_balance_check CHECK (balance >= 0::numeric),
  CONSTRAINT ca_diamond_house_id_check CHECK (id = 1));

CREATE TABLE public.ca_mint_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id          text NOT NULL,
  action         text NOT NULL,
  asset          text NOT NULL,
  holder_type    text NOT NULL,
  holder_id      uuid NOT NULL,
  holder_label   text,
  amount         numeric NOT NULL,
  balance_before numeric NOT NULL,
  balance_after  numeric NOT NULL,
  supply_after   numeric NOT NULL,
  reason         text NOT NULL,
  db_role        text NOT NULL DEFAULT current_user,
  created_at     timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.poker_diamond_custody (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL,
  arena_id  uuid NOT NULL,
  purpose   text NOT NULL,
  target_id uuid NOT NULL,
  entry_key text NOT NULL,
  balance   bigint NOT NULL,
  state     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_diamond_custody_purpose_check CHECK (purpose = ANY (ARRAY['cash_seat'::text, 'tournament_entry'::text])),
  CONSTRAINT poker_diamond_custody_balance_check CHECK (balance >= 0));

CREATE TABLE public.diamond_spin_days (
  owner_id         uuid NOT NULL,
  day              date NOT NULL,
  status           text NOT NULL,
  pending_diamonds bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day));

CREATE TABLE public.ca_guard_defs (
  proname  text PRIMARY KEY,
  def_hash text NOT NULL);

CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[]::text[] $$;

-- Production's grant posture: no function in public is reachable without an
-- account, and the three readers the migration changes are service_role only.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
