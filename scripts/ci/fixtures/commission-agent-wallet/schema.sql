-- Tables the live split-rakeback owners read, as created by migration
-- 20261019213557 (immutability triggers are outside this financial proof).
CREATE TABLE public.accounting_rakeback_payer_contracts(
 calculation_id bigint NOT NULL,
 payer_kind text NOT NULL CHECK(payer_kind IN('agent','club')),
 payer_entity_id uuid NOT NULL,
 payer_user_id uuid,
 amount numeric NOT NULL CHECK(amount>=0 AND amount=round(amount,2)),
 unrounded numeric NOT NULL CHECK(unrounded>=0),
 rake numeric NOT NULL CHECK(rake>=0 AND rake=round(rake,2)),
 source_count bigint NOT NULL CHECK(source_count>0),
 source_fingerprint text NOT NULL,
 PRIMARY KEY(calculation_id,payer_kind,payer_entity_id),
 CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL)));
CREATE TABLE public.accounting_rakeback_payer_transfers(
 payout_id uuid NOT NULL,
 calculation_id bigint NOT NULL,
 period_id uuid NOT NULL,
 payer_kind text NOT NULL CHECK(payer_kind IN('agent','club')),
 payer_entity_id uuid NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 ledger_id uuid NOT NULL UNIQUE,
 wallet_transaction_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(payout_id,payer_kind,payer_entity_id));
-- Independent conservation: every wallet, agent wallet and club bank moved by
-- exactly its chip_ledger legs, computed from the rows, not by any stage.
CREATE FUNCTION public.caw_assert_conserved(p_before jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE bad text;
BEGIN
 WITH now_bal AS (
  SELECT 'player_wallet:'||user_id||':'||club_id k,chip_balance b FROM public.club_members
  UNION ALL SELECT 'agent_wallet:'||user_id||':'||club_id,agent_wallet_balance FROM public.agents
  UNION ALL SELECT 'club_treasury:'||id,chip_treasury FROM public.clubs),
 legs AS (
  SELECT to_type||':'||to_entity_id||CASE WHEN to_type='club_treasury' THEN '' ELSE ':'||club_id END k,amount d FROM public.chip_ledger l WHERE NOT EXISTS(SELECT 1 FROM caw_open_legs o WHERE o.id=l.id)
  UNION ALL SELECT from_type||':'||from_entity_id||CASE WHEN from_type='club_treasury' THEN '' ELSE ':'||club_id END,-amount FROM public.chip_ledger l WHERE NOT EXISTS(SELECT 1 FROM caw_open_legs o WHERE o.id=l.id)),
 net AS (SELECT k,sum(d) d FROM legs GROUP BY k)
 SELECT string_agg(n.k||' moved '||(n.b-COALESCE((p_before->>n.k)::numeric,0))||' ledger '||COALESCE(l.d,0),'; ') INTO bad
 FROM now_bal n LEFT JOIN net l ON l.k=n.k
 WHERE n.b-COALESCE((p_before->>n.k)::numeric,0) IS DISTINCT FROM COALESCE(l.d,0);
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'caw_balance_without_its_ledger: %',bad; END IF;
 IF (SELECT sum(chip_balance) FROM public.club_members)+(SELECT sum(agent_wallet_balance) FROM public.agents)+(SELECT sum(chip_treasury) FROM public.clubs)
   IS DISTINCT FROM (SELECT sum(value::numeric) FROM jsonb_each_text(p_before)) THEN RAISE EXCEPTION 'caw_chips_created_or_destroyed'; END IF;
END $$;
CREATE FUNCTION public.caw_balances() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_object_agg(k,b) FROM (
  SELECT 'player_wallet:'||user_id||':'||club_id k,chip_balance b FROM public.club_members
  UNION ALL SELECT 'agent_wallet:'||user_id||':'||club_id,agent_wallet_balance FROM public.agents
  UNION ALL SELECT 'club_treasury:'||id,chip_treasury FROM public.clubs) x $$;
-- Live certificates also carry the split payer kind (migration 20261019213557).
ALTER TABLE public.accounting_rakeback_period_calculations DROP CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check;
ALTER TABLE public.accounting_rakeback_period_calculations ADD CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check CHECK (payer_kind IN('club','agent','split'));
ALTER TABLE public.accounting_rakeback_period_calculations DROP CONSTRAINT accounting_rakeback_period_calculations_check;
ALTER TABLE public.accounting_rakeback_period_calculations ADD CONSTRAINT accounting_rakeback_period_calculations_check CHECK ((payer_kind='agent')=(payer_user_id IS NOT NULL));
