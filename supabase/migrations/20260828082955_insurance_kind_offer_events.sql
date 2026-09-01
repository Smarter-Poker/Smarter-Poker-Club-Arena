-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828082955; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- INSURANCE: kind column + EV cashout support + offer-events observability
-- 2026-08-28 - Tier 3 (RPC signature change). Mirrored in repo:
-- supabase/migrations/20260828120000_insurance_kind_offer_events.sql

-- 1) kind column
ALTER TABLE public.insurance_transactions
  ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'insurance';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='insurance_transactions' AND column_name='kind'
  ) THEN
    RAISE EXCEPTION 'insurance_transactions.kind was not created';
  END IF;
END $$;

-- 2) RPC with p_kind. Drop the old signature so exactly ONE overload exists.
DROP FUNCTION IF EXISTS public.record_insurance_transaction(
  uuid, uuid, integer, uuid, numeric, numeric, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.record_insurance_transaction(
  p_table_id uuid, p_club_id uuid, p_hand_number integer, p_player_id uuid,
  p_equity_percent numeric, p_premium numeric, p_insured_amount numeric,
  p_payout numeric, p_player_won boolean, p_kind varchar DEFAULT 'insurance')
RETURNS insurance_transactions
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_bank_type    varchar(10);
  v_bank_entity  uuid;
  v_net_player   numeric;
  v_bank_delta   numeric;
  v_tx           insurance_transactions;
BEGIN
  SELECT union_id INTO v_union_id FROM clubs WHERE id = p_club_id;

  IF v_union_id IS NOT NULL THEN
    v_bank_type := 'union';
    v_bank_entity := v_union_id;
  ELSE
    v_bank_type := 'club';
    v_bank_entity := p_club_id;
  END IF;

  v_net_player := COALESCE(p_payout, 0) - COALESCE(p_premium, 0);
  v_bank_delta := COALESCE(p_premium, 0) - COALESCE(p_payout, 0);

  INSERT INTO insurance_transactions (
    table_id, club_id, union_id, hand_number,
    player_id, equity_percent, premium, insured_amount, payout,
    player_won, net_result, bank_type, bank_entity_id, kind
  ) VALUES (
    p_table_id, p_club_id, v_union_id, p_hand_number,
    p_player_id, p_equity_percent, p_premium, p_insured_amount, p_payout,
    p_player_won, v_net_player, v_bank_type, v_bank_entity,
    COALESCE(NULLIF(p_kind, ''), 'insurance')
  )
  ON CONFLICT (table_id, hand_number, player_id) DO NOTHING
  RETURNING * INTO v_tx;

  IF v_tx.id IS NULL THEN
    SELECT * INTO v_tx FROM insurance_transactions
     WHERE table_id = p_table_id AND hand_number = p_hand_number AND player_id = p_player_id
     LIMIT 1;
    RETURN v_tx;
  END IF;

  IF v_bank_delta <> 0 THEN
    IF v_bank_type = 'union' THEN
      INSERT INTO union_wallets (union_id, insurance_wallet)
      VALUES (v_bank_entity, v_bank_delta)
      ON CONFLICT (union_id) DO UPDATE
        SET insurance_wallet = COALESCE(union_wallets.insurance_wallet, 0) + v_bank_delta,
            updated_at = NOW();
    ELSE
      INSERT INTO club_wallets (club_id, insurance_balance)
      VALUES (v_bank_entity, v_bank_delta)
      ON CONFLICT (club_id) DO UPDATE
        SET insurance_balance = COALESCE(club_wallets.insurance_balance, 0) + v_bank_delta,
            updated_at = NOW();
    END IF;
  END IF;

  RETURN v_tx;
END;
$function$;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proname='record_insurance_transaction' AND n.nspname='public') <> 1 THEN
    RAISE EXCEPTION 'record_insurance_transaction must have exactly one overload';
  END IF;
END $$;

-- 3) Offer-events funnel
CREATE TABLE IF NOT EXISTS public.insurance_offer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  club_id uuid,
  hand_number integer NOT NULL,
  player_id uuid,
  event varchar(16) NOT NULL
    CHECK (event IN ('offered','accepted','declined','timeout','cashed_out','settled')),
  equity_percent numeric,
  premium numeric,
  insured_amount numeric,
  pot numeric,
  street varchar(8),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_offer_events_club_day
  ON public.insurance_offer_events (club_id, created_at);
CREATE INDEX IF NOT EXISTS idx_insurance_offer_events_table_hand
  ON public.insurance_offer_events (table_id, hand_number);

ALTER TABLE public.insurance_offer_events ENABLE ROW LEVEL SECURITY;
