-- DIAMOND ACCOUNTING STANDARD - FOUNDATION (2026-09-03)
-- The shared interface every diamond fix lane builds on (docs/DIAMOND-ACCOUNTING-STANDARD.md 3.1):
--   ca_diamond_house          the house account (DR14: nothing is burned by omission)
--   diamond_reward_budgets    one budget line per earn engine per period (DR7, log-only first)
--   ca_diamond_incidents      where a log-only rule records the refusal it did NOT make (Dan's risk rule)
--   diamond_transactions.counterparty / issuance_class   both sides named, class on every row (DR3; nullable, log-only)
--   fn_ca_diamond_incident()  the one helper every lane calls; never raises
-- One transaction, applied once. No balance is moved.

BEGIN;
SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS public.ca_diamond_house (
  id          smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance     numeric(20,0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
INSERT INTO public.ca_diamond_house (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE public.ca_diamond_house IS
  'DIAMOND HOUSE ACCOUNT: receives rake, fees, tournament cuts and forfeits; funds guarantees, freerolls, promos and horse bankrolls. Single row. Written only by registered diamond RPCs. Standard DR14.';

CREATE TABLE IF NOT EXISTS public.diamond_reward_budgets (
  period          text        NOT NULL,
  engine          text        NOT NULL,
  budget_diamonds bigint      NOT NULL CHECK (budget_diamonds >= 0),
  spent_diamonds  bigint      NOT NULL DEFAULT 0 CHECK (spent_diamonds >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, engine)
);
COMMENT ON TABLE public.diamond_reward_budgets IS
  'One promotional issuance budget line per earn engine per period (YYYY-MM). Standard DR7. Log-only until Dan flips refusal on: an award over budget is recorded in ca_diamond_incidents, not refused.';

CREATE TABLE IF NOT EXISTS public.ca_diamond_incidents (
  id           bigserial    PRIMARY KEY,
  occurred_at  timestamptz  NOT NULL DEFAULT now(),
  rule         text         NOT NULL,
  severity     text         NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  user_id      uuid,
  amount       numeric(20,0),
  writer       text,
  db_role      text         NOT NULL DEFAULT current_user,
  app_name     text         NOT NULL DEFAULT COALESCE(current_setting('application_name', true), ''),
  detail       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS ca_diamond_incidents_rule_idx ON public.ca_diamond_incidents (rule, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ca_diamond_incidents_open_idx ON public.ca_diamond_incidents (occurred_at DESC) WHERE resolved_at IS NULL;
COMMENT ON TABLE public.ca_diamond_incidents IS
  'Log-only refusals and diamond standard incidents (DR1..DR16). A row here is a movement the rule WOULD have refused, or a trial-balance break, with the writer named. Nothing in this table blocks anything.';

ALTER TABLE public.diamond_transactions
  ADD COLUMN IF NOT EXISTS counterparty   text,
  ADD COLUMN IF NOT EXISTS issuance_class text;
ALTER TABLE public.diamond_transactions DROP CONSTRAINT IF EXISTS diamond_transactions_issuance_class_chk;
ALTER TABLE public.diamond_transactions ADD CONSTRAINT diamond_transactions_issuance_class_chk
  CHECK (issuance_class IS NULL OR issuance_class IN
    ('purchased', 'promotional', 'earned', 'transferred', 'seeded', 'refund', 'spend',
     'bridge', 'deletion', 'admin', 'arena', 'house', 'unknown')) NOT VALID;
COMMENT ON COLUMN public.diamond_transactions.counterparty IS
  'The other side of the movement (purchase_clearing, promo_budget:<engine>, revenue:<sink>, player:<uuid>, house, retired, arena_wallet). Standard DR3. Nullable while log-only.';
COMMENT ON COLUMN public.diamond_transactions.issuance_class IS
  'purchased | promotional | earned | transferred | seeded | refund | spend | bridge | deletion | admin | arena | house | unknown. Standard DR3.';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident(
  p_rule text, p_severity text, p_user_id uuid, p_amount numeric, p_writer text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  INSERT INTO public.ca_diamond_incidents (rule, severity, user_id, amount, writer, detail)
  VALUES (p_rule, COALESCE(p_severity, 'info'), p_user_id, p_amount, p_writer, COALESCE(p_detail, '{}'::jsonb));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_incident could not record % (%): %', p_rule, p_writer, SQLERRM;
END;
$fn$;
COMMENT ON FUNCTION public.fn_ca_diamond_incident(text, text, uuid, numeric, text, jsonb) IS
  'Records a diamond standard incident. Never raises, never blocks. Called by log-only rules.';

ALTER TABLE public.ca_diamond_house        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_reward_budgets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_diamond_incidents    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_house, public.diamond_reward_budgets, public.ca_diamond_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ca_diamond_house, public.diamond_reward_budgets, public.ca_diamond_incidents TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_diamond_incidents_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_incident(text, text, uuid, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_incident(text, text, uuid, numeric, text, jsonb) TO service_role;

COMMIT;
