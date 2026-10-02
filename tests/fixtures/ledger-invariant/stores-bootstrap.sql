-- tests/fixtures/ledger-invariant/stores-bootstrap.sql
--
-- The remaining chip stores, real-shaped (production column names and types,
-- information_schema.columns read 2026-10-02), with the rows they hold BEFORE
-- 20261002030942_every_chip_store_balances_with_its_ledger_row installs the
-- store invariant on them, exactly as production's balances predate it.
-- Applied after the six-store proof (regression.sql) has run, so that proof is
-- unchanged. The one behaviour copied in is production's
-- sync_agent_wallet_columns: a writer that sets agents.business_balance moves
-- agent_wallet_balance through a BEFORE trigger, which a column-specific
-- AFTER trigger would never see.

ALTER TABLE public.clubs
  ADD COLUMN promo_balance     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN insurance_balance numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN promo_balance numeric(14,2) NOT NULL DEFAULT 0;

CREATE TABLE public.tournaments (
  id      uuid PRIMARY KEY,
  club_id uuid REFERENCES public.clubs(id)
);

CREATE TABLE public.tournament_escrow (
  tournament_id  uuid PRIMARY KEY,
  prize_balance  numeric(15,2) NOT NULL DEFAULT 0,
  bounty_balance numeric(15,2) NOT NULL DEFAULT 0,
  fee_balance    numeric(15,2) NOT NULL DEFAULT 0,
  updated_at     timestamptz
);

CREATE TABLE public.tournament_tickets (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id   uuid,
  holder_id uuid,
  value     numeric,
  status    text NOT NULL DEFAULT 'issued'
);

CREATE TABLE public.agents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id              uuid,
  user_id              uuid NOT NULL,
  agent_wallet_balance numeric(18,2) DEFAULT 0,
  business_balance     numeric(15,2) DEFAULT 0,
  promo_wallet_balance numeric(18,2) DEFAULT 0,
  promo_balance        numeric(15,2) DEFAULT 0
);

-- production's sync_agent_wallet_columns, verbatim in effect
CREATE OR REPLACE FUNCTION public.sync_agent_wallet_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_wallet_balance IS DISTINCT FROM OLD.agent_wallet_balance THEN NEW.business_balance := NEW.agent_wallet_balance;
  ELSIF NEW.business_balance IS DISTINCT FROM OLD.business_balance THEN NEW.agent_wallet_balance := NEW.business_balance; END IF;
  IF NEW.promo_wallet_balance IS DISTINCT FROM OLD.promo_wallet_balance THEN NEW.promo_balance := NEW.promo_wallet_balance;
  ELSIF NEW.promo_balance IS DISTINCT FROM OLD.promo_balance THEN NEW.promo_wallet_balance := NEW.promo_balance; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.sync_agent_wallet_columns();

CREATE TABLE public.club_wallets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL,
  chip_balance      numeric(20,2) NOT NULL DEFAULT 0,
  insurance_balance numeric(20,2) NOT NULL DEFAULT 0
);

CREATE TABLE public.spin_bonus_pools (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  balance numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE public.unions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chip_balance       numeric(20,4) DEFAULT 0,
  rake_wallet        numeric(20,4) DEFAULT 0,
  main_bbj_balance   numeric(14,2) DEFAULT 0,
  backup_bbj_balance numeric(14,2) DEFAULT 0,
  promo_fund_balance numeric(14,2) DEFAULT 0,
  insurance_balance  numeric(14,2) DEFAULT 0
);

CREATE TABLE public.club_opening_setups (
  club_id                    uuid PRIMARY KEY,
  leaderboard_seed_remaining numeric(18,2) DEFAULT 0
);

-- The rows, before the invariant: a chip event and a Diamond event with their
-- escrow, an issued ticket, an agent, a club wallet, a Spin pool, the legacy
-- union, a member and a club holding promo.
INSERT INTO public.tournaments (id, club_id) VALUES
  ('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('99999999-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111'),
  ('99999999-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222');
INSERT INTO public.tournament_escrow (tournament_id, prize_balance, bounty_balance, fee_balance) VALUES
  ('99999999-0000-0000-0000-000000000001', 180, 0, 20),
  ('99999999-0000-0000-0000-00000000000d', 900, 0, 100);
INSERT INTO public.tournament_tickets (id, club_id, holder_id, value, status) VALUES
  ('77777777-7777-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 30, 'issued');
INSERT INTO public.agents (id, club_id, user_id, agent_wallet_balance, business_balance, promo_wallet_balance, promo_balance) VALUES
  ('a6e00000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 500, 500, 40, 40);
INSERT INTO public.club_wallets (id, club_id, chip_balance, insurance_balance) VALUES
  ('c1c1c1c1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1000, 50);
INSERT INTO public.spin_bonus_pools (id, club_id, balance) VALUES
  ('5b5b5b5b-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 300);
INSERT INTO public.unions (id) VALUES ('88888888-0000-0000-0000-000000000001');
UPDATE public.clubs SET promo_balance = 60 WHERE id = '11111111-1111-1111-1111-111111111111';
UPDATE public.club_members SET promo_balance = 10
 WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
