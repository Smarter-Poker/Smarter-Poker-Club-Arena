-- ============================================================================
-- THE DIAMOND TOURNAMENT FIXTURE: WHAT THE HISTORICAL BASE DOES NOT CARRY
-- ============================================================================
--
-- The fixture's base is the estate's own historical schema pair, loaded in
-- this order and unedited:
--
--   scripts/ci/probes/bbj-bank-replay/funded/source/
--     internal-ledger-native-fixture-0006/build/00-roles.sql
--   .../build/10-historical-schema.sql
--
-- That base predates the Diamond custody work, so six relations, one trigger
-- function and three columns the Diamond tournament doors read do not exist
-- in it. Every statement in this file is SLICED VERBATIM from the migration
-- that created the object in production - the fresh creates, where the
-- migration text and the installed object are the same thing and no md5 pin
-- is involved. Nothing here is authored, and nothing here is a second
-- implementation of anything.
--
-- Sliced from, in this order:
--   20260909065458_poker_diamond_custody.sql
--   20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql
--   20260914024241_a_diamond_tournament_entry_is_custody.sql
--   20260917233447_tournament_original_funding_and_obligation_receipts.sql
--   20260912112311_the_tournament_door_has_a_switch.sql
--   20260908034530_the_diamond_arena_accounting_foundation.sql
--   20260917060000_mtt_persisted_format_preparation.sql
--
-- The three columns were checked against production before being added here:
-- ca_arena_settings.cash_games_enabled, ca_arena_settings.tournaments_enabled
-- and tournaments.format_contract are the only columns the Diamond
-- tournament closure reads that the base lacks. Both switches arrive FALSE,
-- which is what production holds, and this fixture never turns either on.
-- ============================================================================

-- The append-only trigger function the custody journals hang off.
-- Sliced from 20260909065458_poker_diamond_custody.sql.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'Diamond custody movements are append-only'; END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_append_only() FROM PUBLIC,anon,authenticated;

/* ===== 20260909065458_poker_diamond_custody.sql ===== */
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

CREATE UNIQUE INDEX poker_diamond_one_open_entry ON public.poker_diamond_custody(user_id,purpose,target_id) WHERE state <> 'released';

CREATE INDEX poker_diamond_custody_arena ON public.poker_diamond_custody(arena_id);

CREATE INDEX poker_diamond_custody_user_state ON public.poker_diamond_custody(user_id, state);

ALTER TABLE public.poker_diamond_custody ENABLE ROW LEVEL SECURITY;

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

CREATE INDEX poker_diamond_movements_user ON public.poker_diamond_movements(user_id);

CREATE INDEX poker_diamond_movements_custody ON public.poker_diamond_movements(custody_id);

ALTER TABLE public.poker_diamond_movements ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER poker_diamond_movements_append_only BEFORE UPDATE OR DELETE
 ON public.poker_diamond_movements FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_append_only();

CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.diamond_purchase_lots(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  released_at timestamptz,
  PRIMARY KEY (custody_id, lot_id)
);

CREATE INDEX poker_diamond_lot_reservations_lot ON public.poker_diamond_lot_reservations(lot_id);

ALTER TABLE public.poker_diamond_lot_reservations ENABLE ROW LEVEL SECURITY;

/* ===== 20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql ===== */
CREATE TABLE public.poker_diamond_hand_receipts (
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number)
);

ALTER TABLE public.poker_diamond_hand_receipts ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER poker_diamond_hand_receipts_append_only BEFORE UPDATE OR DELETE
  ON public.poker_diamond_hand_receipts FOR EACH ROW
  EXECUTE FUNCTION public.fn_poker_diamond_append_only();

/* ===== 20260914024241_a_diamond_tournament_entry_is_custody.sql ===== */
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

CREATE INDEX poker_diamond_tournament_ledger_tournament_idx ON public.poker_diamond_tournament_ledger (tournament_id, kind);

CREATE INDEX poker_diamond_tournament_ledger_user_idx ON public.poker_diamond_tournament_ledger (user_id, tournament_id);

CREATE INDEX poker_diamond_tournament_ledger_custody_idx ON public.poker_diamond_tournament_ledger (custody_id);

ALTER TABLE public.poker_diamond_tournament_ledger ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER poker_diamond_tournament_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.poker_diamond_tournament_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_append_only();

/* ===== 20260917233447_tournament_original_funding_and_obligation_receipts.sql ===== */
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


-- ---------------------------------------------------------------------------
-- The MTT admission contract. Sliced from
-- 20260917060000_mtt_persisted_format_preparation.sql. Every tournament door
-- takes a SHARE lock on this singleton before it admits anything, so a base
-- without it cannot run a single Diamond door. The migration's own INSERT
-- seeds 'legacy-capacity-v1'; the fixture's seed then states the ABI
-- production was observed running (2026-09-20: unlimited-mtt-v2), because the
-- create door reads it to decide whether a field size is capped.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_mtt_admission_contract (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  abi text NOT NULL CHECK(abi IN ('legacy-capacity-v1','unlimited-mtt-v2'))
);
ALTER TABLE public.ca_mtt_admission_contract OWNER TO postgres;
REVOKE ALL ON TABLE public.ca_mtt_admission_contract FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.ca_mtt_admission_contract ENABLE ROW LEVEL SECURITY;
INSERT INTO public.ca_mtt_admission_contract(singleton,abi) VALUES(true,'legacy-capacity-v1');


-- ---------------------------------------------------------------------------
-- The three columns. Sliced from their own migrations; both switches arrive
-- false, exactly as production holds them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_arena_settings ADD COLUMN IF NOT EXISTS cash_games_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.ca_arena_settings ADD COLUMN IF NOT EXISTS tournaments_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS format_contract text;

DO $delta$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x,', ') INTO v_missing FROM (
    SELECT unnest(ARRAY['public.poker_diamond_custody','public.poker_diamond_movements',
      'public.poker_diamond_lot_reservations','public.poker_diamond_hand_receipts',
      'public.poker_diamond_tournament_ledger','public.tournament_participant_funding_receipts',
      'public.ca_mtt_admission_contract']) x) q
   WHERE to_regclass(x) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the fixture delta did not create: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'the fixture delta must not open a switch';
  END IF;
  RAISE NOTICE 'PASS: the Diamond tournament fixture delta is present and both switches are closed';
END $delta$;
