-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ZERO-DRIFT PART 2: LEDGER HARDENING (see repo copy for full commentary)
-- Retry note: all chip_ledger DDL is grouped FIRST and lock_timeout is set so
-- this fails fast instead of deadlocking against live game traffic.
SET LOCAL lock_timeout = '15s';

-- ── chip_ledger DDL (single lock acquisition, up front) ────────────────────
ALTER TABLE public.chip_ledger
  ADD COLUMN IF NOT EXISTS idempotency_key  text,
  ADD COLUMN IF NOT EXISTS correlation_id   uuid,
  ADD COLUMN IF NOT EXISTS causation_id     uuid,
  ADD COLUMN IF NOT EXISTS settlement_id    text,
  ADD COLUMN IF NOT EXISTS epoch_id         int,
  ADD COLUMN IF NOT EXISTS actor_service    text,
  ADD COLUMN IF NOT EXISTS db_role          text,
  ADD COLUMN IF NOT EXISTS pre_from_balance  numeric,
  ADD COLUMN IF NOT EXISTS post_from_balance numeric,
  ADD COLUMN IF NOT EXISTS pre_to_balance    numeric,
  ADD COLUMN IF NOT EXISTS post_to_balance   numeric,
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS metadata         jsonb,
  ADD COLUMN IF NOT EXISTS chain_seq        bigint,
  ADD COLUMN IF NOT EXISTS prev_hash        text,
  ADD COLUMN IF NOT EXISTS row_hash         text;

ALTER TABLE public.chip_ledger DROP CONSTRAINT IF EXISTS chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger DROP CONSTRAINT IF EXISTS chip_ledger_to_type_check;
ALTER TABLE public.chip_ledger DROP CONSTRAINT IF EXISTS chip_ledger_category_check;

ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_from_type_check
  CHECK (from_type IN (
    'player_wallet','club_treasury','union_bank','agent_wallet','system_mint',
    'system_burn','table_stack',
    'promo_wallet','club_wallet','union_wallet','bbj_pool','spin_reserve',
    'insurance_bank','escrow','prize_liability','bounty_liability',
    'rakeback_payable','refund_payable','settlement_suspense',
    'issuance_reserve','chip_retirement','credit_facility','credit_receivable'));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_to_type_check
  CHECK (to_type IN (
    'player_wallet','club_treasury','union_bank','agent_wallet','system_mint',
    'system_burn','table_stack',
    'promo_wallet','club_wallet','union_wallet','bbj_pool','spin_reserve',
    'insurance_bank','escrow','prize_liability','bounty_liability',
    'rakeback_payable','refund_payable','settlement_suspense',
    'issuance_reserve','chip_retirement','credit_facility','credit_receivable'));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK (category IN (
    'buyin','cashout','rake','commission','transfer','player_funding',
    'agent_funding','mint','burn','legacy_seed_reconcile','rakeback',
    'settlement','tournament_buyin','tournament_prize','bounty','adjustment','refund',
    'addon','rebuy','table_cashout','tournament_refund','bbj_contribution',
    'bbj_payout','promo','promo_release','promo_send','credit_draw',
    'credit_repayment','insurance','spin_entry','spin_prize','overlay',
    'correction','reversal','escrow_hold','escrow_release','treasury_transfer',
    'horse_funding','fee','eco','pnl_settlement','union_send','cashier_send',
    'cashier_claim_back','ticket_issue','ticket_redeem'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chip_ledger_status_check') THEN
    ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_status_check
      CHECK (status IN ('posted','correction','reversal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chip_ledger_exact_scale') THEN
    ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_exact_scale
      CHECK (amount = round(amount, 2)) NOT VALID;
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS public.chip_ledger_chain_seq;
CREATE UNIQUE INDEX IF NOT EXISTS ux_chip_ledger_idempotency_key
  ON public.chip_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_chip_ledger_correlation
  ON public.chip_ledger (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_chip_ledger_settlement
  ON public.chip_ledger (settlement_id) WHERE settlement_id IS NOT NULL;

-- ── Financial epochs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_financial_epochs (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  is_current  boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ca_financial_epochs_current
  ON public.ca_financial_epochs (is_current) WHERE is_current;

INSERT INTO public.ca_financial_epochs (name, description, started_at, is_current)
SELECT 'epoch-1-pre-hardening',
       'Everything before the 2026-08-31 zero-drift hardening. Historical rows carry this epoch.',
       '2026-01-01', false
WHERE NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs);

INSERT INTO public.ca_financial_epochs (name, description, is_current)
SELECT 'epoch-2-hardened-ledger',
       'Zero-drift hardened ledger (2026-08-31). The Midway Union master reset opens epoch 3.',
       true
WHERE NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE is_current);

CREATE OR REPLACE FUNCTION public.fn_ca_current_epoch()
RETURNS int LANGUAGE sql STABLE AS
$$ SELECT id FROM public.ca_financial_epochs WHERE is_current LIMIT 1 $$;

-- ── Maintenance mutation log + append-only enforcement ─────────────────────
CREATE TABLE IF NOT EXISTS public.ca_ledger_mutation_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  source_table text NOT NULL,
  operation    text NOT NULL,
  db_role      text NOT NULL,
  application  text,
  reason       text NOT NULL,
  old_row      jsonb NOT NULL,
  new_row      jsonb
);
ALTER TABLE public.ca_ledger_mutation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ledger_mutation_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $$;

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.chip_ledger;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.wallet_transactions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.chip_transactions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.chip_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.club_wallet_transactions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.club_wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.union_wallet_transactions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.union_wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

-- ── Sequence + content checksum on every new ledger row ────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time — that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ca_chip_ledger_enrich ON public.chip_ledger;
CREATE TRIGGER trg_ca_chip_ledger_enrich
  BEFORE INSERT ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_chip_ledger_enrich();

CREATE OR REPLACE FUNCTION public.fn_ca_verify_ledger_chain(
  p_last_n bigint DEFAULT 50000
) RETURNS TABLE (checked bigint, breaks bigint, first_break_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  v_checked bigint := 0;
  v_breaks  bigint := 0;
  v_first   bigint := NULL;
  v_calc text;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT * FROM public.chip_ledger
       WHERE chain_seq IS NOT NULL
       ORDER BY chain_seq DESC
       LIMIT p_last_n) t
    ORDER BY chain_seq ASC
  LOOP
    v_checked := v_checked + 1;
    v_calc := encode(extensions.digest(
      'v1'
      || '|' || r.chain_seq::text
      || '|' || COALESCE(r.epoch_id::text,'')
      || '|' || r.amount::text
      || '|' || r.from_type || ':' || COALESCE(r.from_entity_id::text,'')
      || '|' || r.to_type   || ':' || COALESCE(r.to_entity_id::text,'')
      || '|' || r.category
      || '|' || COALESCE(r.idempotency_key,'')
      || '|' || COALESCE(r.correlation_id::text,'')
      || '|' || r.created_at::text,
      'sha256'), 'hex');
    IF v_calc IS DISTINCT FROM r.row_hash THEN
      v_breaks := v_breaks + 1;
      v_first := COALESCE(v_first, r.chain_seq);
    END IF;
  END LOOP;

  IF v_breaks > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_verify_ledger_chain', 'unauthorized_adjustment', 'critical',
      'ledger-chain-break:' || COALESCE(v_first, 0)::text,
      0, NULL, NULL, 'ledger', 'chip_ledger', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      'checksum verification found ' || v_breaks || ' altered row(s) starting at seq ' || v_first,
      false, jsonb_build_object('breaks', v_breaks, 'first_break_seq', v_first));
  END IF;

  checked := v_checked; breaks := v_breaks; first_break_seq := v_first;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_verify_ledger_chain(bigint) FROM PUBLIC, anon, authenticated;

-- ── Required-accounts registry ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_ledger_accounts (
  account_type text PRIMARY KEY,
  side         text NOT NULL CHECK (side IN ('asset','liability','system')),
  backing      text NOT NULL,
  must_be_zero boolean NOT NULL DEFAULT false,
  notes        text
);
INSERT INTO public.ca_ledger_accounts (account_type, side, backing, must_be_zero, notes) VALUES
 ('player_wallet','asset','club_members.chip_balance',false,'per (club,user)'),
 ('promo_wallet','asset','club_members.promo_balance / agents.promo_wallet_balance',false,'restricted chips; convert via promo_release only'),
 ('agent_wallet','asset','agents.agent_wallet_balance',false,'per agent'),
 ('club_treasury','asset','clubs.chip_treasury',false,'club bank'),
 ('club_wallet','asset','club_wallets.chip_balance',false,'rake accumulator — NOT circulating supply'),
 ('union_bank','asset','union_wallets.chip_balance',false,'union main wallet'),
 ('union_wallet','asset','union_wallets rake/bbj/promo/insurance/spin sub-wallets',false,'sub-wallet named in from_label/to_label'),
 ('table_stack','asset','table_seats.stack',false,'on the felt; settles per hand'),
 ('bbj_pool','liability','bbj_pools.main/backup/promo_balance',false,'jackpot liabilities'),
 ('spin_reserve','liability','spin_bonus_pools.balance',false,'spin prize funding'),
 ('insurance_bank','liability','club_wallets.insurance_balance / union_wallets.insurance_wallet',false,''),
 ('escrow','liability','chip_escrow_holds.amount (active)',false,'held chips'),
 ('prize_liability','liability','tournaments.prize_pool (accounting counter)',false,''),
 ('bounty_liability','liability','tournaments.bounty_pool (accounting counter)',false,''),
 ('rakeback_payable','liability','rakeback_periods (accrued, unpaid)',false,''),
 ('refund_payable','liability','pending refunds',false,''),
 ('credit_facility','system','agents.credit_limit (authorization, not supply)',false,'a credit limit is not chip supply'),
 ('credit_receivable','asset','agents.credit_used',false,'what the agent owes'),
 ('settlement_suspense','system','(none — flow account)',true,'must net to zero; never a place to hide drift'),
 ('issuance_reserve','system','(none — source of authorized issuance)',false,'all mints debit this'),
 ('chip_retirement','system','(none — sink of authorized burns)',false,'all burns credit this'),
 ('system_mint','system','legacy alias of issuance_reserve',false,'kept for historical rows'),
 ('system_burn','system','legacy alias of chip_retirement',false,'kept for historical rows')
ON CONFLICT (account_type) DO NOTHING;
ALTER TABLE public.ca_ledger_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ledger_accounts FROM anon, authenticated;

-- ── Suspense monitor ───────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_ca_suspense_balance AS
SELECT COALESCE(SUM(CASE WHEN to_type   = 'settlement_suspense' THEN amount ELSE 0 END),0)
     - COALESCE(SUM(CASE WHEN from_type = 'settlement_suspense' THEN amount ELSE 0 END),0)
       AS suspense_net,
     COUNT(*) FILTER (WHERE to_type='settlement_suspense' OR from_type='settlement_suspense')
       AS suspense_rows
FROM public.chip_ledger
WHERE created_at > now() - interval '30 days';