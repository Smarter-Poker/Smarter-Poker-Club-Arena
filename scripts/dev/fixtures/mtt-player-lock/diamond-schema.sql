-- Isolated schema slices from the maintained Diamond fixtures; no production connection.

CREATE TABLE public.ca_arena_settings (
    id smallint DEFAULT 1 NOT NULL,
    club_id uuid,
    settlement_window_days integer DEFAULT 14 NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ca_arena_settings_id_check CHECK ((id = 1)),
    CONSTRAINT ca_arena_settings_settlement_window_days_check CHECK ((settlement_window_days >= 0))
);

CREATE TABLE public.diamond_debts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    purchase_id uuid,
    amount integer NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    settled_by text,
    CONSTRAINT diamond_debts_amount_check CHECK ((amount > 0))
);

CREATE TABLE public.diamond_purchase_lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    purchase_id uuid NOT NULL,
    issued integer NOT NULL,
    consumed integer DEFAULT 0 NOT NULL,
    refunded integer DEFAULT 0 NOT NULL,
    frozen_at timestamp with time zone,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT diamond_purchase_lots_consumed_check CHECK ((consumed >= 0)),
    CONSTRAINT diamond_purchase_lots_issued_check CHECK ((issued >= 0)),
    CONSTRAINT diamond_purchase_lots_not_over_drawn CHECK (((consumed + refunded) <= issued)),
    CONSTRAINT diamond_purchase_lots_refunded_check CHECK ((refunded >= 0))
);

CREATE TABLE public.diamond_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    amount integer NOT NULL,
    balance_after integer,
    description text,
    reference_id text,
    created_at timestamp with time zone DEFAULT now(),
    transaction_type text,
    source text,
    metadata jsonb DEFAULT '{}'::jsonb,
    counterparty text,
    issuance_class text,
    CONSTRAINT diamond_transactions_issuance_class_chk CHECK (((issuance_class IS NULL) OR (issuance_class = ANY (ARRAY['purchased'::text, 'promotional'::text, 'earned'::text, 'transferred'::text, 'seeded'::text, 'refund'::text, 'spend'::text, 'bridge'::text, 'deletion'::text, 'admin'::text, 'arena'::text, 'house'::text, 'unknown'::text])))),
    CONSTRAINT no_home_games_source CHECK (((source IS NULL) OR (source <> 'home_games'::text)))
);

ALTER TABLE diamond_transactions ADD PRIMARY KEY(id);

ALTER TABLE diamond_purchase_lots ADD PRIMARY KEY(id);

ALTER TABLE diamond_purchase_lots ADD COLUMN arena_reserved integer NOT NULL DEFAULT 0;

ALTER TABLE ca_arena_settings ADD COLUMN tournaments_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.poker_diamond_custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  arena_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('cash_seat', 'tournament_entry')),
  target_id uuid NOT NULL,
  entry_key text NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 160),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 2147483647),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (user_id, purpose, target_id, entry_key),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK (state <> 'released' OR balance = 0)
);

CREATE TABLE public.poker_diamond_movements (
  request_id uuid PRIMARY KEY,
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('reserve', 'release')),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 2147483647),
  source_account text NOT NULL,
  destination_account text NOT NULL,
  wallet_journal_id uuid NOT NULL,
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account <> destination_account)
);

CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.diamond_purchase_lots(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  released_at timestamptz,
  PRIMARY KEY (custody_id, lot_id)
);

CREATE TABLE public.poker_diamond_tournament_ledger (
  id              bigserial PRIMARY KEY,
  tournament_id   uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  arena_id        uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  custody_id      uuid REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('entry','rebuy','reentry','addon','prize','bounty','fee','refund')),
  amount          bigint NOT NULL CHECK (amount >= 1 AND amount <= 2147483647),
  prize_part      bigint NOT NULL DEFAULT 0 CHECK (prize_part >= 0),
  bounty_part     bigint NOT NULL DEFAULT 0 CHECK (bounty_part >= 0),
  fee_part        bigint NOT NULL DEFAULT 0 CHECK (fee_part >= 0),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  wallet_journal_id uuid,
  obligation_id   uuid,
  registration_id uuid,
  request         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The three parts are the whole of every row: what came in decomposes, and
  -- what goes out names the bank it left.
  CONSTRAINT poker_diamond_tournament_ledger_parts CHECK (prize_part + bounty_part + fee_part = amount),
  -- Money that enters names the player and the custody row it entered.
  CONSTRAINT poker_diamond_tournament_ledger_inflow CHECK (
    kind NOT IN ('entry','rebuy','reentry','addon') OR (user_id IS NOT NULL AND custody_id IS NOT NULL AND wallet_journal_id IS NOT NULL)),
  -- A prize, bounty or refund reaches a player; a fee reaches the house.
  CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK (
    (kind IN ('prize','bounty','refund') AND user_id IS NOT NULL)
    OR (kind = 'fee' AND user_id IS NULL AND prize_part = 0 AND bounty_part = 0)
    OR kind IN ('entry','rebuy','reentry','addon')),
  CONSTRAINT poker_diamond_tournament_ledger_prize_bank CHECK (kind <> 'prize' OR (bounty_part = 0 AND fee_part = 0)),
  CONSTRAINT poker_diamond_tournament_ledger_bounty_bank CHECK (kind <> 'bounty' OR (prize_part = 0 AND fee_part = 0))
);

CREATE UNIQUE INDEX poker_diamond_one_open_entry ON poker_diamond_custody(user_id,purpose,target_id) WHERE state<>'released';

CREATE TABLE public.tournament_participant_funding_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 registration_id uuid NOT NULL, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('entry','rebuy','reentry','addon')),
 purchase_key text, asset text NOT NULL CHECK(asset IN ('chips','diamonds')),
 amount numeric NOT NULL CHECK(amount >= 0 AND amount = round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 entitlement_id uuid UNIQUE, ledger_id uuid UNIQUE, wallet_transaction_id uuid UNIQUE,
 funding_club_id uuid, registration_snapshot jsonb NOT NULL, tournament_snapshot jsonb NOT NULL,
 entitlement_snapshot jsonb, ledger_snapshot jsonb, wallet_snapshot jsonb,
 custody_result jsonb,
 CHECK ((asset='chips' AND amount>0 AND entitlement_id IS NOT NULL AND ledger_id IS NOT NULL AND wallet_transaction_id IS NOT NULL AND funding_club_id IS NOT NULL)
     OR (asset='chips' AND amount=0 AND entitlement_id IS NULL AND ledger_id IS NULL)
     OR (asset='diamonds' AND entitlement_id IS NULL AND ledger_id IS NULL))
);
