-- Explicit isolation: source40/generation, platform boundary and launch grants
-- are controls, not qualification of the original inventory or live scheduler.
CREATE SCHEMA smarter_private;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
CREATE TABLE public.dr_controls(sealed boolean NOT NULL DEFAULT true,generation text NOT NULL DEFAULT 'native-generation',frozen boolean NOT NULL DEFAULT false,boundary uuid);
INSERT INTO public.dr_controls DEFAULT VALUES;
CREATE FUNCTION smarter_private.original_inventory_proof_sources_match() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT sealed FROM public.dr_controls $$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation() RETURNS text LANGUAGE sql STABLE AS $$ SELECT generation FROM public.dr_controls $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT frozen FROM public.dr_controls $$;
CREATE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT boundary FROM public.dr_controls $$;
CREATE FUNCTION public.fn_ca_launch_accounting_start(text,uuid,timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT $3 $$;
CREATE FUNCTION public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_settle_accounting_rakeback_plan_get(text,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native_unexpected_legacy_fallback'; END $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE public.agents(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,club_id uuid,user_id uuid,agent_wallet_balance numeric DEFAULT 0,promo_wallet_balance numeric DEFAULT 0,updated_at timestamptz DEFAULT now(),UNIQUE(club_id,user_id));
CREATE TABLE public.chip_transactions(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric,created_at timestamptz DEFAULT now());
CREATE FUNCTION public.dr_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'native_assert:%',label; END IF; END $$;
CREATE FUNCTION public.dr_u(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('deleted-weekly-native:'||label)::uuid $$;
CREATE FUNCTION public.dr_money() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('treasury',(SELECT chip_treasury FROM public.clubs WHERE id=dr_u('club')),
 'wallets',(SELECT coalesce(jsonb_agg(to_jsonb(cm) ORDER BY user_id),'[]') FROM public.club_members cm),
 'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(pr) ORDER BY id),'[]') FROM public.profiles pr),
 'agents',(SELECT coalesce(jsonb_agg(to_jsonb(ag) ORDER BY id),'[]') FROM public.agents ag),
 'invoices',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM public.settlement_invoices i),
 'certificates',(SELECT coalesce(jsonb_agg(to_jsonb(pc) ORDER BY id),'[]') FROM public.accounting_rakeback_period_calculations pc),
 'commission_sources',(SELECT coalesce(jsonb_agg(to_jsonb(ac) ORDER BY id),'[]') FROM public.agent_commissions ac),
 'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.rakeback_periods p),
 'payouts',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.rakeback_period_payouts p),
 'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM public.chip_ledger l),
 'transactions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.wallet_transactions t),
 'bank_claims',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.chip_transactions t),
 'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY scope_kind,scope_id,round_no),'[]') FROM public.accounting_routed_settlement_runs r),
 'settlements',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.agent_commission_settlements s)) $$;

-- Exact additional row type needed to load current publisher, not executed.
CREATE TABLE public.accounting_rakeback_period_evidence_checkpoints (
  club_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  horizon timestamptz NOT NULL,
  clubs_digest text NOT NULL,
  settled_records bigint NOT NULL CHECK (settled_records >= 0),
  settled_evidence bigint NOT NULL CHECK (settled_evidence >= 0),
  settled_incomplete bigint NOT NULL CHECK (settled_incomplete >= 0),
  settled_drifted bigint NOT NULL CHECK (settled_drifted >= 0),
  built_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  advances bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (club_id, period_start),
  CHECK (period_end = period_start + 6)
);

CREATE FUNCTION public.dr_assert_bank_legs() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Search ALL legs under each operation correlation, never a category subset.
 IF EXISTS(SELECT FROM public.chip_transactions t
  LEFT JOIN LATERAL(SELECT count(*) AS n,sum(l.amount) AS amount,
   bool_and(l.category='club_bank_claim' AND l.from_type=CASE WHEN t.metadata->>'source'='agent_wallet' THEN 'agent_wallet' ELSE 'player_wallet' END
    AND l.from_entity_id=t.from_user_id AND l.to_type='club_treasury'
    AND l.to_entity_id=t.club_id AND l.club_id=t.club_id
    AND l.idempotency_key='deleted_account_bank_return:'||(t.metadata->>'op_id')
    AND l.chain_seq IS NOT NULL AND l.row_hash IS NOT NULL) AS valid
   FROM public.chip_ledger l WHERE l.correlation_id=(t.metadata->>'op_id')::uuid) legs ON true
  WHERE t.transaction_type='club_bank_claim' AND
   (t.amount<=0 OR legs.n<>1 OR legs.amount IS DISTINCT FROM t.amount OR legs.valid IS DISTINCT FROM true)) THEN RAISE EXCEPTION 'native_bank_claim_all_correlation_legs_not_one'; END IF;
END $$;
