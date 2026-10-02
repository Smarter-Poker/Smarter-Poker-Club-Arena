-- 20260926140858_owner_authorized_legacy_discharge_of_the_deferred_rakeback_w.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Two recorded weeks can never pass through the weekly accounting authority:
-- the week of 2026-09-07 and the week of 2026-09-14 precede the settlement
-- floor (2026-09-21T07:00Z) and the cash-accrual cutover (2026-09-17T18:24Z),
-- so fn_settle_accounting_*_stage refuse them by design. What they still owe
-- is recorded in accounting_deferred_obligations. On 2026-09-26 Dan decided:
--
--   week of 2026-09-14: "Pay the measured 138,303.43." Run the whole week
--     through the normal cascade on a documented LEGACY basis: the union funds
--     the clubs (round 1 shape), the agents receive their unpaid commissions
--     (round 2 shape) and fund the players' rakeback (round 3 shape), under an
--     explicitly marked legacy certificate kind.
--   week of 2026-09-07: "Union pays them directly": one documented one-off
--     settlement from the union rake treasury, each payment receipted with a
--     Messenger record and a notification, into a wallet the payee holds.
--
-- This migration builds ONE bounded, owner-authorized operation for exactly
-- that, and nothing that runs by itself:
--
--   accounting_owner_legacy_operations   one row per deferred week; the period
--       is unique, certified -> paid is the only transition, nothing deletes.
--   accounting_legacy_rakeback_certificates   certificate_kind owner_legacy_v1,
--       carrying the measurement each payable rests on. Immutable.
--   accounting_legacy_settlement_legs    the certified round 1 / round 2 plan.
--   accounting_deferred_obligations      gains discharge columns; a paid week
--       is DISCHARGED with its operation id, time and amounts, never deleted.
--   fn_ca_rakeback_payout_leg_is_documented   learns exactly one new
--       certificate kind; every existing clause is kept as it was.
--   fn_accounting_legacy_certify_week / fn_accounting_legacy_pay_week
--       service_role only. Certify reads and writes certificates; pay moves the
--       chips once, through the same leg shapes, journal stand-downs, document
--       authority (fn_invoice_accounting_ledger_transfer -> deliveries ->
--       Messenger -> notifications) and assertions the weekly stages use.
--
-- WHY THIS IS NOT A SECOND PAYER. It pays nothing on a schedule and nothing
-- the weekly authority can reach: it accepts only a week recorded in
-- accounting_deferred_obligations that lies wholly below the union and club
-- settlement floors and before the cutover, refuses a week that already has a
-- routed settlement run, and records one operation per week. Every payout leg
-- satisfies zz_ca_rakeback_payout_leg_is_documented (routed identity, run
-- identity in accounting_routed_settlement_runs with source
-- owner_legacy_discharge_v1, a paid rakeback_period_payouts row, a
-- certificate, exactly one source-linked paid receipt). No cron, no watcher,
-- no reconciler, no sweep (CLAUDE.md 10.12). No clearing account is used.
--
-- THE 2026-09-14 BASIS. The recorded measurement (20260921082544) read
-- rake_attributions, and eight-day hand retention has since removed the
-- attributions of 2026-09-14 .. 2026-09-17. 20260926131554 therefore called
-- 103,614.58 of the week's rake "without a per-player record". It is not: every
-- cash rake record keeps its own player_contributions, and the installed
-- fn_allocate_rake_credits - the allocator that wrote rake_attributions - turns
-- them into the same per-player credits (identical, row for row, wherever both
-- still exist: 149,711 rows on 2026-09-19, 0 differences). Nothing is invented
-- (CLAUDE.md 10.9 rule 1). The earning club comes from
-- accounting_cash_rake_sources, else ca_union_rake_attribution; the terms from
-- accounting_agreement_history at earning time, each agreement's first
-- observation (the 2026-09-14 12:09Z baseline for every agent and for every
-- membership that earned before it) standing for the 5h06m before it, as
-- 20260921082544 did.
--
-- Read-only against production on 2026-09-26 this reproduces the recorded
-- basis to the cent: Deep Stack Society 238,816.96 and Midway 377,025.58 of
-- cash rake (615,842.54). Paid per payee in whole cents it comes to
-- 138,301.89 on 676 periods (Deep Stack Society 44,931.27, Club JAQK
-- 46,752.70, SHARK CLUB 46,617.92) against the recorded 138,303.43. The
-- recorded figure was rounded once per scope (+0.19 in the club scope), and
-- the union's club split of rake whose attribution rows are gone cannot be
-- re-read (-1.73). The difference, 1.54, is written on the discharged rows;
-- no payee is invented for it. Commissions follow
-- fn_accounting_earning_contract per source row: 488,214.01 on 137 hierarchy
-- edges (validated earlier against the recorded cash_rake_accrual
-- commissions: 1,520,188 rows, 349,366.04 vs 349,366.23). The 1,823,910
-- recorded, unsettled cash commission rows of the week are settled by the
-- payment that replaces them. The week's tournament fees are outside the
-- recorded obligation and outside this operation.
--
-- Horses are paid exactly as humans (CLAUDE.md 10.5). Nothing is taken back
-- from anyone already paid on 2026-09-14 (10.9).

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Exact live predecessors, read-only. Refuse drift before any DDL.
DO $installed_preconditions$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure))<>'412f4ad7723cd08cda1f66e8768c01c2'
 THEN RAISE EXCEPTION 'rakeback_payout_document_guard_preimage_drift' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='zz_ca_rakeback_payout_leg_is_documented'
   AND t.tgenabled='O' AND t.tgdeferrable AND t.tginitdeferred AND t.tgfoid='public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='accounting_transfer_document' AND t.tgenabled='O')
 THEN RAISE EXCEPTION 'rakeback_payout_document_authority_not_armed' USING ERRCODE='55000'; END IF;
 IF to_regclass('public.accounting_owner_legacy_operations') IS NOT NULL OR to_regclass('public.accounting_legacy_rakeback_certificates') IS NOT NULL
  OR to_regclass('public.accounting_legacy_settlement_legs') IS NOT NULL
  OR to_regprocedure('public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb)') IS NOT NULL
  OR to_regprocedure('public.fn_accounting_legacy_pay_week(uuid)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='accounting_deferred_obligations' AND column_name LIKE 'discharge%')
 THEN RAISE EXCEPTION 'owner_legacy_discharge_preexists' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_allocate_rake_credits(numeric,jsonb,text)') IS NULL OR to_regprocedure('public.fn_credit_treasury(uuid,numeric,text,jsonb,text)') IS NULL
  OR to_regprocedure('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])') IS NULL OR to_regprocedure('public.fn_invoice_accounting_ledger_transfer(uuid)') IS NULL
  OR to_regclass('public.accounting_deferred_obligations') IS NULL OR to_regclass('public.accounting_routed_settlement_runs') IS NULL
  OR to_regclass('public.accounting_cash_rake_sources') IS NULL OR to_regclass('public.ca_union_rake_attribution') IS NULL
  OR to_regclass('public.club_settlement_floor') IS NULL OR to_regclass('public.union_settlement_floor') IS NULL
 THEN RAISE EXCEPTION 'owner_legacy_discharge_dependency_missing' USING ERRCODE='55000'; END IF;
 IF position($n$PERFORM set_config('app.ledger_autoskip_club_members','1',true)$n$ IN pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))=0
  OR position($n$IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN$n$ IN pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure))=0
 THEN RAISE EXCEPTION 'owner_legacy_discharge_stand_down_contract_changed' USING ERRCODE='55000'; END IF;
END $installed_preconditions$;

-- 1. THE OPERATION RECORD. One owner-authorized operation per deferred week,
--    recorded before any payment and completed by the same authority. The
--    period is unique, so a second operation for the same week is refused by
--    the primary constraint, not by a convention.
CREATE TABLE public.accounting_owner_legacy_operations(
 operation_id uuid PRIMARY KEY,
 mode text NOT NULL CHECK (mode IN ('legacy_cascade','union_direct')),
 period_start timestamptz NOT NULL UNIQUE,
 period_end timestamptz NOT NULL,
 union_id uuid NOT NULL REFERENCES public.unions(id),
 authorized_by text NOT NULL CHECK (btrim(authorized_by)<>''),
 authorization_text text NOT NULL CHECK (length(btrim(authorization_text))>=20),
 state text NOT NULL CHECK (state IN ('certified','paid')),
 certified_at timestamptz NOT NULL DEFAULT now(),
 certification jsonb NOT NULL,
 paid_at timestamptz,
 result jsonb,
 CHECK (period_end>period_start),
 CHECK ((state='paid')=(paid_at IS NOT NULL AND result IS NOT NULL)));
COMMENT ON TABLE public.accounting_owner_legacy_operations IS
 'One owner-authorized, single-use discharge of a deferred week recorded in accounting_deferred_obligations (weeks before the settlement floor that the weekly authority can never certify). certified -> paid is the only transition; nothing is deleted. Written only by fn_accounting_legacy_certify_week and fn_accounting_legacy_pay_week.';

CREATE FUNCTION public.fn_accounting_owner_legacy_operation_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='certified' AND NEW.state='paid'
  AND NEW.operation_id=OLD.operation_id AND NEW.mode=OLD.mode AND NEW.period_start=OLD.period_start
  AND NEW.period_end=OLD.period_end AND NEW.union_id=OLD.union_id AND NEW.authorized_by=OLD.authorized_by
  AND NEW.authorization_text=OLD.authorization_text AND NEW.certified_at=OLD.certified_at
  AND NEW.certification=OLD.certification AND NEW.paid_at IS NOT NULL AND NEW.result IS NOT NULL
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'owner_legacy_operation_is_immutable' USING ERRCODE='55000';
END $fn$;
ALTER FUNCTION public.fn_accounting_owner_legacy_operation_transition() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_owner_legacy_operation_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_owner_legacy_operation_transition BEFORE UPDATE OR DELETE ON public.accounting_owner_legacy_operations
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_owner_legacy_operation_transition();
CREATE TRIGGER accounting_owner_legacy_operation_no_truncate BEFORE TRUNCATE ON public.accounting_owner_legacy_operations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

-- 2. THE LEGACY CERTIFICATE KIND. Where the v3 capture basis cannot certify a
--    week, the payable is certified here, explicitly marked, and carries the
--    measurement it rests on. It is immutable like accounting_rakeback_period_calculations.
CREATE TABLE public.accounting_legacy_rakeback_certificates(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 certificate_kind text NOT NULL CHECK (certificate_kind='owner_legacy_v1'),
 operation_id uuid NOT NULL REFERENCES public.accounting_owner_legacy_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
 period_id uuid NOT NULL UNIQUE REFERENCES public.rakeback_periods(id),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 player_id uuid NOT NULL,
 payer_kind text NOT NULL CHECK (payer_kind IN ('agent','club','union')),
 payer_user_id uuid,
 payer_entity_id uuid NOT NULL,
 rake_generated numeric NOT NULL CHECK (rake_generated>=0 AND rake_generated=round(rake_generated,2)),
 rakeback_amount numeric NOT NULL CHECK (rakeback_amount>=0 AND rakeback_amount=round(rakeback_amount,2)),
 display_rate numeric NOT NULL CHECK (display_rate>=0 AND display_rate<=1 AND display_rate=round(display_rate,4)),
 measurement jsonb NOT NULL CHECK (jsonb_typeof(measurement)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((payer_kind='agent')=(payer_user_id IS NOT NULL)),
 CHECK (payer_kind<>'agent' OR payer_entity_id=payer_user_id),
 CHECK (payer_user_id IS DISTINCT FROM player_id));
COMMENT ON TABLE public.accounting_legacy_rakeback_certificates IS
 'certificate_kind owner_legacy_v1: the payable of one deferred rakeback period, certified by an owner-authorized operation because the week precedes the v3 capture basis. club_id is the club whose member wallet is credited. Immutable.';
CREATE TRIGGER accounting_legacy_rakeback_certificate_immutable BEFORE UPDATE OR DELETE ON public.accounting_legacy_rakeback_certificates
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_legacy_rakeback_certificate_no_truncate BEFORE TRUNCATE ON public.accounting_legacy_rakeback_certificates
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

-- 3. THE CERTIFIED ROUND 1 AND ROUND 2 PLAN of a legacy cascade week.
CREATE TABLE public.accounting_legacy_settlement_legs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES public.accounting_owner_legacy_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
 round_no int NOT NULL CHECK (round_no IN (1,2)),
 scope_kind text NOT NULL CHECK (scope_kind IN ('union','club')),
 scope_id uuid NOT NULL,
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 payer_kind text NOT NULL CHECK (payer_kind IN ('union','club','agent')),
 payer_id uuid NOT NULL,
 payee_kind text NOT NULL CHECK (payee_kind IN ('club','agent')),
 payee_id uuid NOT NULL,
 payee_role text,
 amount numeric NOT NULL CHECK (amount>0 AND amount=round(amount,2)),
 own_amount numeric,
 sort_order int NOT NULL,
 measurement jsonb NOT NULL CHECK (jsonb_typeof(measurement)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (operation_id,round_no,club_id,payer_id,payee_id),
 CHECK ((round_no=1)=(payer_kind='union' AND payee_kind='club')),
 CHECK (round_no=1 OR payee_role IN ('super_agent','agent','sub_agent')));
CREATE TRIGGER accounting_legacy_settlement_leg_immutable BEFORE UPDATE OR DELETE ON public.accounting_legacy_settlement_legs
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_legacy_settlement_leg_no_truncate BEFORE TRUNCATE ON public.accounting_legacy_settlement_legs
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

REVOKE ALL ON public.accounting_owner_legacy_operations,public.accounting_legacy_rakeback_certificates,public.accounting_legacy_settlement_legs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.accounting_owner_legacy_operations,public.accounting_legacy_rakeback_certificates,public.accounting_legacy_settlement_legs TO service_role;
ALTER TABLE public.accounting_owner_legacy_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_legacy_rakeback_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_legacy_settlement_legs ENABLE ROW LEVEL SECURITY;

-- 4. A deferred obligation is DISCHARGED, never deleted.
ALTER TABLE public.accounting_deferred_obligations
 ADD COLUMN discharged_operation_id uuid REFERENCES public.accounting_owner_legacy_operations(operation_id),
 ADD COLUMN discharged_at timestamptz,
 ADD COLUMN discharged_amount numeric,
 ADD COLUMN discharged_periods integer,
 ADD COLUMN discharge_note text,
 ADD CONSTRAINT accounting_deferred_obligations_discharge_whole CHECK (
  (discharged_operation_id IS NULL AND discharged_at IS NULL AND discharged_amount IS NULL AND discharged_periods IS NULL AND discharge_note IS NULL)
  OR (discharged_operation_id IS NOT NULL AND discharged_at IS NOT NULL AND discharged_amount>=0
      AND discharged_amount=round(discharged_amount,2) AND discharged_periods>=0 AND btrim(discharge_note)<>''));
-- 5. THE DOCUMENT CONSTRAINT LEARNS EXACTLY ONE NEW CERTIFICATE KIND. Every
--    existing clause is kept byte for byte. A leg that names certificate_kind
--    owner_legacy_v1 must match a legacy certificate of the same operation,
--    period, club, player and amount; every other leg is checked against
--    accounting_rakeback_period_calculations exactly as before.
CREATE OR REPLACE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m        jsonb := COALESCE(NEW.metadata,'{}'::jsonb);
  v_period uuid; v_cert bigint; v_payout uuid;
  v_kind   text; v_scope uuid; v_start timestamptz; v_end timestamptz;
  v_docs   int;
  v_legacy_operation uuid;
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key)='' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' carries no idempotency key';
  END IF;
  IF m->>'routing_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has no routed accounting identity';
  END IF;
  BEGIN
    v_period:=(m->>'period_id')::uuid;   v_cert :=(m->>'certificate_id')::bigint;
    v_payout:=(m->>'payout_id')::uuid;   v_kind :=m->>'accounting_scope_kind';
    v_scope :=(m->>'accounting_scope_id')::uuid;
    v_start :=(m->>'period_start')::timestamptz;
    v_end   :=(m->>'period_end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has an unreadable routed accounting identity';
  END;
  IF v_period IS NULL OR v_cert IS NULL OR v_payout IS NULL OR v_kind IS NULL
     OR v_scope IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' is missing part of its period, certificate or payout identity';
  END IF;

  -- The settlement run a disputing player is shown the payment under.
  IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind=v_kind AND r.scope_id=v_scope AND r.period_start=v_start
      AND r.period_end=v_end AND r.round_no=3 AND r.routing_version=3) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no routed settlement run';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
    WHERE pp.id=v_payout AND pp.rakeback_period_id=v_period AND pp.club_id=NEW.club_id
      AND pp.user_id=NEW.to_entity_id AND pp.status='paid' AND pp.payout_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching paid rakeback period payout';
  END IF;

  IF m ? 'certificate_kind' THEN
    -- The only other certificate kind is the owner-authorized legacy one. It
    -- must name its operation, and the certificate must be that operation's.
    IF m->>'certificate_kind' IS DISTINCT FROM 'owner_legacy_v1' THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names an unknown certificate kind';
    END IF;
    BEGIN v_legacy_operation:=(m->>'legacy_operation_id')::uuid;
    EXCEPTION WHEN OTHERS THEN v_legacy_operation:=NULL; END;
    IF v_legacy_operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c
      JOIN public.accounting_owner_legacy_operations o ON o.operation_id=c.operation_id
      WHERE c.id=v_cert AND c.operation_id=v_legacy_operation AND c.period_id=v_period AND c.club_id=NEW.club_id
        AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount
        AND o.period_start=v_start AND o.period_end=v_end) THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names no matching owner legacy certificate';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
    WHERE c.id=v_cert AND c.period_id=v_period AND c.club_id=NEW.club_id
      AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching rakeback certificate';
  END IF;

  SELECT count(*) INTO v_docs FROM public.settlement_invoices i
   WHERE i.source_ledger_id=NEW.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=NEW.amount AND i.net_amount=NEW.amount;
  IF v_docs<>1 THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has '||v_docs::text||' source-linked paid receipts, expected exactly 1';
  END IF;
  RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() FROM PUBLIC,anon,authenticated,service_role;
-- 6. CERTIFY. Reads the recorded week, writes the legacy certificates and the
--    round 1/2 plan, restates or opens the week's periods, and records the
--    operation as certified. It moves no chips. The caller states the exact
--    figures it expects (proved read-only first); any difference refuses.
-- Registered before they exist (fn_ca_money_rpc_registry_guard refuses a
-- balance-writing function created before its registry row).
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_accounting_legacy_pay_week','approved','Owner-authorized single-use discharge of a recorded deferred week (accounting_deferred_obligations) below the settlement floor, through the weekly stages'' leg shapes and document authority. One operation per week (accounting_owner_legacy_operations.period_start is unique); a paid operation replays nothing.'),
 ('fn_accounting_legacy_certify_week','approved','Writes the legacy certificates and plan for fn_accounting_legacy_pay_week; moves no chips.');

CREATE FUNCTION public.fn_accounting_legacy_certify_week(
 p_operation_id uuid, p_period_start timestamptz, p_mode text,
 p_authorized_by text, p_authorization_text text, p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
 v_end timestamptz; v_from date; v_to date; v_union uuid; v_h0 timestamptz; v_cut timestamptz;
 v_standalone uuid[]; v_members uuid[]; v_scope_clubs uuid[]; v_floor timestamptz;
 v_n bigint; v_x numeric; v_y numeric; v_derived jsonb; v_cert jsonb; v_superseded jsonb;
 v_commission_rows jsonb; r record;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_mode IS NULL OR p_mode NOT IN('legacy_cascade','union_direct')
  OR p_period_start IS NULL OR NOT isfinite(p_period_start) OR p_period_start<>public.fn_union_week_start(p_period_start)
  OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'legacy_discharge_invalid_request' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN
  RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 v_end:=public.fn_union_week_start(p_period_start+interval '8 days');
 v_from:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 v_to:=(v_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 PERFORM pg_advisory_xact_lock(hashtextextended('owner-legacy-discharge:'||extract(epoch FROM p_period_start)::text,0));

 -- Only a RECORDED deferred week, below every settlement floor and before the
 -- v3 capture cutover, can be discharged here. Nothing else is reachable.
 IF EXISTS(SELECT 1 FROM public.accounting_owner_legacy_operations o WHERE o.operation_id=p_operation_id OR o.period_start=p_period_start)
 THEN RAISE EXCEPTION 'legacy_discharge_already_recorded' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end)
  OR EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end AND d.discharged_operation_id IS NOT NULL)
  OR (SELECT count(*) FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end AND d.scope_kind='union')<>1
 THEN RAISE EXCEPTION 'legacy_discharge_requires_one_recorded_undischarged_week' USING ERRCODE='55000'; END IF;
 SELECT d.scope_id INTO v_union FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end AND d.scope_kind='union';
 v_standalone:=ARRAY(SELECT d.scope_id FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end AND d.scope_kind='club' ORDER BY 1);
 v_members:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=v_union AND uc.club_id<>v_union ORDER BY 1);
 IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=v_union AND c.is_union IS TRUE) OR cardinality(v_members)=0
  OR EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=ANY(v_standalone) AND (c.is_union IS TRUE OR c.union_id IS NOT NULL))
 THEN RAISE EXCEPTION 'legacy_discharge_scope_invalid' USING ERRCODE='55000'; END IF;
 SELECT f.earliest_period_start INTO v_floor FROM public.union_settlement_floor f WHERE f.union_id=v_union;
 SELECT c.starts_at INTO v_cut FROM public.accounting_cash_accrual_cutover c WHERE c.singleton;
 IF v_floor IS NULL OR v_end>v_floor OR v_cut IS NULL OR p_period_start>=v_cut
  OR EXISTS(SELECT 1 FROM unnest(v_standalone) s(club_id) WHERE public.fn_club_settlement_floor_week(s.club_id) IS NULL OR public.fn_club_settlement_floor_week(s.club_id)<v_end)
 THEN RAISE EXCEPTION 'legacy_discharge_week_is_not_below_the_floor' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start=p_period_start AND x.period_end=v_end
   AND (x.union_id=v_union OR x.standalone_club_id=ANY(v_standalone)))
 THEN RAISE EXCEPTION 'legacy_discharge_week_already_has_a_settlement_run' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM v_end)::text,0));
 FOR r IN SELECT unnest(v_standalone) AS club_id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||r.club_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM v_end)::text,0));
 END LOOP;
 v_scope_clubs:=v_standalone||v_members;

 IF p_mode='union_direct' THEN
  ---------------------------------------------------------------------------
  -- UNION DIRECT: the recorded legacy allocator rows are the payable (this
  -- week has no earning-time terms and 8.8% attribution). The union pays each
  -- one from its rake treasury into a member wallet the payee actually holds.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE _lg_rows ON COMMIT DROP AS
  SELECT rp.*, EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=rp.club_id AND cm.user_id=rp.user_id) AS holds_row_club
   FROM public.rakeback_periods rp
   WHERE rp.status='pending' AND rp.period_start=v_from AND rp.period_end=v_to AND (rp.club_id=v_union OR rp.club_id=ANY(v_standalone));
  SELECT count(*),COALESCE(sum(rakeback_amount),0) INTO v_n,v_x FROM _lg_rows;
  IF v_n<>(SELECT sum(pending_periods) FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end)
   OR v_x<>(SELECT sum(pending_amount) FROM public.accounting_deferred_obligations d WHERE d.period_start=p_period_start AND d.period_end=v_end)
   OR v_n<>(p_expected->>'periods')::bigint OR v_x<>(p_expected->>'amount')::numeric
   OR EXISTS(SELECT 1 FROM _lg_rows WHERE rakeback_amount<0 OR rakeback_amount<>round(rakeback_amount,2) OR rake_generated<0
     OR rake_generated<>round(rake_generated,2) OR rakeback_amount>rake_generated OR rakeback_rate<0 OR rakeback_rate>1)
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp JOIN _lg_rows l ON l.id=pp.rakeback_period_id)
   OR EXISTS(SELECT 1 FROM public.chip_ledger cl JOIN _lg_rows l ON cl.idempotency_key IN('round3-period:v3:'||l.id::text,'owner_legacy:round3:'||l.id::text))
  THEN RAISE EXCEPTION 'legacy_discharge_measurement_moved' USING ERRCODE='55000',
   DETAIL=jsonb_build_object('periods',v_n,'amount',v_x,'expected',p_expected)::text; END IF;
  -- Destination: the recorded club when the payee holds an account there;
  -- otherwise the union member club whose wallet funded the payee's play at
  -- the union's own tables that week, then before it, then the oldest held
  -- union membership. The payee must hold the destination account.
  CREATE TEMP TABLE _lg_buyins ON COMMIT DROP AS
  SELECT cl.from_entity_id AS user_id, cl.club_id,
         sum(cl.amount) FILTER (WHERE cl.created_at>=p_period_start) AS week_amount, sum(cl.amount) AS all_amount
   FROM public.chip_ledger cl JOIN public.tables t ON t.id=cl.to_entity_id
   WHERE cl.category='buyin' AND cl.from_type='player_wallet' AND cl.to_type='table_stack' AND t.club_id=v_union
     AND cl.created_at<v_end AND cl.club_id=ANY(v_members)
     AND cl.from_entity_id IN(SELECT user_id FROM _lg_rows WHERE NOT holds_row_club)
   GROUP BY 1,2;
  CREATE TEMP TABLE _lg_dest ON COMMIT DROP AS
  SELECT l.id AS period_id, l.user_id, l.club_id AS row_club,
   CASE WHEN l.holds_row_club THEN l.club_id ELSE (
    SELECT cm.club_id FROM public.club_members cm
     LEFT JOIN _lg_buyins b ON b.user_id=cm.user_id AND b.club_id=cm.club_id
     WHERE cm.user_id=l.user_id AND cm.club_id=ANY(v_members)
     ORDER BY COALESCE(b.week_amount,0) DESC, COALESCE(b.all_amount,0) DESC, cm.joined_at, cm.club_id LIMIT 1) END AS club_id,
   CASE WHEN l.holds_row_club THEN 'recorded_club_account'
    WHEN EXISTS(SELECT 1 FROM _lg_buyins b WHERE b.user_id=l.user_id AND b.week_amount>0) THEN 'week_union_table_funding_club'
    WHEN EXISTS(SELECT 1 FROM _lg_buyins b WHERE b.user_id=l.user_id AND b.all_amount>0) THEN 'prior_union_table_funding_club'
    ELSE 'oldest_union_membership' END AS rule,
   (SELECT COALESCE(jsonb_object_agg(b.club_id,jsonb_build_object('week',b.week_amount,'through_week',b.all_amount)),'{}') FROM _lg_buyins b WHERE b.user_id=l.user_id) AS evidence
  FROM _lg_rows l;
  IF EXISTS(SELECT 1 FROM _lg_dest WHERE club_id IS NULL) THEN
   RAISE EXCEPTION 'legacy_discharge_payee_holds_no_union_account' USING ERRCODE='55000',
    DETAIL=(SELECT jsonb_agg(period_id) FROM _lg_dest WHERE club_id IS NULL)::text; END IF;
  INSERT INTO public.accounting_legacy_rakeback_certificates(certificate_kind,operation_id,period_id,club_id,player_id,payer_kind,payer_user_id,payer_entity_id,
    rake_generated,rakeback_amount,display_rate,measurement)
  SELECT 'owner_legacy_v1',p_operation_id,l.id,d.club_id,l.user_id,'union',NULL,v_union,l.rake_generated,l.rakeback_amount,round(l.rakeback_rate,4),
   jsonb_build_object('basis','recorded legacy allocator row; the week precedes accounting_agreement_history and its rake attribution covers 8.8% of records, so the recorded row is the payable (accounting_deferred_obligations)',
    'recorded_row',jsonb_build_object('club_id',l.club_id,'rake_generated',l.rake_generated,'rakeback_rate',l.rakeback_rate,'rakeback_amount',l.rakeback_amount,'created_at',l.created_at),
    'payer','union rake treasury under owner authorization','destination_rule',d.rule,'destination_evidence',d.evidence,
    'authorized_by',p_authorized_by)
  FROM _lg_rows l JOIN _lg_dest d ON d.period_id=l.id;
  v_derived:=jsonb_build_object('mode',p_mode,'union_id',v_union,'periods',v_n,'amount',v_x,
   'by_destination_rule',(SELECT jsonb_object_agg(rule,n) FROM (SELECT rule,count(*) n FROM _lg_dest GROUP BY 1) q),
   'by_destination_club',(SELECT jsonb_object_agg(club_id,jsonb_build_object('periods',n,'amount',a)) FROM (SELECT d.club_id,count(*) n,sum(l.rakeback_amount) a FROM _lg_dest d JOIN _lg_rows l ON l.id=d.period_id GROUP BY 1) q));
 ELSE
  ---------------------------------------------------------------------------
  -- LEGACY CASCADE: the week is re-measured from records that survive the
  -- eight-day hand retention: every cash rake record's own player
  -- contributions, allocated by the installed fn_allocate_rake_credits; the
  -- earning club from accounting_cash_rake_sources where the accrual recorded
  -- it, else ca_union_rake_attribution; and the terms observed in
  -- accounting_agreement_history at earning time (the first observation for
  -- the unobserved head: every agreement's first observation stands for the
  -- time before it, as the recorded measurement of 20260921082544 did).
  ---------------------------------------------------------------------------
  SELECT min(h.observed_at) INTO v_h0 FROM public.accounting_agreement_history h;
  CREATE TEMP TABLE _lc_rows ON COMMIT DROP AS
  SELECT row_number() OVER () AS rid, rr.id AS rake_record_id, rr.created_at AS earned_at, rr.created_at AS terms_at, a.user_id AS player_id, a.credit AS amt,
   CASE WHEN rr.club_id=v_union THEN COALESCE(s.club_id,u.club_id) ELSE rr.club_id END AS club_id,
   CASE WHEN rr.club_id<>v_union THEN 'table_club' WHEN s.club_id IS NOT NULL THEN 'accounting_cash_rake_sources' ELSE 'ca_union_rake_attribution' END AS club_evidence
  FROM public.rake_records rr
  CROSS JOIN LATERAL public.fn_allocate_rake_credits(rr.rake_amount,rr.player_contributions,
    CASE WHEN rr.rake_method='WEIGHTED_CONTRIBUTED' THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END) a
  LEFT JOIN public.accounting_cash_rake_sources s ON rr.club_id=v_union AND s.rake_record_id=rr.id AND s.player_id=a.user_id
  LEFT JOIN public.ca_union_rake_attribution u ON rr.club_id=v_union AND u.rake_record_id=rr.id AND u.user_id=a.user_id
  WHERE rr.created_at>=p_period_start AND rr.created_at<v_end AND rr.rake_amount>0 AND rr.is_tournament IS NOT TRUE AND rr.tournament_id IS NULL
    AND rr.hand_id IS NOT NULL AND jsonb_typeof(rr.player_contributions)='object'
    AND (rr.club_id=v_union OR rr.club_id=ANY(v_scope_clubs)) AND a.credit>0;
  IF EXISTS(SELECT 1 FROM _lc_rows WHERE club_id IS NULL OR NOT club_id=ANY(v_scope_clubs)) THEN
   RAISE EXCEPTION 'legacy_discharge_earning_club_unresolved' USING ERRCODE='55000',
    DETAIL=(SELECT count(*) FROM _lc_rows WHERE club_id IS NULL OR NOT club_id=ANY(v_scope_clubs))::text; END IF;
  CREATE INDEX ON _lc_rows(club_id,player_id);
  ANALYZE _lc_rows;
  -- Observed terms by interval, exactly as fn_accounting_terms_at resolves them.
  CREATE TEMP TABLE _lc_mem ON COMMIT DROP AS
  SELECT split_part(h.entity_key,':',1)::uuid AS club_id, split_part(h.entity_key,':',2)::uuid AS player_id, h.id AS history_id,
   CASE WHEN row_number() OVER (PARTITION BY h.entity_key ORDER BY h.observed_at,h.id)=1 THEN '-infinity'::timestamptz ELSE h.observed_at END AS vf,
   COALESCE(lead(h.observed_at) OVER (PARTITION BY h.entity_key ORDER BY h.observed_at,h.id),'infinity') AS vt,
   h.after_terms AS terms
  FROM public.accounting_agreement_history h WHERE h.entity_type='club_members';
  CREATE INDEX ON _lc_mem(club_id,player_id);
  ANALYZE _lc_mem;
  CREATE TEMP TABLE _lc_ag ON COMMIT DROP AS
  SELECT h.entity_key AS agent_key, h.id AS history_id,
   CASE WHEN row_number() OVER (PARTITION BY h.entity_key ORDER BY h.observed_at,h.id)=1 THEN '-infinity'::timestamptz ELSE h.observed_at END AS vf,
   COALESCE(lead(h.observed_at) OVER (PARTITION BY h.entity_key ORDER BY h.observed_at,h.id),'infinity') AS vt,
   (h.after_terms->>'id')::uuid AS agent_id,(h.after_terms->>'club_id')::uuid AS club_id,(h.after_terms->>'user_id')::uuid AS user_id,
   h.after_terms->>'role' AS role,h.after_terms->>'status' AS status,
   CASE WHEN (h.after_terms->>'commission_rate')::numeric>1 THEN (h.after_terms->>'commission_rate')::numeric/100 ELSE (h.after_terms->>'commission_rate')::numeric END AS rate,
   COALESCE((h.after_terms->>'player_rakeback_rate')::numeric,0) AS offer,
   NULLIF(h.after_terms->>'parent_agent_id','')::uuid AS parent_id
  FROM public.accounting_agreement_history h WHERE h.entity_type='agents';
  DELETE FROM _lc_ag WHERE agent_id IS NULL;
  CREATE INDEX ON _lc_ag(agent_id);
  CREATE INDEX ON _lc_ag(agent_key);
  ANALYZE _lc_ag;
  CREATE TEMP TABLE _lc_x ON COMMIT DROP AS
  SELECT x.*, m.history_id AS membership_history_id,
   NULLIF(m.terms->>'agent_id','')::uuid AS agent_user,
   COALESCE((m.terms->>'player_rakeback_pct')::numeric,0) AS deal,
   (m.terms IS NOT NULL AND m.terms<>'null'::jsonb AND m.terms->>'status' IN('active','approved') AND COALESCE((m.terms->>'is_active')::boolean,true)) AS member_active
  FROM _lc_rows x LEFT JOIN _lc_mem m ON m.club_id=x.club_id AND m.player_id=x.player_id AND x.terms_at>=m.vf AND x.terms_at<m.vt;
  IF EXISTS(SELECT 1 FROM _lc_x WHERE member_active IS NOT TRUE) THEN
   RAISE EXCEPTION 'legacy_discharge_membership_not_active_at_earning' USING ERRCODE='55000',
    DETAIL=(SELECT count(*) FROM _lc_x WHERE member_active IS NOT TRUE)::text; END IF;
  -- The direct agent: the membership's agent, else the player's own agency.
  ANALYZE _lc_x;
  ALTER TABLE _lc_x ADD COLUMN direct_agent uuid, ADD COLUMN direct_count int;
  CREATE TEMP TABLE _lc_da ON COMMIT DROP AS
  SELECT x.rid,count(*)::int AS n,(array_agg(g.agent_id))[1] AS agent_id FROM _lc_x x JOIN _lc_ag g
    ON g.club_id=x.club_id AND g.user_id=COALESCE(x.agent_user,x.player_id) AND g.status='active' AND x.terms_at>=g.vf AND x.terms_at<g.vt
  GROUP BY x.rid;
  UPDATE _lc_x x SET direct_agent=d.agent_id,direct_count=d.n FROM _lc_da d WHERE d.rid=x.rid;
  IF EXISTS(SELECT 1 FROM _lc_x WHERE direct_count>1 OR (agent_user IS NOT NULL AND COALESCE(direct_count,0)<>1)) THEN
   RAISE EXCEPTION 'legacy_discharge_agent_terms_unresolved' USING ERRCODE='55000'; END IF;
  -- Commission tiers per source row: each upline rate on the remaining rake
  -- after the preceding tier, each tier rounded to cents (fn_accounting_earning_contract).
  CREATE TEMP TABLE _lc_tier ON COMMIT DROP AS
  WITH RECURSIVE t(rake_record_id,player_id,club_id,terms_at,depth,agent_id,user_id,role,status,rate,amount,remaining,parent_id,seen,agent_club) AS (
   SELECT x.rake_record_id,x.player_id,x.club_id,x.terms_at,1,g.agent_id,g.user_id,g.role,g.status,g.rate,
    round(x.amt*g.rate,2),x.amt-round(x.amt*g.rate,2),g.parent_id,ARRAY[g.agent_id],g.club_id
   FROM _lc_x x JOIN _lc_ag g ON g.agent_id=x.direct_agent AND x.terms_at>=g.vf AND x.terms_at<g.vt
   UNION ALL
   SELECT t.rake_record_id,t.player_id,t.club_id,t.terms_at,t.depth+1,g.agent_id,g.user_id,g.role,g.status,g.rate,
    round(t.remaining*g.rate,2),t.remaining-round(t.remaining*g.rate,2),g.parent_id,t.seen||g.agent_id,g.club_id
   FROM t JOIN _lc_ag g ON g.agent_key=t.parent_id::text AND t.terms_at>=g.vf AND t.terms_at<g.vt
   WHERE t.depth<64 AND NOT g.agent_id=ANY(t.seen))
  SELECT * FROM t;
  ANALYZE _lc_tier;
  IF EXISTS(SELECT 1 FROM _lc_tier WHERE status<>'active' OR role NOT IN('super_agent','agent','sub_agent') OR rate IS NULL OR rate<0 OR rate>1
    OR club_id IS DISTINCT FROM agent_club)
  THEN RAISE EXCEPTION 'legacy_discharge_hierarchy_invalid_at_earning' USING ERRCODE='55000'; END IF;
  -- Rakeback per row by the recorded rate rule (20260921082544).
  CREATE TEMP TABLE _lc_tot ON COMMIT DROP AS SELECT club_id,player_id,sum(amt) AS tr FROM _lc_x GROUP BY 1,2;
  CREATE TEMP TABLE _lc_rb ON COMMIT DROP AS
  SELECT x.club_id,x.player_id,x.amt,(x.earned_at<v_h0) AS in_head,x.agent_user,
   CASE WHEN g.rate>0 AND x.agent_user IS NOT NULL THEN least(b.base,greatest(g.rate-0.10,0)) ELSE b.base END AS rate
  FROM _lc_x x JOIN _lc_tot o ON o.club_id=x.club_id AND o.player_id=x.player_id
  LEFT JOIN _lc_ag g ON x.agent_user IS NOT NULL AND g.agent_id=x.direct_agent AND x.terms_at>=g.vf AND x.terms_at<g.vt
  CROSS JOIN LATERAL (SELECT CASE WHEN x.deal>0 THEN x.deal WHEN x.agent_user IS NOT NULL AND g.offer>0 THEN g.offer
    WHEN o.tr>=10000 THEN 0.30 WHEN o.tr>=2000 THEN 0.20 WHEN o.tr>=500 THEN 0.15 WHEN o.tr>=100 THEN 0.10 ELSE 0.05 END AS base) b;
  CREATE TEMP TABLE _lc_pay ON COMMIT DROP AS
  SELECT club_id,player_id,round(sum(amt),2) AS rake,sum(amt*rate) AS unrounded,round(sum(amt*rate),2) AS rakeback,
   round(sum(amt) FILTER (WHERE in_head),2) AS head_rake,round(COALESCE(sum(amt*rate) FILTER (WHERE in_head),0),2) AS head_rakeback,
   count(*) AS rows_count,count(DISTINCT agent_user) AS payers,(array_agg(DISTINCT agent_user) FILTER (WHERE agent_user IS NOT NULL))[1] AS agent_user,
   bool_or(agent_user IS NULL) AS has_club_payer
  FROM _lc_rb GROUP BY 1,2;
  IF EXISTS(SELECT 1 FROM _lc_pay WHERE payers>1 OR (payers=1 AND has_club_payer) OR agent_user=player_id OR rakeback>rake) THEN
   RAISE EXCEPTION 'legacy_discharge_period_has_more_than_one_payer' USING ERRCODE='55000'; END IF;
  -- Periods: restate the pending legacy row for the same club, player and
  -- week to its measured figures, or open the row the week never had.
  CREATE TEMP TABLE _lc_period ON COMMIT DROP AS
  SELECT p.*, rp.id AS period_id, rp.status AS period_status,
   CASE WHEN rp.id IS NULL THEN NULL ELSE jsonb_build_object('rake_generated',rp.rake_generated,'rakeback_rate',rp.rakeback_rate,
     'rakeback_amount',rp.rakeback_amount,'rakeback_earned',rp.rakeback_earned,'total_rake_paid',rp.total_rake_paid,'created_at',rp.created_at) END AS recorded_row
  FROM _lc_pay p LEFT JOIN public.rakeback_periods rp ON rp.club_id=p.club_id AND rp.user_id=p.player_id AND rp.period_start=v_from AND rp.period_end=v_to;
  IF EXISTS(SELECT 1 FROM _lc_period WHERE period_id IS NOT NULL AND period_status<>'pending')
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp JOIN _lc_period l ON l.period_id=pp.rakeback_period_id)
  THEN RAISE EXCEPTION 'legacy_discharge_period_already_paid' USING ERRCODE='55000'; END IF;
  UPDATE public.rakeback_periods rp SET rake_generated=l.rake,total_rake_paid=l.rake,rakeback_amount=l.rakeback,rakeback_earned=l.rakeback,
   rakeback_rate=CASE WHEN l.rake>0 THEN round(l.unrounded/l.rake,4) ELSE 0 END,
   deferred_reason='Restated to its measured cash figures by owner-authorized operation '||p_operation_id::text||' (was rake '||rp.rake_generated::text||', rakeback '||rp.rakeback_amount::text||' from the stalled legacy daily writer).',
   deferred_at=now()
  FROM _lc_period l WHERE l.period_id=rp.id;
  WITH ins AS (INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,total_rake_paid,rakeback_amount,rakeback_earned,rakeback_rate,status,deferred_reason,deferred_at)
   SELECT l.player_id,l.club_id,v_from,v_to,l.rake,l.rake,l.rakeback,l.rakeback,CASE WHEN l.rake>0 THEN round(l.unrounded/l.rake,4) ELSE 0 END,'pending',
    'Opened with its measured cash figures by owner-authorized operation '||p_operation_id::text||' (the legacy writer booked this play under the union house club or never reached it).',now()
   FROM _lc_period l WHERE l.period_id IS NULL RETURNING id,club_id,user_id)
  UPDATE _lc_period l SET period_id=ins.id FROM ins WHERE ins.club_id=l.club_id AND ins.user_id=l.player_id AND l.period_id IS NULL;
  INSERT INTO public.accounting_legacy_rakeback_certificates(certificate_kind,operation_id,period_id,club_id,player_id,payer_kind,payer_user_id,payer_entity_id,
    rake_generated,rakeback_amount,display_rate,measurement)
  SELECT 'owner_legacy_v1',p_operation_id,l.period_id,l.club_id,l.player_id,CASE WHEN l.agent_user IS NULL THEN 'club' ELSE 'agent' END,l.agent_user,
   COALESCE(l.agent_user,l.club_id),l.rake,l.rakeback,CASE WHEN l.rake>0 THEN round(l.unrounded/l.rake,4) ELSE 0 END,
   jsonb_build_object('basis','cash rake records of the week: rake_records.player_contributions allocated by fn_allocate_rake_credits; earning club from accounting_cash_rake_sources else ca_union_rake_attribution; terms from accounting_agreement_history at earning time, each agreement''s first observation standing for the time before it; rate rule of 20260921082544',
    'source_rows',l.rows_count,'rake',l.rake,'rakeback_unrounded',l.unrounded,'head_rake',COALESCE(l.head_rake,0),'head_rakeback',l.head_rakeback,
    'first_observation',v_h0,'recorded_row_before',l.recorded_row,'authorized_by',p_authorized_by)
  FROM _lc_period l;
  -- Recorded legacy rows of this week that carry no measured cash payable in
  -- their club (house-club bookings and tournament-only rows) are superseded
  -- at payment, never deleted.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('period_id',rp.id,'club_id',rp.club_id,'user_id',rp.user_id,'rake_generated',rp.rake_generated,'rakeback_amount',rp.rakeback_amount) ORDER BY rp.id),'[]')
   INTO v_superseded FROM public.rakeback_periods rp
   WHERE rp.status='pending' AND rp.period_start=v_from AND rp.period_end=v_to AND (rp.club_id=v_union OR rp.club_id=ANY(v_scope_clubs))
     AND NOT EXISTS(SELECT 1 FROM _lc_period l WHERE l.period_id=rp.id);
  -- Round 2 plan: the recorded hierarchy edges, top down. Each tier receives
  -- its own amount plus every amount below it in the same source row.
  CREATE TEMP TABLE _lc_tw ON COMMIT DROP AS
  SELECT t.*, sum(t.amount) OVER w AS cum, lead(t.user_id) OVER w AS parent_user,
   max(t.depth) OVER (PARTITION BY t.rake_record_id,t.player_id) AS top
  FROM _lc_tier t WINDOW w AS (PARTITION BY t.rake_record_id,t.player_id ORDER BY t.depth);
  IF EXISTS(SELECT 1 FROM _lc_tw WHERE parent_id IS NOT NULL AND parent_user IS NULL) THEN
   RAISE EXCEPTION 'legacy_discharge_hierarchy_invalid_at_earning' USING ERRCODE='55000'; END IF;
  CREATE TEMP TABLE _lc_depth ON COMMIT DROP AS SELECT DISTINCT club_id,user_id,role,top-depth AS level FROM _lc_tw;
  IF EXISTS(SELECT 1 FROM _lc_depth GROUP BY club_id,user_id HAVING count(DISTINCT role)<>1 OR count(DISTINCT level)<>1) THEN
   RAISE EXCEPTION 'legacy_discharge_hierarchy_ambiguous' USING ERRCODE='55000'; END IF;
  CREATE TEMP TABLE _lc_edge ON COMMIT DROP AS
  SELECT club_id,parent_user AS payer_user,user_id AS payee_user,min(role) AS role,sum(cum) AS amount FROM _lc_tw GROUP BY 1,2,3;
  CREATE TEMP TABLE _lc_node ON COMMIT DROP AS SELECT club_id,user_id,min(role) AS role,sum(amount) AS own,count(*) FILTER (WHERE amount>0) AS rows_count FROM _lc_tier GROUP BY 1,2;
  IF EXISTS(SELECT 1 FROM _lc_node n WHERE n.own IS DISTINCT FROM
    COALESCE((SELECT sum(e.amount) FROM _lc_edge e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(e.amount) FROM _lc_edge e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
  THEN RAISE EXCEPTION 'legacy_discharge_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_legacy_settlement_legs(operation_id,round_no,scope_kind,scope_id,club_id,payer_kind,payer_id,payee_kind,payee_id,payee_role,amount,own_amount,sort_order,measurement)
  SELECT p_operation_id,2,CASE WHEN e.club_id=ANY(v_members) THEN 'union' ELSE 'club' END,CASE WHEN e.club_id=ANY(v_members) THEN v_union ELSE e.club_id END,
   e.club_id,CASE WHEN e.payer_user IS NULL THEN 'club' ELSE 'agent' END,COALESCE(e.payer_user,e.club_id),'agent',e.payee_user,e.role,e.amount,n.own,d.level,
   jsonb_build_object('basis','per source row tiers of fn_accounting_earning_contract: each upline rate on the rake remaining after the preceding tier, rounded to cents','pass_through',e.payer_user IS NOT NULL,'authorized_by',p_authorized_by)
  FROM _lc_edge e JOIN _lc_node n ON n.club_id=e.club_id AND n.user_id=e.payee_user
  JOIN _lc_depth d ON d.club_id=e.club_id AND d.user_id=e.payee_user WHERE e.amount>0;
  -- Round 1 plan: the union pays each member club its recorded share of that
  -- club's cash rake, truncated to cents (fn_accounting_union_earned_plan).
  INSERT INTO public.accounting_legacy_settlement_legs(operation_id,round_no,scope_kind,scope_id,club_id,payer_kind,payer_id,payee_kind,payee_id,payee_role,amount,own_amount,sort_order,measurement)
  SELECT p_operation_id,1,'union',v_union,c.club_id,'union',v_union,'club',c.club_id,NULL,trunc(c.rake*a.rate,2),NULL,0,
   jsonb_build_object('basis','cash rake of the member club this week (same rows as the certificates) at the recorded union agreement rate, truncated to cents','rake_in',c.rake,'rate',a.rate,'history_id',a.history_id,'authorized_by',p_authorized_by)
  FROM (SELECT club_id,round(sum(amt),2) AS rake FROM _lc_x WHERE club_id=ANY(v_members) GROUP BY 1) c
  CROSS JOIN LATERAL (SELECT h.id AS history_id,COALESCE((h.after_terms->>'rate_cash')::numeric,(h.after_terms->>'club_commission_rate')::numeric) AS rate
    FROM public.accounting_agreement_history h WHERE h.entity_type='union_clubs' AND h.club_id=c.club_id AND h.after_terms->>'union_id'=v_union::text
    ORDER BY h.observed_at DESC,h.id DESC LIMIT 1) a
  WHERE trunc(c.rake*a.rate,2)>0;
  IF EXISTS(SELECT 1 FROM (SELECT h.observed_at,row_number() OVER (PARTITION BY h.entity_key ORDER BY h.observed_at,h.id) AS n
     FROM public.accounting_agreement_history h WHERE h.entity_type='union_clubs' AND h.club_id=ANY(v_members)) q WHERE q.n>1 AND q.observed_at<v_end)
   OR (SELECT count(*) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=p_operation_id AND l.round_no=1)<>
      (SELECT count(DISTINCT club_id) FROM _lc_x WHERE club_id=ANY(v_members))
   OR EXISTS(SELECT 1 FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=p_operation_id AND l.round_no=1
      AND ((l.measurement->>'rate')::numeric IS NULL OR (l.measurement->>'rate')::numeric<0 OR (l.measurement->>'rate')::numeric>1))
  THEN RAISE EXCEPTION 'legacy_discharge_union_agreement_unresolved' USING ERRCODE='55000'; END IF;
  -- The recorded commission rows this payment supersedes (settled at payment).
  SELECT jsonb_build_object('rows',count(*),'amount',COALESCE(sum(ac.amount),0)) INTO v_commission_rows FROM public.agent_commissions ac
   WHERE ac.created_at>=p_period_start AND ac.created_at<v_end AND ac.settled_at IS NULL
     AND ac.source_type IN('rake_settlement','cash_rake_accrual') AND (ac.club_id=v_union OR ac.club_id=ANY(v_scope_clubs));
  v_derived:=jsonb_build_object('mode',p_mode,'union_id',v_union,'first_observation',v_h0,
   'basis',(SELECT sum(amt) FROM _lc_x),'source_rows',(SELECT count(*) FROM _lc_x),'pairs',(SELECT count(*) FROM _lc_pay),
   'payable',(SELECT sum(rakeback) FROM _lc_pay),
   'payable_by_club',(SELECT jsonb_object_agg(club_id,s) FROM (SELECT club_id,sum(rakeback) s FROM _lc_pay GROUP BY 1) q),
   'rake_by_club',(SELECT jsonb_object_agg(club_id,s) FROM (SELECT club_id,sum(rake) s FROM _lc_pay GROUP BY 1) q),
   'head_rakeback',(SELECT sum(head_rakeback) FROM _lc_pay),
   'agent_paid_rakeback',(SELECT sum(rakeback) FROM _lc_pay WHERE agent_user IS NOT NULL),
   'club_paid_rakeback',(SELECT sum(rakeback) FROM _lc_pay WHERE agent_user IS NULL),
   'commission_total',(SELECT sum(own) FROM _lc_node),'commission_nodes',(SELECT count(*) FROM _lc_node),
   'round2_legs',(SELECT count(*) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=p_operation_id AND l.round_no=2),
   'round1',(SELECT jsonb_object_agg(club_id,amount) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=p_operation_id AND l.round_no=1),
   'restated_periods',(SELECT count(*) FROM _lc_period WHERE recorded_row IS NOT NULL),
   'opened_periods',(SELECT count(*) FROM _lc_period WHERE recorded_row IS NULL),
   'superseded_periods',jsonb_array_length(v_superseded),
   'superseded_amount',(SELECT COALESCE(sum((x->>'rakeback_amount')::numeric),0) FROM jsonb_array_elements(v_superseded) x),
   'recorded_commission_rows',v_commission_rows);
  FOR r IN SELECT k FROM unnest(ARRAY['basis','pairs','payable','payable_by_club','commission_total','round1','round2_legs','superseded_periods']) k LOOP
   IF v_derived->r.k IS DISTINCT FROM p_expected->r.k THEN
    RAISE EXCEPTION 'legacy_discharge_measurement_moved' USING ERRCODE='55000',DETAIL=jsonb_build_object('field',r.k,'derived',v_derived)::text; END IF;
  END LOOP;
  v_derived:=v_derived||jsonb_build_object('superseded',v_superseded);
 END IF;

 -- The operation row is written whole, last; the certificates and plan rows
 -- above reference it through deferred foreign keys in this same transaction.
 INSERT INTO public.accounting_owner_legacy_operations(operation_id,mode,period_start,period_end,union_id,authorized_by,authorization_text,state,certification)
 VALUES(p_operation_id,p_mode,p_period_start,v_end,v_union,p_authorized_by,p_authorization_text,'certified',v_derived||jsonb_build_object('expected',p_expected));
 RETURN v_derived-'superseded';
END $fn$;
-- 7. PAY. Executes a certified operation once, through the same leg shapes,
--    stand-downs, document authority and assertions as the weekly stages.
--    All of it lands or none of it does. A payer that cannot cover what it
--    owes refuses the whole operation with the exact shortfall.
CREATE FUNCTION public.fn_accounting_legacy_pay_week(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
 op public.accounting_owner_legacy_operations%ROWTYPE; r record; sc record;
 v_from date; v_to date; v_ctx_union text; v_ctx text; v_members uuid[]; v_standalone uuid[];
 club_skip text; member_skip text; union_skip text; routing_context text; maintenance text; v_category text;
 payer_before numeric; payer_after numeric; payee_before numeric; payee_after numeric;
 payout_id uuid; wallet_id uuid; ledger_id uuid; v_credit jsonb; v_total numeric; v_rw_before numeric; v_rw_after numeric;
 v_shortfalls jsonb; v_settled bigint; v_settled_amount numeric; v_closed bigint; v_legs int:=0; v_amount numeric:=0;
 v_result jsonb; v_r1 numeric:=0; v_r2 numeric:=0; v_r3 numeric:=0; v_r2_legs int:=0; v_r3_payees int:=0; v_r3_periods int:=0;
 v_opening jsonb; v_fingerprint text; v_scope uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF public.fn_platform_frozen() OR extract(minute FROM clock_timestamp())>=45 OR extract(minute FROM clock_timestamp())<4 THEN
  RAISE EXCEPTION 'legacy_discharge_outside_the_maintenance_window_only' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN
  RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 SELECT * INTO op FROM public.accounting_owner_legacy_operations WHERE operation_id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy_discharge_not_certified' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('owner-legacy-discharge:'||extract(epoch FROM op.period_start)::text,0));
 SELECT * INTO op FROM public.accounting_owner_legacy_operations WHERE operation_id=p_operation_id FOR UPDATE;
 IF op.state='paid' THEN RETURN op.result||jsonb_build_object('duplicate',true); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.discharged_operation_id IS NOT NULL)
 THEN RAISE EXCEPTION 'legacy_discharge_already_discharged' USING ERRCODE='55000'; END IF;
 v_from:=(op.period_start AT TIME ZONE 'America/Los_Angeles')::date;
 v_to:=(op.period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 v_members:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=op.union_id AND uc.club_id<>op.union_id ORDER BY 1);
 v_standalone:=ARRAY(SELECT d.scope_id FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.scope_kind='club' ORDER BY 1);
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||op.union_id::text||':'||extract(epoch FROM op.period_start)::text||':'||extract(epoch FROM op.period_end)::text,0));
 FOR r IN SELECT unnest(v_standalone) AS club_id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||r.club_id::text||':'||extract(epoch FROM op.period_start)::text||':'||extract(epoch FROM op.period_end)::text,0));
 END LOOP;
 -- No certified period may have been touched since certification.
 IF EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c JOIN public.rakeback_periods rp ON rp.id=c.period_id
   WHERE c.operation_id=op.operation_id AND (rp.status<>'pending' OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=rp.id)))
  OR EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start=op.period_start AND x.period_end=op.period_end
   AND (x.union_id=op.union_id OR x.standalone_club_id=ANY(v_standalone)))
 THEN RAISE EXCEPTION 'legacy_discharge_period_changed_after_certification' USING ERRCODE='55000'; END IF;

 -- Every account the operation moves, with its opening balance.
 CREATE TEMP TABLE _lp_acct(kind text,club_id uuid,user_id uuid,opening numeric,delta numeric NOT NULL DEFAULT 0,PRIMARY KEY(kind,club_id,user_id)) ON COMMIT DROP;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,player_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payer_user_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='agent'
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payee_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payer_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2 AND payer_kind='agent'
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT DISTINCT 'club',club_id,club_id FROM (
   SELECT club_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id
   UNION SELECT club_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='club') q
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) VALUES('union',op.union_id,op.union_id);
 -- Planned deltas.
 UPDATE _lp_acct a SET delta=a.delta+q.d FROM (SELECT q0.kind,q0.club_id,q0.user_id,sum(q0.d) AS d FROM (
   SELECT 'member' AS kind,club_id,player_id AS user_id,sum(rakeback_amount) AS d FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id GROUP BY 2,3
   UNION ALL SELECT 'member',club_id,payer_user_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='agent' GROUP BY 2,3
   UNION ALL SELECT 'club',club_id,club_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='club' GROUP BY 2,3
   UNION ALL SELECT 'union',op.union_id,op.union_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='union'
   UNION ALL SELECT CASE WHEN payee_kind='club' THEN 'club' ELSE 'member' END,club_id,payee_id,sum(amount) FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id GROUP BY 1,2,3
   UNION ALL SELECT CASE payer_kind WHEN 'union' THEN 'union' WHEN 'club' THEN 'club' ELSE 'member' END,CASE WHEN payer_kind='union' THEN op.union_id ELSE club_id END,payer_id,-sum(amount)
    FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id GROUP BY 1,2,3) q0 WHERE q0.d IS NOT NULL GROUP BY 1,2,3) q
 WHERE a.kind=q.kind AND a.club_id=q.club_id AND a.user_id=q.user_id AND q.d IS NOT NULL;
 IF (SELECT sum(delta) FROM _lp_acct)<>0 THEN RAISE EXCEPTION 'legacy_discharge_plan_does_not_conserve' USING ERRCODE='23514'; END IF;

 -- The recorded commission rows this payment supersedes are settled first,
 -- before any wallet row is locked.
 IF op.mode='legacy_cascade' THEN
  UPDATE public.agent_commissions ac SET settled_at=now()
   WHERE ac.created_at>=op.period_start AND ac.created_at<op.period_end AND ac.settled_at IS NULL
     AND ac.source_type IN('rake_settlement','cash_rake_accrual') AND (ac.club_id=op.union_id OR ac.club_id=ANY(v_standalone||v_members));
  GET DIAGNOSTICS v_settled=ROW_COUNT;
  IF v_settled<>(op.certification->'recorded_commission_rows'->>'rows')::bigint THEN
   RAISE EXCEPTION 'legacy_discharge_recorded_commissions_moved' USING ERRCODE='55000'; END IF;
 END IF;

 -- Lock in the weekly stages' order: clubs, then member wallets. A standalone
 -- club's treasury also receives live rake, so it is locked (and read) only
 -- when its own scope is paid, last; the union's rake treasury, which receives
 -- live rake on every union hand, is debited once at the very end.
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM _lp_acct WHERE kind='club' AND NOT club_id=ANY(v_standalone)) ORDER BY id FOR UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN _lp_acct a ON a.kind='member' AND a.club_id=cm.club_id AND a.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE _lp_acct a SET opening=cm.chip_balance FROM public.club_members cm WHERE a.kind='member' AND cm.club_id=a.club_id AND cm.user_id=a.user_id;
 UPDATE _lp_acct a SET opening=c.chip_treasury FROM public.clubs c WHERE a.kind='club' AND c.id=a.club_id;
 UPDATE _lp_acct a SET opening=w.rake_wallet FROM public.union_wallets w WHERE a.kind='union' AND w.union_id=a.club_id;
 IF EXISTS(SELECT 1 FROM _lp_acct WHERE opening IS NULL OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'legacy_discharge_account_missing_or_invalid' USING ERRCODE='23514',
  DETAIL=(SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id)) FROM _lp_acct WHERE opening IS NULL)::text; END IF;
 -- Funding: every payer covers what it owes. Order within the operation is
 -- union -> clubs -> agents top down -> players, so a payer's receipts land
 -- before its payments; the final balance is the binding test.
 SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id,'opening',opening,'net',delta,'shortfall',-(opening+delta)) ORDER BY kind,club_id,user_id)
  INTO v_shortfalls FROM _lp_acct WHERE opening+delta<0;
 IF v_shortfalls IS NOT NULL THEN RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',DETAIL=v_shortfalls::text; END IF;
 SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id,'opening',opening,'delta',delta) ORDER BY kind,club_id,user_id) INTO v_opening FROM _lp_acct;

 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 union_skip:=current_setting('app.ledger_autoskip_union_wallets',true);routing_context:=current_setting('app.accounting_routing_context',true);
 maintenance:=current_setting('app.ledger_maintenance',true);v_category:=current_setting('app.ledger_category',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
 v_ctx_union:=op.union_id::text||':'||op.period_start::text||':'||op.period_end::text;

 -- ROUND 1: the union rake treasury funds each member club (union_wallet -> club_treasury).
 FOR r IN SELECT * FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=1 ORDER BY club_id LOOP
  PERFORM public.fn_ca_declare_ledger('rakeback','union_wallet',op.union_id,NULL,NULL,ARRAY['union_wallets','clubs']);
  v_credit:=public.fn_credit_treasury(r.club_id,r.amount,'Owner-authorized legacy union rakeback '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD'),
   jsonb_build_object('union_id',op.union_id,'period_start',op.period_start,'period_end',op.period_end,'legacy_operation_id',op.operation_id,'plan_leg_id',r.id),
   'owner_legacy:'||op.operation_id::text||':round1:'||r.club_id::text);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR (v_credit->>'balance_after')::numeric-(v_credit->>'balance_before')::numeric<>r.amount THEN
   RAISE EXCEPTION 'legacy_discharge_round1_credit_failed' USING ERRCODE='23514',DETAIL=v_credit::text; END IF;
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'club_treasury',r.club_id,r.amount,'rakeback',r.club_id,op.union_id,
   'Owner-authorized legacy union rakeback from recorded cash earnings','owner_legacy:'||op.operation_id::text||':round1:'||r.club_id::text,
   jsonb_build_object('legacy_operation_id',op.operation_id,'certificate_kind','owner_legacy_v1','plan_leg_id',r.id,'period_start',op.period_start,'period_end',op.period_end,
    'rake_basis',r.measurement->'rake_in','rate',r.measurement->'rate'),
   (v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO ledger_id;
  IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid' AND i.net_amount=r.amount AND i.chips_transferred AND i.message_sent
    AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
   RAISE EXCEPTION 'legacy_discharge_round1_receipt_missing' USING ERRCODE='23514'; END IF;
  v_r1:=v_r1+r.amount; v_legs:=v_legs+1;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);

 -- Rounds 2 and 3 per accounting scope: the union's scope first, then each
 -- standalone club, whose treasury is locked and read only at that point.
 FOREACH v_scope IN ARRAY (ARRAY[NULL::uuid]||v_standalone) LOOP
 IF v_scope IS NOT NULL THEN
  PERFORM id FROM public.clubs WHERE id=v_scope FOR UPDATE;
  UPDATE _lp_acct a SET opening=c.chip_treasury FROM public.clubs c WHERE a.kind='club' AND a.club_id=v_scope AND c.id=v_scope;
  IF EXISTS(SELECT 1 FROM _lp_acct WHERE kind='club' AND club_id=v_scope AND (opening IS NULL OR opening+delta<0)) THEN
   RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',
    DETAIL=(SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'opening',opening,'net',delta,'shortfall',-(opening+delta))) FROM _lp_acct WHERE kind='club' AND club_id=v_scope)::text; END IF;
 END IF;
 -- ROUND 2: clubs pay the recorded hierarchy, top down (club_treasury/player_wallet -> player_wallet).
 FOR r IN SELECT * FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2
   AND ((v_scope IS NULL AND scope_kind='union') OR (v_scope IS NOT NULL AND scope_kind='club' AND club_id=v_scope)) ORDER BY sort_order,club_id,payer_kind DESC,payer_id,payee_id LOOP
  v_ctx:=CASE WHEN r.scope_kind='union' THEN v_ctx_union ELSE 'club:'||r.club_id::text||':'||op.period_start::text||':'||op.period_end::text END;
  PERFORM set_config('app.accounting_routing_context',v_ctx,true);
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payee_id;
  IF r.payer_kind='club' THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-r.amount WHERE id=r.club_id AND chip_treasury>=r.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_id;
   UPDATE public.club_members SET chip_balance=chip_balance-r.amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_id AND chip_balance>=r.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+r.amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payee_id RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>r.amount OR payee_after-payee_before<>r.amount THEN
   RAISE EXCEPTION 'legacy_discharge_round2_transfer_not_conserved' USING ERRCODE='23514',DETAIL=jsonb_build_object('leg',r.id,'payer_before',payer_before)::text; END IF;
  IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(r.payer_id,'PLAYER','debit',r.amount,'commission','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(r.payee_id,'PLAYER','credit',r.amount,'commission','Recorded weekly commission budget received (owner-authorized legacy week)',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,r.payer_id,
   'player_wallet',r.payee_id,r.amount,'commission',r.club_id,CASE WHEN r.scope_kind='union' THEN op.union_id END,
   'Weekly commission through recorded earning hierarchy (owner-authorized legacy week)','owner_legacy:'||op.operation_id::text||':round2:'||r.club_id::text||':'||r.payer_id::text||':'||r.payee_id::text,
   jsonb_build_object('routing_version',3,'accounting_scope_kind',r.scope_kind,'accounting_scope_id',r.scope_id,'period_start',op.period_start,'period_end',op.period_end,
    'payee_role_at_transfer',r.payee_role,'own_commission',r.own_amount,'pass_through',r.payer_kind='agent','legacy_operation_id',op.operation_id,
    'certificate_kind','owner_legacy_v1','plan_leg_id',r.id),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  IF (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid' AND i.chips_transferred AND i.message_sent
    AND i.net_amount=r.amount AND i.gross_amount=r.amount AND i.deductions=0)<>1 THEN
   RAISE EXCEPTION 'legacy_discharge_round2_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
  v_r2:=v_r2+CASE WHEN r.payer_kind='club' THEN r.amount ELSE 0 END; v_r2_legs:=v_r2_legs+1; v_legs:=v_legs+1;
 END LOOP;

 -- ROUND 3: each certified period to its payee (agent/club/union -> player_wallet).
 IF op.mode='union_direct' THEN
  PERFORM public.fn_ca_declare_ledger('rakeback','union_wallet',op.union_id,NULL,NULL,ARRAY['union_wallets','club_members']);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
 FOR r IN SELECT c.*,rp.club_id AS period_club_id FROM public.accounting_legacy_rakeback_certificates c JOIN public.rakeback_periods rp ON rp.id=c.period_id
   WHERE c.operation_id=op.operation_id
     AND ((v_scope IS NULL AND (c.payer_kind='union' OR c.club_id=ANY(v_members) OR c.club_id=op.union_id))
       OR (v_scope IS NOT NULL AND c.club_id=v_scope AND c.payer_kind<>'union')) ORDER BY c.club_id,c.payer_user_id NULLS FIRST,c.player_id,c.period_id LOOP
  -- The scope a disputing player is shown the payment under.
  IF r.payer_kind='union' OR r.club_id=ANY(v_members) OR r.club_id=op.union_id THEN
   v_ctx:=v_ctx_union;
  ELSE
   v_ctx:='club:'||r.club_id::text||':'||op.period_start::text||':'||op.period_end::text;
  END IF;
  PERFORM set_config('app.accounting_routing_context',v_ctx,true);
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.player_id,r.rake_generated,round(r.display_rate*100,2),r.rakeback_amount,'paid',now()) RETURNING id INTO payout_id;
  IF r.rakeback_amount>0 THEN
   SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.player_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-r.rakeback_amount WHERE id=r.club_id AND chip_treasury>=r.rakeback_amount RETURNING chip_treasury INTO payer_after;
   ELSIF r.payer_kind='agent' THEN
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user_id;
    UPDATE public.club_members SET chip_balance=chip_balance-r.rakeback_amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user_id AND chip_balance>=r.rakeback_amount RETURNING chip_balance INTO payer_after;
   ELSE
    -- The union's rake treasury is debited once, after every leg, so the row
    -- the engine writes rake to is held only for the final statement.
    payer_before:=NULL; payer_after:=NULL;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+r.rakeback_amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.player_id RETURNING chip_balance INTO payee_after;
   IF payee_after IS NULL OR payee_after-payee_before<>r.rakeback_amount
    OR (r.payer_kind<>'union' AND (payer_after IS NULL OR payer_before-payer_after<>r.rakeback_amount)) THEN
    RAISE EXCEPTION 'legacy_discharge_round3_transfer_not_conserved' USING ERRCODE='23514',DETAIL=r.period_id::text; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user_id,'PLAYER','debit',r.rakeback_amount,'rakeback','Weekly rakeback paid under recorded agreement (owner-authorized legacy week)',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.player_id,'PLAYER','credit',r.rakeback_amount,'rakeback',
     CASE WHEN r.payer_kind='union' THEN 'Weekly rakeback paid by the union (owner-authorized legacy week)' ELSE 'Weekly rakeback received under recorded agreement (owner-authorized legacy week)' END,
     payee_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club' THEN 'club_treasury' WHEN 'agent' THEN 'player_wallet' ELSE 'union_wallet' END,r.payer_entity_id,
    'player_wallet',r.player_id,r.rakeback_amount,'rakeback',r.club_id,CASE WHEN v_ctx=v_ctx_union THEN op.union_id END,
    CASE WHEN r.payer_kind='union' THEN 'Weekly rakeback paid by the union from its rake treasury (owner-authorized legacy week)' ELSE 'Weekly rakeback from certified legacy payer (owner-authorized legacy week)' END,
    'owner_legacy:round3:'||r.period_id::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',CASE WHEN v_ctx=v_ctx_union THEN 'union' ELSE 'club' END,
     'accounting_scope_id',CASE WHEN v_ctx=v_ctx_union THEN op.union_id ELSE r.club_id END,'period_id',r.period_id,
     'period_start',op.period_start,'period_end',op.period_end,'certificate_id',r.id,'certificate_kind','owner_legacy_v1','legacy_operation_id',op.operation_id,
     'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player','recorded_period_club_id',r.period_club_id),
    payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
   IF (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
     AND i.chips_transferred AND i.message_sent AND i.net_amount=r.rakeback_amount AND i.gross_amount=r.rakeback_amount AND i.deductions=0)<>1 THEN
    RAISE EXCEPTION 'legacy_discharge_round3_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   v_r3:=v_r3+r.rakeback_amount; v_r3_payees:=v_r3_payees+1; v_legs:=v_legs+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy_discharge_period_changed_after_certification' USING ERRCODE='55000'; END IF;
  v_r3_periods:=v_r3_periods+1;
 END LOOP;

 END LOOP;

 -- The union treasury: one debit for everything it paid in this operation.
 SELECT -COALESCE(delta,0) INTO v_total FROM _lp_acct WHERE kind='union';
 IF v_total>0 THEN
  SELECT rake_wallet INTO v_rw_before FROM public.union_wallets WHERE union_id=op.union_id FOR UPDATE;
  UPDATE public.union_wallets SET rake_wallet=rake_wallet-v_total,total_settlements=COALESCE(total_settlements,0)+v_r1,updated_at=now()
   WHERE union_id=op.union_id AND rake_wallet>=v_total RETURNING rake_wallet INTO v_rw_after;
  IF v_rw_after IS NULL OR v_rw_before-v_rw_after<>v_total THEN
   RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',
    DETAIL=jsonb_build_array(jsonb_build_object('kind','union','union_id',op.union_id,'opening',v_rw_before,'owed',v_total,'shortfall',v_total-v_rw_before))::text; END IF;
  INSERT INTO public.union_wallet_transactions(union_id,club_id,amount,tx_type,wallet,direction,balance_after,notes)
  SELECT op.union_id,x.club_id,x.amount,'rakeback','rake_wallet','debit',v_rw_before-sum(x.amount) OVER (ORDER BY x.ord),x.note FROM (
   SELECT 1 AS grp,l.club_id,l.amount,'Owner-authorized legacy weekly rakeback to club '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD')||' (operation '||op.operation_id::text||')' AS note,
     row_number() OVER (ORDER BY l.club_id) AS ord FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=1
   UNION ALL SELECT 2,c.club_id,sum(c.rakeback_amount),'Owner-authorized union payment of deferred player rakeback '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD')||' to members of this club (operation '||op.operation_id::text||')',
     1000+row_number() OVER (ORDER BY c.club_id)
    FROM public.accounting_legacy_rakeback_certificates c WHERE c.operation_id=op.operation_id AND c.payer_kind='union' AND c.rakeback_amount>0 GROUP BY c.club_id) x;
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(union_skip,''),true);PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 PERFORM set_config('app.ledger_category',COALESCE(v_category,''),true);PERFORM set_config('app.ledger_counterparty','',true);PERFORM set_config('app.ledger_counterparty_entity','',true);

 -- CONSERVATION, asserted on the balances themselves.
 IF EXISTS(SELECT 1 FROM _lp_acct a LEFT JOIN public.club_members cm ON a.kind='member' AND cm.club_id=a.club_id AND cm.user_id=a.user_id
   LEFT JOIN public.clubs cl ON a.kind='club' AND cl.id=a.club_id LEFT JOIN public.union_wallets w ON a.kind='union' AND w.union_id=a.club_id
   WHERE a.kind<>'union' AND COALESCE(cm.chip_balance,cl.chip_treasury) IS DISTINCT FROM a.opening+a.delta)
 THEN RAISE EXCEPTION 'legacy_discharge_final_balance_incorrect' USING ERRCODE='23514'; END IF;

 -- Run identity the payout legs are shown under (same run table, explicit source).
 v_fingerprint:=md5(op.certification::text);
 FOR sc IN SELECT DISTINCT CASE WHEN x.scope='union' THEN op.union_id END AS union_id, CASE WHEN x.scope='club' THEN x.club_id END AS club_id FROM (
    SELECT CASE WHEN payer_kind='union' OR club_id=ANY(v_members) OR club_id=op.union_id THEN 'union' ELSE 'club' END AS scope,club_id
     FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id
    UNION SELECT scope_kind,club_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2) x LOOP
  IF EXISTS(SELECT 1 FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2
     AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.scope_kind='club' AND l.club_id=sc.club_id))) THEN
   INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
   VALUES(sc.union_id,sc.club_id,op.period_start,op.period_end,2,v_fingerprint,jsonb_build_object('success',true,'round',2,'name','owner_legacy_recorded_commission_hierarchy',
    'routing_version',3,'source','owner_legacy_discharge_v1','legacy_operation_id',op.operation_id,'authorized_by',op.authorized_by,'shortfalls',0,
    'payees',(SELECT count(DISTINCT l.payee_id) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2
      AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.club_id=sc.club_id AND l.scope_kind='club'))),
    'amount',(SELECT COALESCE(sum(l.amount),0) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2 AND l.payer_kind='club'
      AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.club_id=sc.club_id AND l.scope_kind='club')))));
  END IF;
  INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(sc.union_id,sc.club_id,op.period_start,op.period_end,3,v_fingerprint,jsonb_build_object('success',true,'round',3,'name','owner_legacy_certified_payer_to_players',
   'routing_version',3,'source','owner_legacy_discharge_v1','legacy_operation_id',op.operation_id,'authorized_by',op.authorized_by,'shortfalls',0,
   'amount',(SELECT COALESCE(sum(x.rakeback_amount),0) FROM public.accounting_legacy_rakeback_certificates x WHERE x.operation_id=op.operation_id
     AND ((sc.union_id IS NOT NULL AND (x.payer_kind='union' OR x.club_id=ANY(v_members) OR x.club_id=op.union_id))
       OR (sc.club_id IS NOT NULL AND x.club_id=sc.club_id AND x.payer_kind<>'union')))));
 END LOOP;

 -- Recorded legacy rows superseded by the measured periods are closed, not deleted.
 IF op.mode='legacy_cascade' THEN
  UPDATE public.rakeback_periods rp SET status='closed',deferred_at=now(),
   deferred_reason='Superseded by owner-authorized operation '||op.operation_id::text||': this recorded row (rake '||rp.rake_generated::text||', rakeback '||rp.rakeback_amount::text
    ||') came from the stalled legacy daily writer and carries no measured cash payable in this club. The cash rakeback of the week was paid on its measured periods; any tournament-fee rakeback it included is outside the recorded obligation and was not paid by this operation.'
  WHERE rp.id IN(SELECT (x->>'period_id')::uuid FROM jsonb_array_elements(op.certification->'superseded') x) AND rp.status='pending';
  GET DIAGNOSTICS v_closed=ROW_COUNT;
  IF v_closed<>jsonb_array_length(op.certification->'superseded') THEN
   RAISE EXCEPTION 'legacy_discharge_superseded_rows_moved' USING ERRCODE='55000'; END IF;
 END IF;

 -- Discharge the record: never delete it. A certificate counts toward the
 -- obligation row of the scope its period was recorded under.
 WITH m AS (
  SELECT CASE WHEN q.s=op.union_id OR q.s=ANY(v_members) THEN 'union' ELSE 'club' END AS kind,
   CASE WHEN q.s=op.union_id OR q.s=ANY(v_members) THEN op.union_id ELSE q.s END AS id, q.amt
  FROM (SELECT CASE WHEN op.mode='union_direct' THEN rp.club_id ELSE x.club_id END AS s, x.rakeback_amount AS amt
   FROM public.accounting_legacy_rakeback_certificates x JOIN public.rakeback_periods rp ON rp.id=x.period_id WHERE x.operation_id=op.operation_id) q),
 agg AS (SELECT kind,id,count(*)::int AS periods,sum(amt) AS amount FROM m GROUP BY 1,2)
 UPDATE public.accounting_deferred_obligations d SET discharged_operation_id=op.operation_id,discharged_at=now(),
  discharged_amount=agg.amount,discharged_periods=agg.periods,
  discharge_note=CASE WHEN op.mode='union_direct' THEN
    'Paid by the union rake treasury under owner-authorized operation '||op.operation_id::text||' ('||op.authorized_by||'): each recorded pending period was paid to its payee with a receipt, Messenger record and notification, and closed. Recorded '||d.pending_amount::text||', paid '||agg.amount::text||'.'
   ELSE 'Paid through the legacy cascade (union -> clubs -> recorded hierarchy -> players) under owner-authorized operation '||op.operation_id::text||' ('||op.authorized_by||') on the measured cash basis. Recorded '||d.pending_amount::text||', paid '||agg.amount::text
    ||CASE WHEN agg.amount<>d.pending_amount THEN '; the difference of '||(d.pending_amount-agg.amount)::text||' arises because the recorded figure was rounded once over the whole scope while each payee is paid in whole cents, and, in a union scope, because the earning-club split of rake whose attribution rows hand retention removed after the 2026-09-21 measurement could not be re-read; no payee is invented for it' ELSE '' END||'.' END
 FROM agg WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.scope_kind=agg.kind AND d.scope_id=agg.id AND d.discharged_operation_id IS NULL;
 IF EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.discharged_operation_id IS NULL)
 THEN RAISE EXCEPTION 'legacy_discharge_obligation_not_discharged' USING ERRCODE='55000'; END IF;

 v_result:=jsonb_build_object('success',true,'legacy_operation_id',op.operation_id,'mode',op.mode,'period_start',op.period_start,'period_end',op.period_end,
  'round1_union_to_clubs',v_r1,'round2_club_direct',v_r2,'round2_legs',v_r2_legs,'round3_amount',v_r3,'round3_payees',v_r3_payees,'round3_periods',v_r3_periods,
  'legs',v_legs,'recorded_commission_rows_settled',v_settled,'superseded_periods_closed',v_closed,'union_rake_wallet_before',v_rw_before,'union_rake_wallet_after',v_rw_after,
  'accounts',v_opening);
 UPDATE public.accounting_owner_legacy_operations SET state='paid',paid_at=now(),result=v_result WHERE operation_id=op.operation_id;
 RETURN v_result-'accounts';
END $fn$;

ALTER FUNCTION public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_legacy_pay_week(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_legacy_pay_week(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_legacy_pay_week(uuid) TO service_role;

-- Read the change back inside the same transaction.
DO $readback$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure);
 IF position($n$ELSIF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c$n$ IN d)=0
  OR position('owner_legacy_v1' IN d)=0 OR position('names no matching owner legacy certificate' IN d)=0
  OR position('names no routed settlement run' IN d)=0 OR position('source-linked paid receipts, expected exactly 1' IN d)=0
 THEN RAISE EXCEPTION 'rakeback_payout_document_guard_not_installed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='zz_ca_rakeback_payout_leg_is_documented'
   AND t.tgenabled='O' AND t.tgdeferrable AND t.tginitdeferred)
 THEN RAISE EXCEPTION 'rakeback_payout_constraint_not_armed' USING ERRCODE='55000'; END IF;
 IF has_function_privilege('authenticated','public.fn_accounting_legacy_pay_week(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_accounting_legacy_pay_week(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_accounting_legacy_pay_week(uuid)','EXECUTE')
  OR (SELECT prosecdef FROM pg_proc WHERE oid='public.fn_accounting_legacy_pay_week(uuid)'::regprocedure) IS NOT TRUE
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid IN('public.accounting_legacy_rakeback_certificates'::regclass,'public.accounting_legacy_settlement_legs'::regclass,
       'public.accounting_owner_legacy_operations'::regclass) AND NOT tgisinternal)<>6
 THEN RAISE EXCEPTION 'owner_legacy_discharge_surface_not_as_declared' USING ERRCODE='55000'; END IF;
END $readback$;

COMMIT;
