CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
-- Owner-directed launch waiver. Historical evidence is retained, never called paid.
-- Component of the qualified reset; installation alone activates no boundary.
CREATE TABLE public.ca_launch_accounting_boundaries (
  scope_kind text NOT NULL CHECK(scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  cutoff_at timestamptz NOT NULL CHECK(isfinite(cutoff_at)),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  waiver_reason text NOT NULL DEFAULT 'Owner Directed Launch Reset: No Prelaunch Obligations Remain Payable',
  undone_at timestamptz,
  PRIMARY KEY(scope_kind,scope_id,operation_id)
);
CREATE UNIQUE INDEX ca_launch_accounting_one_active ON public.ca_launch_accounting_boundaries(scope_kind,scope_id) WHERE undone_at IS NULL;
ALTER TABLE public.ca_launch_accounting_boundaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_boundaries FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.ca_launch_accounting_archives (
  operation_id uuid NOT NULL,
  relation_name text NOT NULL,
  row_key text NOT NULL,
  before_image jsonb NOT NULL,
  row_sha256 text NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY(operation_id,relation_name,row_key)
);
ALTER TABLE public.ca_launch_accounting_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_archives FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_cutoff(p_kind text,p_id uuid) RETURNS timestamptz
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_start(p_kind text,p_id uuid,p_start timestamptz) RETURNS timestamptz
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN p_start IS NULL OR NOT isfinite(p_start) THEN p_start ELSE GREATEST(p_start,public.fn_ca_launch_accounting_cutoff(p_kind,p_id)) END
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_accepts(p_club_id uuid,p_earned_at timestamptz) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END
 FROM (SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff)b
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_waived(p_kind text,p_id uuid,p_end timestamptz) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(isfinite(p_end) AND p_end<=public.fn_ca_launch_accounting_cutoff(p_kind,p_id),false)
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid),public.fn_ca_launch_accounting_start(text,uuid,timestamptz),public.fn_ca_launch_accounting_accepts(uuid,timestamptz),public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid),public.fn_ca_launch_accounting_start(text,uuid,timestamptz),public.fn_ca_launch_accounting_accepts(uuid,timestamptz),public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) TO authenticated,service_role;
COMMENT ON TABLE public.ca_launch_accounting_archives IS 'Immutable launch preimages retained online for seven years; owner-directed waiver is not payment, certification or deletion of original journal/hand history.';
CREATE FUNCTION public.fn_ca_launch_accounting_archive_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'launch_accounting_archive_is_immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_archive_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_archive_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_archives
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE TABLE public.ca_launch_profile_hand_baselines (
 operation_id uuid NOT NULL,
 user_id uuid NOT NULL,
 hand_offset bigint NOT NULL,
 captured_total_hands bigint NOT NULL,
 remaining_club_hands bigint NOT NULL,
 restored_scope_hands bigint NOT NULL,
 captured_at timestamptz NOT NULL,
 PRIMARY KEY(operation_id,user_id)
);
ALTER TABLE public.ca_launch_profile_hand_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_profile_hand_baselines FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_profile_hand_baseline_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_profile_hand_baselines
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE FUNCTION public.fn_ca_launch_accounting_actor(p_club_id uuid) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_operation uuid;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RETURN false; END IF;
 v_operation:=NULLIF(current_setting('app.launch_reset_operation',true),'')::uuid;
 RETURN EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o WHERE o.operation_id=v_operation
   AND o.state IN('captured','executed') AND p_club_id=ANY(o.scoped_club_ids));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_actor(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_invoice_transition(p_old jsonb,p_new jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_operation uuid;v_state text;v_before jsonb;
BEGIN
 IF NOT public.fn_ca_launch_accounting_actor((p_old->>'club_id')::uuid) THEN RETURN false; END IF;
 v_operation:=NULLIF(current_setting('app.launch_reset_operation',true),'')::uuid;
 SELECT o.state INTO v_state FROM public.ca_launch_reset_operations o WHERE o.operation_id=v_operation;
 SELECT a.before_image INTO v_before FROM public.ca_launch_accounting_archives a
  WHERE a.operation_id=v_operation AND a.relation_name='settlement_invoices' AND a.before_image->>'id'=p_old->>'id';
 IF v_before IS NULL OR (p_old-ARRAY['status','updated_at']) IS DISTINCT FROM (p_new-ARRAY['status','updated_at']) THEN RETURN false; END IF;
 RETURN (v_state='captured' AND v_before=p_old AND p_old->>'status' IN('pending','generated','overdue','disputed') AND p_new->>'status'='cancelled')
  OR (v_state='executed' AND p_old->>'status'='cancelled' AND p_new=v_before);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_invoice_transition(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Scope and cutoff testimony cannot be rewritten. Undo marks only its own frozen operation.
CREATE FUNCTION public.fn_ca_launch_accounting_boundary_immutable() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'launch_boundary_delete_forbidden' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'undone_at') IS DISTINCT FROM (to_jsonb(OLD)-'undone_at') OR OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL OR NOT isfinite(NEW.undone_at) THEN RAISE EXCEPTION 'launch_boundary_immutable' USING ERRCODE='23514'; END IF;
 IF public.fn_ca_launch_accounting_actor(OLD.scope_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o WHERE o.operation_id=OLD.operation_id AND o.state='executed' AND o.operation_id::text=current_setting('app.launch_reset_operation',true)) THEN RAISE EXCEPTION 'launch_boundary_undo_actor_invalid' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_boundary_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_boundary_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_boundaries FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_boundary_immutable();



CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    club_id uuid NOT NULL,
    membership_id uuid,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    parent_agent_id uuid,
    commission_rate numeric(5,4) NOT NULL,
    player_rakeback_rate numeric(5,4) NOT NULL,
    credit_limit numeric(15,2) DEFAULT 0 NOT NULL,
    credit_used numeric(15,2) DEFAULT 0 NOT NULL,
    is_prepaid boolean DEFAULT false NOT NULL,
    business_balance numeric(15,2) DEFAULT 0 NOT NULL,
    player_balance numeric(15,2) DEFAULT 0 NOT NULL,
    promo_balance numeric(15,2) DEFAULT 0 NOT NULL,
    total_players integer DEFAULT 0 NOT NULL,
    active_player_count integer DEFAULT 0 NOT NULL,
    sub_agent_count integer DEFAULT 0 NOT NULL,
    weekly_rake_generated numeric(15,2) DEFAULT 0 NOT NULL,
    lifetime_earnings numeric(15,2) DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_rakeback_enabled boolean DEFAULT true,
    rakeback_percentage numeric(5,4) DEFAULT 0.0000,
    agent_wallet_balance numeric(18,2) DEFAULT 0,
    player_wallet_balance numeric(18,4) DEFAULT 0,
    promo_wallet_balance numeric(18,2) DEFAULT 0,
    lifetime_rake_generated numeric(18,4) DEFAULT 0,
    credit_control_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT agents_agent_wallet_balance_nonneg CHECK ((agent_wallet_balance >= (0)::numeric)),
    CONSTRAINT agents_commission_rate_check CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70))),
    CONSTRAINT agents_credit_control_revision_nonnegative CHECK ((credit_control_revision >= 0)),
    CONSTRAINT agents_credit_used_check CHECK ((credit_used >= (0)::numeric)),
    CONSTRAINT agents_player_rakeback_rate_check CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50))),
    CONSTRAINT agents_promo_wallet_balance_nonneg CHECK ((promo_wallet_balance >= (0)::numeric)),
    CONSTRAINT agents_role_check CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text]))),
    CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text]))),
    CONSTRAINT check_credit CHECK (((credit_used <= credit_limit) OR (is_prepaid = true))),
    CONSTRAINT chk_player_wallet_balance_is_two_decimal_places CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))))
);
CREATE TABLE public.settlement_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    club_id uuid NOT NULL,
    period_id uuid,
    invoice_type text NOT NULL,
    from_entity_type text NOT NULL,
    from_entity_id text NOT NULL,
    to_entity_type text NOT NULL,
    to_entity_id text NOT NULL,
    gross_amount numeric(12,2) DEFAULT 0 NOT NULL,
    net_amount numeric(12,2) DEFAULT 0 NOT NULL,
    deductions numeric(12,2) DEFAULT 0 NOT NULL,
    breakdown jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'generated'::text NOT NULL,
    chip_transfer_id uuid,
    chips_transferred boolean DEFAULT false,
    transferred_at timestamp with time zone,
    message_sent boolean DEFAULT false,
    message_sent_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    due_at timestamp with time zone,
    invoice_number text,
    adjusts_invoice_id uuid,
    overdue_at timestamp with time zone,
    reminders_sent integer DEFAULT 0 NOT NULL,
    last_reminder_at timestamp with time zone,
    source_ledger_id uuid,
    source_credit_invoice_id uuid,
    source_credit_payment_id uuid,
    source_credit_reduction_operation_id uuid,
    source_union_presettlement_id uuid,
    CONSTRAINT accounting_invoice_has_one_source CHECK ((((source_union_presettlement_id IS NULL) AND (((source_credit_reduction_operation_id IS NULL) AND (invoice_type <> 'credit_limit_change'::text) AND ((num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) <= 1) AND ((period_id IS NOT NULL) OR (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 1)))) OR ((source_credit_reduction_operation_id IS NOT NULL) AND (invoice_type = 'credit_limit_change'::text) AND (period_id IS NULL) AND (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 0)))) OR ((source_union_presettlement_id IS NOT NULL) AND (invoice_type = 'transaction_receipt'::text) AND (NOT ((breakdown ->> 'category'::text) IS DISTINCT FROM 'union_presettlement'::text)) AND (from_entity_type = 'union'::text) AND (to_entity_type = 'club'::text) AND (status = 'paid'::text) AND (chips_transferred IS FALSE) AND (period_id IS NULL) AND (source_ledger_id IS NULL) AND (source_credit_invoice_id IS NULL) AND (source_credit_payment_id IS NULL) AND (source_credit_reduction_operation_id IS NULL) AND (transferred_at IS NULL) AND (due_at IS NULL) AND (chip_transfer_id IS NULL)))),
    CONSTRAINT settlement_invoices_from_entity_type_check CHECK ((from_entity_type = ANY (ARRAY['union'::text, 'club'::text, 'agent'::text, 'player'::text]))),
    CONSTRAINT settlement_invoices_invoice_type_check CHECK ((invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text, 'cashier_cashout'::text, 'accounting_correction'::text, 'credit_limit_change'::text]))),
    CONSTRAINT settlement_invoices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'generated'::text, 'paid'::text, 'cancelled'::text, 'overdue'::text, 'disputed'::text]))),
    CONSTRAINT settlement_invoices_to_entity_type_check CHECK ((to_entity_type = ANY (ARRAY['club'::text, 'agent'::text, 'player'::text, 'union'::text])))
);
CREATE TABLE public.credit_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    debt_owed numeric DEFAULT 0 NOT NULL,
    amount_paid numeric DEFAULT 0 NOT NULL,
    amount_remaining numeric DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    due_date timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    void_reason text,
    CONSTRAINT credit_invoices_amount_paid_check CHECK ((amount_paid >= (0)::numeric)),
    CONSTRAINT credit_invoices_amount_remaining_check CHECK ((amount_remaining >= (0)::numeric)),
    CONSTRAINT credit_invoices_debt_owed_check CHECK ((debt_owed >= (0)::numeric)),
    CONSTRAINT credit_invoices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'partial'::text, 'paid'::text, 'overdue'::text, 'disputed'::text, 'void'::text])))
);
ALTER TABLE agents ADD PRIMARY KEY(id);ALTER TABLE settlement_invoices ADD PRIMARY KEY(id);ALTER TABLE credit_invoices ADD PRIMARY KEY(id);
GRANT SELECT ON agents,settlement_invoices,credit_invoices TO authenticated,service_role;
ALTER TABLE settlement_invoices ENABLE ROW LEVEL SECURITY;ALTER TABLE credit_invoices ENABLE ROW LEVEL SECURITY;
-- Isolate the additive restriction from unchanged original authorization. This permissive fixture models already-authorized records only.
CREATE POLICY fixture_authorized_settlement ON settlement_invoices FOR SELECT TO authenticated USING(club_id IN('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002'));
CREATE POLICY fixture_authorized_credit ON credit_invoices FOR SELECT TO authenticated USING(agent_id IN('a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002'));
-- Add a restriction to existing permissions; it grants no access and leaves service history intact.
CREATE POLICY launch_current_settlement_invoices ON public.settlement_invoices AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.fn_ca_launch_accounting_accepts(club_id,created_at));
CREATE POLICY launch_current_credit_invoices ON public.credit_invoices AS RESTRICTIVE FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.agents a WHERE a.id=credit_invoices.agent_id AND public.fn_ca_launch_accounting_accepts(a.club_id,credit_invoices.created_at)));

INSERT INTO agents(id,user_id,club_id,role,commission_rate,player_rakeback_rate) SELECT ('a1000000-0000-0000-0000-00000000000'||i)::uuid,('b1000000-0000-0000-0000-00000000000'||i)::uuid,('a0000000-0000-0000-0000-00000000000'||i)::uuid,'agent',0.1,0.1 FROM generate_series(1,3)i;
INSERT INTO settlement_invoices(id,club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,status,created_at)
SELECT ('c1000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,('a0000000-0000-0000-0000-00000000000'||c)::uuid,gen_random_uuid(),'club_to_agent','club','club','agent','agent',st,ts::timestamptz
FROM (VALUES(1,1,'paid','2026-10-12 11:59Z'),(2,1,'pending','2026-10-12 11:59Z'),(3,1,'cancelled','2026-10-12 11:59Z'),(4,1,'pending','2026-10-12 12:00Z'),(5,2,'paid','2026-10-12 11:59Z'),(6,3,'paid','2026-10-12 12:01Z'))v(i,c,st,ts);
INSERT INTO credit_invoices(id,agent_id,period_start,period_end,debt_owed,amount_remaining,status,due_date,created_at)
SELECT ('d1000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,('a1000000-0000-0000-0000-00000000000'||c)::uuid,'2026-10-05','2026-10-12',10,CASE WHEN st='paid' THEN 0 ELSE 10 END,st,'2026-10-19',ts::timestamptz
FROM (VALUES(1,1,'paid','2026-10-12 11:59Z'),(2,1,'pending','2026-10-12 11:59Z'),(3,1,'void','2026-10-12 11:59Z'),(4,1,'pending','2026-10-12 12:00Z'),(5,2,'paid','2026-10-12 11:59Z'),(6,3,'paid','2026-10-12 12:01Z'))v(i,c,st,ts);
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM settlement_invoices)<>5 OR (SELECT count(*) FROM credit_invoices)<>5 THEN RAISE EXCEPTION 'inactive boundary authorization changed'; END IF; END $$;
RESET ROLE;
BEGIN;SAVEPOINT boundary_insert;
INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('club','a0000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','2026-10-12 12:00Z');
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM settlement_invoices)<>2 OR (SELECT count(*) FROM credit_invoices)<>2 OR EXISTS(SELECT 1 FROM settlement_invoices WHERE club_id='a0000000-0000-0000-0000-000000000001' AND created_at<'2026-10-12 12:00Z') THEN RAISE EXCEPTION 'active boundary old invoice still visible'; END IF; END $$;
RESET ROLE;SET ROLE service_role;
DO $$ BEGIN IF (SELECT count(*) FROM settlement_invoices)<>6 OR (SELECT count(*) FROM credit_invoices)<>6 THEN RAISE EXCEPTION 'truthful service history filtered'; END IF; END $$;
RESET ROLE;ROLLBACK TO SAVEPOINT boundary_insert;
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM settlement_invoices)<>5 OR (SELECT count(*) FROM credit_invoices)<>5 THEN RAISE EXCEPTION 'aborted boundary visibility not restored'; END IF; END $$;
RESET ROLE;ROLLBACK;

DO $$ BEGIN IF fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001',NULL) IS NOT NULL OR fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001','-infinity') IS DISTINCT FROM '-infinity'::timestamptz OR fn_ca_launch_accounting_waived('club','a0000000-0000-0000-0000-000000000001','-infinity') THEN RAISE EXCEPTION 'invalid time was converted into launch waiver'; END IF; END $$;
