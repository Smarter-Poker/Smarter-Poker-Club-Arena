-- Owner-authorized scoped October 12 launch reset. Preserve reserves and hand history.
-- Installs original-owner source contracts; performs no reset or floor command.
BEGIN;
SET LOCAL lock_timeout='4s';

-- Component: reset-undo-component/closing-contract.sql
-- Scoped launch closing testimony. This component DOES NOT execute a reset.
-- Parent integration must reserve the migration version, qualify the complete
-- capture/reset/undo transaction, then install once through the protected route.


DO $qualified_originals$
DECLARE r record; observed text; expected jsonb := '{"fn_invoice_accounting_ledger_transfer(uuid)":"1be0fb4e2dfa9f0ca31613a8b5c6c14b","fn_satellite_transfer_ledger_is_immutable()":"5de9ef6b567d2b40f01060ce583350f0","fn_terminal_tournament_evidence_is_immutable()":"5eb12239ece45d08eb32dbaa9e3028dd","fn_cancelled_tournament_evidence_is_immutable()":"55061034adb7416d401622572397c7d2","fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)":"2bce91eca31c328175d430f78273ab76","fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)":"7aaf8013079ea67adfc18a26691bf8a6","fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])":"0aa811df7bbdb1716dec7f6793c1f42e"}'::jsonb;
BEGIN
 FOR r IN SELECT key,value FROM jsonb_each_text(expected) LOOP
  SELECT md5(pg_get_functiondef(('public.'||r.key)::regprocedure)) INTO observed;
  IF observed IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'LAUNCH_QUALIFIED_ORIGINAL_CHANGED: %',r.key; END IF;
 END LOOP;
END $qualified_originals$;
CREATE TABLE public.ca_launch_reset_operations (
 operation_id uuid PRIMARY KEY,
 performed_by uuid NOT NULL,
 scoped_club_ids uuid[] NOT NULL,
 captured_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('captured','executed','undone')),
 scoped_recovery_certificate_sha256 text NOT NULL CHECK(scoped_recovery_certificate_sha256 ~ '^[0-9a-f]{64}$'),
 closing_sha256 text,
 result jsonb,
 executed_at timestamptz,
 undone_at timestamptz
);
CREATE TABLE public.ca_launch_reset_rows (
 operation_id uuid NOT NULL,
 relation_name text NOT NULL,
 row_key jsonb NOT NULL,
 raw_row jsonb NOT NULL,
 PRIMARY KEY(operation_id,relation_name,row_key)
);
CREATE TABLE public.ca_launch_reset_positions (
 operation_id uuid NOT NULL,
 relation_name text NOT NULL,
 row_key jsonb NOT NULL,
 column_name text NOT NULL,
 account_type text NOT NULL,
 entity_id uuid,
 club_id uuid,
 balance numeric,
 counted_in_supply boolean NOT NULL,
 closing_leg_id uuid UNIQUE,
 PRIMARY KEY(operation_id,relation_name,row_key,column_name)
);
ALTER TABLE public.ca_launch_reset_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_launch_reset_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_launch_reset_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_reset_operations,public.ca_launch_reset_rows,public.ca_launch_reset_positions FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.ca_launch_reset_positions IS 'Immutable seven-year scoped closing testimony. NULL and subcent legacy values are retained exactly, never rounded into an opening or silently rewritten. Derived aliases are explicitly outside supply.';
CREATE FUNCTION public.fn_ca_launch_reset_testimony_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'LAUNCH_CLOSING_TESTIMONY_IS_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_launch_rows BEFORE UPDATE OR DELETE ON public.ca_launch_reset_rows FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE TRIGGER immutable_launch_positions BEFORE UPDATE OR DELETE ON public.ca_launch_reset_positions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
-- Zero is legal only for an observational self-leg carrying a closing position.
-- Every monetary move retains its strictly positive amount requirement.
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_amount_check;
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_positive_amount;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_positive_amount CHECK(
 amount>0 OR (amount=0 AND category='adjustment'
 AND metadata->>'entry_kind' IS NOT DISTINCT FROM 'launch_closing_position'
 AND from_type=to_type AND from_entity_id IS NOT DISTINCT FROM to_entity_id
 AND from_label IS NOT DISTINCT FROM to_label
 AND pre_from_balance IS NOT DISTINCT FROM post_from_balance
 AND pre_to_balance IS NOT DISTINCT FROM post_to_balance
 AND pre_from_balance IS NOT DISTINCT FROM pre_to_balance)) NOT VALID;
CREATE FUNCTION public.fn_ca_launch_closing_leg_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.ca_launch_reset_positions%ROWTYPE;
BEGIN
 IF NEW.metadata->>'entry_kind' IS DISTINCT FROM 'launch_closing_position' THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.ca_launch_reset_positions WHERE closing_leg_id=NEW.id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o
 WHERE o.operation_id=p.operation_id AND o.state='captured')
 OR NEW.idempotency_key IS DISTINCT FROM 'launch-closing:'||NEW.id::text
 OR NEW.category IS DISTINCT FROM 'adjustment'
 OR NEW.from_type IS DISTINCT FROM p.account_type OR NEW.to_type IS DISTINCT FROM p.account_type
 OR NEW.from_entity_id IS DISTINCT FROM p.entity_id OR NEW.to_entity_id IS DISTINCT FROM p.entity_id
 OR NEW.from_label IS DISTINCT FROM p.relation_name||'.'||p.column_name
 OR NEW.to_label IS DISTINCT FROM NEW.from_label
 OR NEW.amount IS DISTINCT FROM 0::numeric
 OR NEW.pre_from_balance IS DISTINCT FROM round(p.balance,2)
 OR NEW.post_from_balance IS DISTINCT FROM round(p.balance,2)
 OR NEW.pre_to_balance IS DISTINCT FROM round(p.balance,2)
 OR NEW.post_to_balance IS DISTINCT FROM round(p.balance,2)
 OR NEW.metadata->'exact_balance' IS DISTINCT FROM coalesce(to_jsonb(p.balance),'null'::jsonb)
 OR NEW.metadata->>'operation_id' IS DISTINCT FROM p.operation_id::text
 THEN RAISE EXCEPTION 'LAUNCH_CLOSING_LEG_HAS_NO_EXACT_POSITION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES('chip_ledger','aaa_launch_closing_leg','Scoped immutable launch closing-position proof; zero observational self-leg only, ordinary positive money guard retained');
CREATE TRIGGER aaa_launch_closing_leg BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_closing_leg_guard();
CREATE FUNCTION public.fn_ca_launch_reset_assert_drained() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope constant uuid[]:=ARRAY['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']::uuid[];
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR (coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN('postgres','supabase_admin')) THEN RAISE EXCEPTION 'LAUNCH_RESET_OPERATOR_ONLY' USING ERRCODE='42501'; END IF;
 IF public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_RESET_REQUIRES_FREEZE' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND (s.club_id=ANY(scope) OR t.club_id=ANY(scope))) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_LIVE_SEATS' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits h JOIN public.tables t ON t.id=h.table_id WHERE t.club_id=ANY(scope) AND h.post_commit_payload IS NOT NULL AND h.post_commit_completed_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_UNFINISHED_HAND' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_pending_addons a JOIN public.tables t ON t.id=a.table_id WHERE t.club_id=ANY(scope) AND a.resolved_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_PENDING_ADDON' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments WHERE club_id=ANY(scope) AND upper(status) NOT IN('COMPLETED','CANCELLED')) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_OPEN_TOURNAMENT' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.club_members WHERE club_id=ANY(scope) AND (coalesce(held_chips,0)<>0 OR coalesce(locked_chips,0)<>0)) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_HELD_PLAYER_CHIPS' USING ERRCODE='55006'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_assert_drained() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_launch_closing_leg_guard(),public.fn_ca_launch_reset_testimony_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_reset_capture(p_operation uuid,p_scoped_recovery_certificate_sha256 text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='4s' AS $$
DECLARE
 scope constant uuid[]:=ARRAY['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']::uuid[];
 source record; rowdata jsonb; rowkey jsonb; colspec record; pos public.ca_launch_reset_positions%ROWTYPE;
 v_id uuid; v_club uuid; v_entity uuid; v_count bigint; v_hash text; v_cut timestamptz;
BEGIN
 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role IN('admin','god') AND status IS DISTINCT FROM 'deleted') THEN RAISE EXCEPTION 'LAUNCH_RESET_REAL_STAFF_ACTOR_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_operation IS NULL OR p_scoped_recovery_certificate_sha256 !~ '^[0-9a-f]{64}$' OR p_scoped_recovery_certificate_sha256 IS NULL THEN RAISE EXCEPTION 'LAUNCH_RESET_REQUIRES_RECOVERY_CERTIFICATE'; END IF;
 -- This records independently verified recovery of every touched scoped record.
 -- Passing a string to SQL does not qualify recovery or certify the full database.
 IF NOT pg_try_advisory_xact_lock(530090,1) THEN RAISE EXCEPTION 'LAUNCH_RESET_ENTRY_GATE_BUSY' USING ERRCODE='55P03'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'LAUNCH_RESET_OPERATION_BUSY' USING ERRCODE='55P03'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_operations WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'LAUNCH_RESET_CAPTURE_ALREADY_EXISTS'; END IF;
 IF (SELECT count(*) FROM public.clubs WHERE id=ANY(scope) AND asset='chips')<>4 THEN RAISE EXCEPTION 'LAUNCH_RESET_SCOPE_CHANGED'; END IF;
 v_cut:=clock_timestamp();
 INSERT INTO public.ca_launch_reset_operations(operation_id,performed_by,scoped_club_ids,captured_at,state,scoped_recovery_certificate_sha256)
 VALUES(p_operation,p_actor,scope,v_cut,'captured',p_scoped_recovery_certificate_sha256);
 FOR source IN SELECT * FROM (VALUES
 ('clubs','SELECT to_jsonb(x) FROM public.clubs x WHERE id=ANY($1) ORDER BY id FOR UPDATE','id', 'chip_treasury:club_treasury:true,chip_pool:club_treasury:true,promo_balance:promo_wallet:true,insurance_balance:insurance_bank:true'),
 ('club_members','SELECT to_jsonb(x)||jsonb_build_object(''launch_is_horse'',p.is_horse,''launch_profile_status'',p.status) FROM public.club_members x JOIN public.profiles p ON p.id=x.user_id WHERE x.club_id=ANY($1) ORDER BY x.club_id,x.user_id FOR UPDATE OF x','club_id,user_id','chip_balance:player_wallet:true,promo_balance:promo_wallet:true,held_chips:escrow:false,locked_chips:escrow:false,credit_used:credit_receivable:false'),
 ('agents','SELECT to_jsonb(x) FROM public.agents x WHERE club_id=ANY($1) ORDER BY club_id,id FOR UPDATE','id','agent_wallet_balance:agent_wallet:true,promo_wallet_balance:promo_wallet:true,player_wallet_balance:player_wallet:false,business_balance:agent_wallet:false,player_balance:player_wallet:false,promo_balance:promo_wallet:false,credit_used:credit_receivable:false'),
 ('club_wallets','SELECT to_jsonb(x) FROM public.club_wallets x WHERE club_id=ANY($1) ORDER BY club_id,id FOR UPDATE','id','chip_balance:club_wallet:true,insurance_balance:insurance_bank:false'),
 ('union_wallets','SELECT to_jsonb(x) FROM public.union_wallets x WHERE union_id=ANY($1) ORDER BY union_id,id FOR UPDATE','id','chip_balance:union_bank:true,rake_wallet:union_wallet:true,bbj_wallet:union_wallet:true,promo_wallet:union_wallet:true,insurance_wallet:union_wallet:true,spin_reserve_wallet:union_wallet:true'),
 ('bbj_pools','SELECT to_jsonb(x) FROM public.bbj_pools x WHERE club_id=ANY($1) OR union_id=ANY($1) ORDER BY id FOR UPDATE','id','main_balance:bbj_pool:true,backup_balance:bbj_pool:true,promo_balance:bbj_pool:true,pool_amount:bbj_pool:false,alloc_cum_amount:bbj_pool:false'),
 ('spin_bonus_pools','SELECT to_jsonb(x) FROM public.spin_bonus_pools x WHERE club_id=ANY($1) ORDER BY id FOR UPDATE','id','balance:spin_reserve:true'),
 ('club_opening_setups','SELECT to_jsonb(x) FROM public.club_opening_setups x WHERE club_id=ANY($1) ORDER BY club_id FOR UPDATE','club_id','leaderboard_seed_remaining:opening_setup:true'),
 ('chip_escrow','SELECT to_jsonb(x) FROM public.chip_escrow x WHERE club_id=ANY($1) AND released_at IS NULL ORDER BY id FOR UPDATE','id','amount:escrow:true'),
 ('tournament_tickets','SELECT to_jsonb(x) FROM public.tournament_tickets x WHERE club_id=ANY($1) AND status=''issued'' ORDER BY id FOR UPDATE','id','value:escrow:true'),
 ('tournament_escrow','SELECT to_jsonb(x)||jsonb_build_object(''club_id'',t.club_id) FROM public.tournament_escrow x JOIN public.tournaments t ON t.id=x.tournament_id WHERE t.club_id=ANY($1) AND (x.prize_balance<>0 OR x.bounty_balance<>0 OR x.fee_balance<>0 OR t.status NOT IN(''COMPLETED'',''CANCELLED'')) ORDER BY x.tournament_id FOR UPDATE OF x','tournament_id','prize_balance:prize_liability:true,bounty_balance:bounty_liability:true,fee_balance:escrow:true')
 ) q(relation_name,query,key_columns,columns) LOOP
  FOR rowdata IN EXECUTE source.query USING scope LOOP
   SELECT jsonb_object_agg(k,rowdata->k) INTO rowkey FROM unnest(string_to_array(source.key_columns,',')) k;
   INSERT INTO public.ca_launch_reset_rows VALUES(p_operation,source.relation_name,rowkey,rowdata);
   v_club:=CASE WHEN source.relation_name='clubs' THEN (rowdata->>'id')::uuid ELSE coalesce(nullif(rowdata->>'club_id','')::uuid,nullif(rowdata->>'union_id','')::uuid) END;
   v_entity:=CASE WHEN source.relation_name IN('club_members','agents') THEN (rowdata->>'user_id')::uuid
    WHEN source.relation_name='union_wallets' THEN (rowdata->>'union_id')::uuid
    ELSE coalesce(nullif(rowdata->>'id','')::uuid,nullif(rowdata->>'tournament_id','')::uuid,v_club) END;
   FOR colspec IN SELECT split_part(c,':',1) AS col,split_part(c,':',2) AS account,(split_part(c,':',3))::boolean AS counted FROM unnest(string_to_array(source.columns,',')) c LOOP
    v_id:=CASE WHEN colspec.counted THEN gen_random_uuid() END;
    INSERT INTO public.ca_launch_reset_positions VALUES(p_operation,source.relation_name,rowkey,colspec.col,colspec.account,v_entity,v_club,(rowdata->>colspec.col)::numeric,colspec.counted,v_id) RETURNING * INTO pos;
    IF NOT pos.counted_in_supply THEN CONTINUE; END IF;
    INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,club_id,description,idempotency_key,correlation_id,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
    VALUES(v_id,p_actor,pos.account_type,pos.entity_id,source.relation_name||'.'||pos.column_name,pos.account_type,pos.entity_id,source.relation_name||'.'||pos.column_name,0,'adjustment',pos.club_id,'Non-Monetary Launch Closing Position','launch-closing:'||v_id::text,p_operation,round(pos.balance,2),round(pos.balance,2),round(pos.balance,2),round(pos.balance,2),jsonb_build_object('entry_kind','launch_closing_position','operation_id',p_operation,'exact_balance',pos.balance,'counted_in_supply',pos.counted_in_supply));
   END LOOP;
  END LOOP;
 END LOOP;
 SELECT count(*) INTO v_count FROM public.ca_launch_reset_positions WHERE operation_id=p_operation;
 IF v_count=0 THEN RAISE EXCEPTION 'LAUNCH_RESET_CLOSING_IS_EMPTY'; END IF;
 SELECT encode(extensions.digest(string_agg(relation_name||':'||row_key::text||':'||raw_row::text,E'\n' ORDER BY relation_name,row_key::text),'sha256'),'hex') INTO v_hash FROM public.ca_launch_reset_rows WHERE operation_id=p_operation;
 UPDATE public.ca_launch_reset_operations SET closing_sha256=v_hash WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operation_id',p_operation,'state','captured','cutoff_at',v_cut,'positions',v_count,'closing_sha256',v_hash,'balance_reset',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_capture(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_reset_capture(uuid,text,uuid) TO service_role;
-- Closing testimony is observational, not a monetary movement. Keep the
-- chain over all entries, but exclude these guarded self-legs from cash-flow
-- replay so unsupported legacy accounts cannot manufacture unkeyable flows.
DO $reader$
DECLARE signature text; old_def text; new_def text; needle text:=E'FROM public.chip_ledger l\n     WHERE';
BEGIN
 FOREACH signature IN ARRAY ARRAY[
 'public.fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)',
 'public.fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)',
 'public.fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])'] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO old_def;
  IF (length(old_def)-length(replace(old_def,needle,'')))/length(needle)<>2 THEN RAISE EXCEPTION 'LAUNCH_CLOSING_READER_SHAPE_CHANGED: %',signature; END IF;
  new_def:=replace(old_def,needle,needle||E' l.metadata->>''entry_kind'' IS DISTINCT FROM ''launch_closing_position'' AND');
  EXECUTE new_def;
 END LOOP;
END $reader$;
-- The original invoice owner excludes exact observational closings, including
-- later explicit invoice rebuilds, not merely the insert trigger.
DO $invoice$
DECLARE old_def text; new_def text; needle text:=E'SELECT * INTO leg FROM public.chip_ledger WHERE id=p_ledger_id;';
BEGIN
 SELECT pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure) INTO old_def;
 IF strpos(old_def,needle)=0 THEN RAISE EXCEPTION 'LAUNCH_CLOSING_INVOICE_READER_SHAPE_CHANGED'; END IF;
 new_def:=replace(old_def,needle,needle||E'\n IF leg.metadata->>''entry_kind''=''launch_closing_position'' THEN RETURN NULL; END IF;');
 EXECUTE new_def;
END $invoice$;
-- Terminal-event immutable testimony remains immutable. Observational closing
-- INSERTs are validated first by aaa_launch_closing_leg and move no funds.
DO $terminal$
DECLARE signature text; old_def text; new_def text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.fn_terminal_tournament_evidence_is_immutable()','public.fn_cancelled_tournament_evidence_is_immutable()','public.fn_satellite_transfer_ledger_is_immutable()'] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO old_def;
  IF strpos(old_def,E'BEGIN\n')=0 THEN RAISE EXCEPTION 'LAUNCH_CLOSING_TERMINAL_GUARD_SHAPE_CHANGED: %',signature; END IF;
  new_def:=overlay(old_def placing E'BEGIN\n IF TG_OP=''INSERT'' AND TG_TABLE_NAME=''chip_ledger'' AND NEW.metadata->>''entry_kind''=''launch_closing_position'' THEN RETURN NEW; END IF;\n' from strpos(old_def,E'BEGIN\n') for length(E'BEGIN\n'));
  EXECUTE new_def;
 END LOOP;
END $terminal$;

-- Component: accounting-component/boundary.sql
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
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid),public.fn_ca_launch_accounting_start(text,uuid,timestamptz),public.fn_ca_launch_accounting_accepts(uuid,timestamptz),public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) FROM PUBLIC,anon;
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

-- Component: accounting-component/treasury-selftest-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_treasury_selftest' AND md5(p.prosrc)='e612b5e46a65984c2f930da4bbee4cd7')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_treasury_selftest'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_treasury_selftest() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_u record; v_breaches jsonb := '[]'::jsonb;
  v_credits numeric; v_debits numeric; v_expected numeric; v_drift numeric;
  v_dups integer; v_retired_bal numeric; v_lapsed_unclosed boolean;
  v_tolerance numeric := 150; v_cons jsonb; v_lag jsonb; b jsonb;
BEGIN
  FOR v_u IN SELECT uw.union_id, uw.chip_balance, uw.rake_wallet, uw.promo_wallet FROM union_wallets uw
  LOOP
    IF v_u.chip_balance < 0 OR v_u.rake_wallet < 0 OR v_u.promo_wallet < 0 THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'non_negative_wallets', 'chip', v_u.chip_balance,
        'rake', v_u.rake_wallet, 'promo', v_u.promo_wallet);
    END IF;

    -- CHECKPOINTED 2026-08-20: was an unbounded SUM over every rake_wallet
    -- row ever written (609k rows, +69k/day, no index) which had crossed
    -- the statement timeout and was aborting this whole sentinel every
    -- cycle. The full recompute now runs at most once per 24h and alerts
    -- if the incremental total ever disagrees with it.
    IF NOT EXISTS (SELECT 1 FROM union_rake_ledger_checkpoint c
                    WHERE c.union_id = v_u.union_id
                      AND c.last_verified_at > now() - interval '24 hours') THEN
      PERFORM fn_union_rake_ledger_checkpoint_verify(v_u.union_id);
    END IF;

    SELECT g.total_credits, g.total_debits
      INTO v_credits, v_debits
      FROM fn_union_rake_ledger_totals(v_u.union_id) g;

    v_expected := v_credits - v_debits;
    v_drift := round(v_u.rake_wallet - v_expected, 2);
    IF abs(v_drift) > v_tolerance THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'rake_wallet_ledger_reconciliation',
        'wallet', v_u.rake_wallet, 'ledger_expected', v_expected, 'drift', v_drift);
    END IF;

    SELECT (MAX(period_end) IS NOT NULL AND MAX(period_end) < public.fn_union_week_start(now()))
      INTO v_lapsed_unclosed FROM union_rakeback_log WHERE union_id = v_u.union_id;
    IF COALESCE(v_lapsed_unclosed, false)
       AND NOT public.fn_ca_launch_accounting_waived('union', v_u.union_id, public.fn_union_week_start(now()))
       /* THE JUST-CLOSED WEEK IS NOT LAPSED BEFORE ITS CLOSE IS OWED
          (2026-10-05). When the only week outstanding is the one that ended at
          this week's boundary, its close may not have run yet: before its run
          time (fn_union_accounting_run_at), while accounting_close_gates holds
          its first attempt for a quiet hour, or while it is running. An older
          week left open, or this week once its close is owed and has not
          happened, still breaches. Migration 20261005113359. */
       AND NOT ((SELECT MAX(period_end) FROM union_rakeback_log WHERE union_id = v_u.union_id)
                  >= public.fn_union_week_start(now()) - interval '7 days'
                AND (now() < public.fn_union_accounting_run_at(public.fn_union_week_start(now()))
                     OR EXISTS (SELECT 1 FROM public.accounting_close_gates g
                                 WHERE g.scope_kind = 'union' AND g.scope_id = v_u.union_id
                                   AND g.period_end = public.fn_union_week_start(now())
                                   AND g.gate_until > now()
                                   AND NOT EXISTS (SELECT 1 FROM public.union_accounting_runs r
                                                    WHERE r.scope_kind = 'union' AND r.scope_id = v_u.union_id
                                                      AND r.period_start = g.period_start
                                                      AND r.period_end = g.period_end))
                     OR EXISTS (SELECT 1 FROM public.union_accounting_runs q
                                 WHERE q.scope_kind = 'union' AND q.scope_id = v_u.union_id
                                   AND q.period_end = public.fn_union_week_start(now())
                                   AND q.status = 'running')))
       AND EXISTS (SELECT 1 FROM union_wallet_transactions
                    WHERE union_id = v_u.union_id AND wallet='rake_wallet'
                      AND tx_type='rake' AND direction='credit'
                      AND created_at < public.fn_union_week_start(now())
                      AND created_at >= public.fn_ca_launch_accounting_start('union', v_u.union_id,
                        (SELECT MAX(period_end) FROM union_rakeback_log WHERE union_id = v_u.union_id))) THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id, 'check', 'lapsed_week_unclosed');
    END IF;
  END LOOP;

  -- BOUNDED 2026-08-20: was an unbounded GROUP BY over all of
  -- bbj_contributions, which timed out and killed the whole sentinel.
  SELECT COUNT(*) INTO v_dups FROM (
    SELECT 1 FROM bbj_contributions
     WHERE hand_id IS NOT NULL
       AND created_at > now() - interval '7 days'
     GROUP BY pool_id, hand_id HAVING COUNT(*) > 1) d;
  IF v_dups > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'bbj_duplicate_hand_contributions', 'groups', v_dups);
  END IF;

  SELECT COALESCE(SUM(main_balance + backup_balance + promo_balance), 0) INTO v_retired_bal
    FROM bbj_pools WHERE status = 'retired';
  IF v_retired_bal <> 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'retired_pools_hold_money', 'total', v_retired_bal);
  END IF;

  IF EXISTS (SELECT 1 FROM bbj_pools WHERE main_balance < 0 OR backup_balance < 0 OR promo_balance < 0) THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'negative_bbj_pool_balance');
  END IF;

  -- 2026-08-20: fn_bbj_conservation_check is STABLE and therefore cannot
  -- maintain its own checkpoint. This VOLATILE caller does it: fold the
  -- tail forward every cycle, and recompute against truth once per 24h.
  PERFORM fn_bbj_contributions_total_advance();
  IF NOT EXISTS (SELECT 1 FROM money_flow_checkpoint c
                  WHERE c.metric_key = 'bbj_contributions_inflow'
                    AND c.last_verified_at > now() - interval '24 hours') THEN
    PERFORM fn_bbj_contributions_total_verify();
  END IF;

  v_cons := fn_bbj_conservation_check();
  IF (v_cons->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'bbj_pool_conservation_drift',
      'unexplained_since_opening', v_cons->'epoch'->>'unexplained_since_opening',
      'tolerance', v_cons->>'tolerance',
      'epoch_opened_at', v_cons->'epoch'->>'opened_at',
      'lifetime_healthy', v_cons->>'lifetime_healthy',
      'moved_since_resolution', v_cons->'lifetime'->>'moved_since_resolution',
      'paid_without_a_payout_row_since', v_cons->'lifetime'->>'paid_without_a_payout_row_since',
      'context_lifetime_drift_from_baseline', v_cons->>'drift_from_baseline');
  END IF;

  v_lag := fn_settler_lag_check();
  IF (v_lag->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'rakeback_settler_lagging',
      'lag_hours', v_lag->>'lag_hours', 'backlog_rows', v_lag->>'backlog_rows');
  END IF;

  FOR b IN SELECT * FROM jsonb_array_elements(v_breaches)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM financial_alerts
                    WHERE source = 'fn_union_treasury_selftest' AND resolved IS NOT TRUE
                      AND context->>'check' = b->>'check'
                      AND COALESCE(context->>'union_id','') = COALESCE(b->>'union_id','')) THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_union_treasury_selftest',
              'Union treasury conservation breach: ' || (b->>'check'), b);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'healthy', jsonb_array_length(v_breaches) = 0,
    'breaches', v_breaches, 'bbj_conservation', v_cons, 'settler_lag', v_lag);
END
$$;

-- Component: accounting-component/accounting-owner-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_sync_profile_total_hands' AND md5(p.prosrc)='854fb2b0de27d71e76146fa6dbf7213d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_sync_profile_total_hands'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_sync_profile_total_hands() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF public.fn_ca_launch_accounting_actor(COALESCE(NEW.club_id,OLD.club_id)) THEN RETURN COALESCE(NEW,OLD); END IF;
  IF v_user IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  /* A WRITE THAT LEAVES hands_played WHERE IT WAS DOES NOT TOUCH THE PROFILE
     (2026-10-01). The trigger fires for every UPDATE that names the column,
     and a tournament's rake recognition names it with +0 for every entrant
     (apply_rakeback_player_stats(..., 0, ...)): the sum below cannot move,
     but its UPDATE locked each entrant's profile row, in club order, while
     the horse claims hold profile rows in claim order - and the two
     deadlocked. The same player and the same count leave the same sum. */
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN
    RETURN NEW;
  END IF;

  /* Recomputed from the table rather than incremented. An increment has to be
     right on every path - insert, update, delete, and the upsert the
     achievement engine uses - and being wrong once is permanent. A SUM over a
     handful of club rows for one player is cheap and cannot drift. */
  UPDATE public.profiles p
     SET total_hands_played = COALESCE((
           SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id = v_user
         ), 0) + COALESCE((SELECT CASE WHEN o.state='executed' THEN b.hand_offset ELSE b.hand_offset-b.restored_scope_hands END FROM public.ca_launch_profile_hand_baselines b
            JOIN public.ca_launch_reset_operations o ON o.operation_id=b.operation_id
            WHERE b.user_id=v_user AND o.state IN('executed','undone') ORDER BY b.captured_at DESC,b.operation_id DESC LIMIT 1),0)
   WHERE p.id = v_user;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_accounting_document_immutable' AND md5(p.prosrc)='dc559b5c8d2008876eefa9ec85bda086')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_accounting_document_immutable'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
   IF TG_OP='UPDATE' AND public.fn_ca_launch_accounting_invoice_transition(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
   IF (OLD.source_union_presettlement_id IS NOT NULL OR
       (TG_OP='UPDATE' AND NEW.source_union_presettlement_id IS NOT NULL)) AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['message_sent','message_sent_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['message_sent','message_sent_at']))
   THEN RAISE EXCEPTION 'presettlement_receipt_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='credit_limit_change' AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['message_sent','message_sent_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['message_sent','message_sent_at']))
   THEN RAISE EXCEPTION 'credit_change_document_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='accounting_correction' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at,NEW.due_at,NEW.chip_transfer_id,NEW.adjusts_invoice_id,
          NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.overdue_at,NEW.reminders_sent,NEW.last_reminder_at)
      IS DISTINCT FROM ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at,OLD.due_at,OLD.chip_transfer_id,OLD.adjusts_invoice_id,
          OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.overdue_at,OLD.reminders_sent,OLD.last_reminder_at))
   THEN RAISE EXCEPTION 'correction_document_payment_claim_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='cashier_cashout' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at) IS DISTINCT FROM
      ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at))
   THEN RAISE EXCEPTION 'cashier_document_phase_is_immutable' USING ERRCODE='23514';END IF;
   issued:=COALESCE(OLD.message_sent,false) OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
     ROW(NEW.club_id,NEW.period_id,NEW.invoice_type,NEW.invoice_number,NEW.from_entity_type,NEW.from_entity_id,
         NEW.to_entity_type,NEW.to_entity_id,NEW.gross_amount,NEW.net_amount,NEW.deductions,NEW.breakdown,
         NEW.due_at,NEW.notes,NEW.source_ledger_id,NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.club_id,OLD.period_id,OLD.invoice_type,OLD.invoice_number,OLD.from_entity_type,OLD.from_entity_id,
         OLD.to_entity_type,OLD.to_entity_id,OLD.gross_amount,OLD.net_amount,OLD.deductions,OLD.breakdown,
         OLD.due_at,OLD.notes,OLD.source_ledger_id,OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.created_at)
     OR NEW.message_sent IS DISTINCT FROM true)
   THEN RAISE EXCEPTION 'issued_accounting_invoice_is_immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='social_messages' THEN
   issued:=EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE message_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['read_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','updated_at']))
   THEN RAISE EXCEPTION 'issued_accounting_message_is_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_settlement_floor_refuses_owed_agent_commission' AND md5(p.prosrc)='224da04d13045ed39c86f19492c175b2')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_settlement_floor_refuses_owed_agent_commission'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_from   timestamptz;
  v_to     timestamptz := NEW.earliest_period_start;
  v_clubs  uuid[];
  v_cursor timestamptz;
  p record; s record; v_owed record; v_stranded boolean := false;
BEGIN
  v_from := CASE WHEN TG_OP = 'UPDATE' THEN OLD.earliest_period_start ELSE '-infinity'::timestamptz END;
  IF v_to IS NULL OR v_to <= v_from THEN
    RETURN NEW;  -- a floor that does not move up skips nothing
  END IF;
  IF TG_TABLE_NAME = 'union_settlement_floor' THEN
    v_clubs := ARRAY(SELECT c.id FROM public.clubs c WHERE c.union_id = NEW.union_id OR c.id = NEW.union_id ORDER BY 1);
  ELSE
    v_clubs := ARRAY[NEW.club_id];
  END IF;

  -- Per (club, agent) with unsettled commission (the rollup keeps one row for
  -- every such pair): walk its settlement periods across the skipped range and
  -- probe each uncovered gap for an unsettled row, by index range. Measured on
  -- production 2026-10-03: 30 ms for the union's week of 09-21 (all covered),
  -- 1 ms to find the first stranded row below 09-28 before 20261003092151.
  <<pairs>>
  FOR p IN SELECT r.club_id, r.user_id FROM public.agent_commission_unsettled_rollup r
            WHERE r.club_id = ANY(v_clubs) ORDER BY 1, 2 LOOP
    v_cursor := v_from;
    FOR s IN SELECT x.period_start, x.period_end FROM public.agent_commission_settlements x
              WHERE x.club_id = p.club_id AND x.user_id = p.user_id
                AND x.period_end > v_from AND x.period_start < v_to
              ORDER BY x.period_start LOOP
      IF s.period_start > v_cursor THEN
        SELECT a.club_id, a.user_id, a.created_at, a.amount INTO v_owed FROM public.agent_commissions a
         WHERE a.club_id = p.club_id AND a.user_id = p.user_id AND a.settled_at IS NULL
           AND public.fn_ca_launch_accounting_accepts(a.club_id,a.created_at)
           AND a.created_at >= v_cursor AND a.created_at < s.period_start
         ORDER BY a.created_at LIMIT 1;
        v_stranded := FOUND;
        EXIT pairs WHEN v_stranded;
      END IF;
      v_cursor := greatest(v_cursor, s.period_end);
    END LOOP;
    IF v_cursor < v_to THEN
      SELECT a.club_id, a.user_id, a.created_at, a.amount INTO v_owed FROM public.agent_commissions a
       WHERE a.club_id = p.club_id AND a.user_id = p.user_id AND a.settled_at IS NULL
         AND public.fn_ca_launch_accounting_accepts(a.club_id,a.created_at)
           AND a.created_at >= v_cursor AND a.created_at < v_to
       ORDER BY a.created_at LIMIT 1;
      v_stranded := FOUND;
      EXIT pairs WHEN v_stranded;
    END IF;
  END LOOP;

  IF v_stranded THEN
    RAISE EXCEPTION 'settlement_floor_would_strand_agent_commission'
      USING ERRCODE = '23514',
            DETAIL = format('Moving the %s floor from %s to %s skips recorded agent commission that is unsettled and covered by no settlement period, e.g. club %s agent %s row of %s (%s). Below the floor no path can ever pay it.',
                            TG_TABLE_NAME, v_from, v_to, v_owed.club_id, v_owed.user_id, v_owed.created_at, v_owed.amount),
            HINT = 'Pay or settle the skipped weeks first (agent_commission_settlements periods, as 20261003092151 did), then move the floor.';
  END IF;
  RETURN NEW;
END
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_agent_unsettled_commission' AND md5(p.prosrc)='65099653461a48858b024c1a022409f2')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_agent_unsettled_commission'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(p_club_id uuid, p_user_id uuid) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission needs a club and a user'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.fn_agent_may_read_commission(p_club_id, p_user_id) THEN
    -- Not a zero. A zero is indistinguishable from "owes nothing", and this
    -- caller is not entitled to know which of the two it is.
    RAISE EXCEPTION 'not authorized to read that member''s commission'
      USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(SUM(ac.amount), 0)::numeric
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.user_id = p_user_id
       AND ac.settled_at IS NULL
       AND public.fn_ca_launch_accounting_accepts(ac.club_id,ac.created_at)
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end));
END
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_accrue_cash_hand_commissions' AND md5(p.prosrc)='566913ea173a77c7bc50c0a10ad9411a')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_accrue_cash_hand_commissions'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_accrue_cash_hand_commissions(p_hand_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE source public.rake_records%ROWTYPE; batch public.accounting_cash_accrual_batches%ROWTYPE;
 fingerprint text; plan jsonb; player jsonb; source_id uuid; count_rows int:=0; cutoff timestamptz;scope record;week_start timestamptz;week_end timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
 SELECT * INTO source FROM public.rake_records WHERE hand_id=p_hand_id FOR SHARE;
 IF NOT FOUND OR COALESCE(source.is_tournament,false) OR source.tournament_id IS NOT NULL OR source.rake_amount<=0
 THEN RAISE EXCEPTION 'cash_rake_source_required' USING ERRCODE='23514'; END IF;
 SELECT md5(jsonb_build_object('record',source.id,'hand',source.hand_id,'rake',source.rake_amount,'earned_at',source.created_at,
   'shares',COALESCE(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb))::text)
 INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=source.id;
 SELECT * INTO batch FROM public.accounting_cash_accrual_batches WHERE rake_record_id=source.id;
 IF FOUND THEN
  IF batch.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'cash_accrual_source_changed_after_recording' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('recorded',true,'duplicate',true,'status',batch.status,'source_version',2);
 END IF;
 IF NOT public.fn_ca_launch_accounting_accepts(source.club_id,source.created_at) THEN
  RETURN jsonb_build_object('status','waived','recorded',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutoff IS NULL THEN RAISE EXCEPTION 'cash_accrual_cutover_missing' USING ERRCODE='23514'; END IF;
 -- Legacy rows remain untouched. Recording this gap is not a commission
 -- credit or a successful weekly close. The coordinator must reject it.
 IF source.created_at<cutoff THEN
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status)
   VALUES(source.id,source.hand_id,source.created_at,fingerprint,'legacy_unverified');
  RETURN jsonb_build_object('recorded',true,'status','legacy_unverified','requires_reconciliation',true,'source_version',2);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.source_id=source.hand_id AND ac.source_type IN('rake','rake_settlement'))
 THEN RAISE EXCEPTION 'cash_accrual_legacy_writer_after_cutover' USING ERRCODE='23514'; END IF;
 plan:=public.fn_accounting_cash_commission_plan(source.id);
 week_start:=public.fn_union_week_start(source.created_at);week_end:=public.fn_union_week_start(week_start+interval '8 days');
 FOR scope IN SELECT DISTINCT CASE WHEN p->>'coordinator_union_id' IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p->>'coordinator_union_id',p->>'club_id')||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text AS lock_key
   FROM jsonb_array_elements(plan->'players')p ORDER BY lock_key LOOP
  -- Shared: an accrual excludes the weekly close, never a sibling accrual.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(scope.lock_key,0));
 END LOOP;
 -- An empty or zero-own-commission completed week still closes the source set.
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r CROSS JOIN LATERAL jsonb_array_elements(plan->'players')p
  WHERE r.period_start<=source.created_at AND r.period_end>source.created_at
   AND((r.union_id IS NOT NULL AND r.union_id::text=p->>'coordinator_union_id')
    OR(r.standalone_club_id IS NOT NULL AND p->>'coordinator_union_id' IS NULL AND r.standalone_club_id::text=p->>'club_id')))
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(source.id,source.hand_id,source.created_at,fingerprint,'accrued',plan);
 FOR player IN SELECT value FROM jsonb_array_elements(plan->'players') LOOP
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(player->>'club_id')::uuid
   AND source.created_at>=s.period_start AND source.created_at<s.period_end)
  THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(source.id,(player->>'player_id')::uuid,(player->>'club_id')::uuid,(player->>'union_id')::uuid,(player->>'coordinator_union_id')::uuid,source.created_at,(player->>'rake_credit')::numeric,player)
   RETURNING id INTO source_id;
  count_rows:=count_rows+public.fn_post_accounting_commission_source(source_id,'cash_rake_accrual',source.created_at,player);
 END LOOP;
 RETURN jsonb_build_object('recorded',true,'status','accrued','source_version',2,'rows_written',count_rows);
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_rakeback_split_counts' AND md5(p.prosrc)='0fcb9ee74db9f93000e3d78a2e21f599')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_rakeback_split_counts'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_rakeback_split_counts(p_club_id uuid, v_from timestamp with time zone, v_to timestamp with time zone, w_from timestamp with time zone, w_to timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
-- The three source-evidence counts of fn_calculate_cash_rakeback_periods'
-- whole-period call, over the rake records created and the sources earned in
-- w_from..w_to of the week v_from..v_to (20261003). Its own statement (built
-- from its text by this migration): only the record and drifted-source ranges
-- are the window's, and the sources a window record can join are read from
-- the whole week.
DECLARE scope_union uuid; evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
BEGIN
 v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
 w_from:=public.fn_ca_launch_accounting_start('club',p_club_id,w_from);
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 WITH week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at
   FROM public.rake_records r
   WHERE r.created_at>=w_from AND r.created_at<w_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     -- fn_rake_record_is_ghost_twin returns false the moment hand_id is not
     -- null, so `hand_id IS NOT NULL OR NOT ghost_twin(...)` is the same
     -- predicate - but OR short-circuits, so a linked row never detoasts its
     -- metadata and never runs the function's EXISTS over
     -- idx_rake_records_table_id. 2,652 ms -> 348 ms for the week slice.
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  -- Only this week's records reach the two counts that read this slice, so
  -- joining it to week_records is exact. Reading the club's whole history
  -- grew without bound (20260926042810).
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- A source can only be the PERFECT match the count below looks for if its
  -- club_id is this club and its earned_at is the record's created_at, which
  -- is inside the week by construction. Narrowing to the club-week slice
  -- therefore preserves every perfect match and every miss, and the existing
  -- accounting_cash_rake_sources_period index serves it directly instead of
  -- detoasting `contract` for the whole table.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM public.accounting_cash_rake_sources s JOIN week_records w ON w.id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 ), evidence AS (
  SELECT count(*) AS n FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- Bidirectional comparison also rejects an extra recorded source that no
  -- longer has an attribution. A matching subset is not a complete source set.
  SELECT count(*) AS n FROM public.accounting_cash_rake_sources s
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=w_from AND s.earned_at<w_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues
   FROM evidence,incomplete,drifted;
 RETURN jsonb_build_object('evidence',evidence_issues,'incomplete',incomplete_issues,'drifted',drifted_issues);
END
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_calculate_cash_rakeback_periods' AND md5(p.prosrc)='cb7f9eabbe3849ec05df23f9f2a361df')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_calculate_cash_rakeback_periods'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '300s'
    AS $$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 digest_now text; evidence_cp public.accounting_rakeback_period_evidence_checkpoints%ROWTYPE; counts record;
 base_horizon timestamptz; next_horizon timestamptz; base_records bigint; base_evidence bigint; base_incomplete bigint; base_drifted bigint;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 IF p_user_ids IS NULL THEN
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 -- One pass over the week feeds all three source-evidence counts. They are
 -- TESTED below in the original order, so the reason a bad week reports is
 -- unchanged; only the number of times the week is read has.
 WITH week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at
   FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     -- fn_rake_record_is_ghost_twin returns false the moment hand_id is not
     -- null, so `hand_id IS NOT NULL OR NOT ghost_twin(...)` is the same
     -- predicate - but OR short-circuits, so a linked row never detoasts its
     -- metadata and never runs the function's EXISTS over
     -- idx_rake_records_table_id. 2,652 ms -> 348 ms for the week slice.
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  -- Only this week's records reach the two counts that read this slice, so
  -- joining it to week_records is exact. Reading the club's whole history
  -- grew without bound (20260926042810).
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- A source can only be the PERFECT match the count below looks for if its
  -- club_id is this club and its earned_at is the record's created_at, which
  -- is inside the week by construction. Narrowing to the club-week slice
  -- therefore preserves every perfect match and every miss, and the existing
  -- accounting_cash_rake_sources_period index serves it directly instead of
  -- detoasting `contract` for the whole table.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 ), evidence AS (
  SELECT count(*) AS n FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- Bidirectional comparison also rejects an extra recorded source that no
  -- longer has an attribution. A matching subset is not a complete source set.
  SELECT count(*) AS n FROM public.accounting_cash_rake_sources s
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues
   FROM evidence,incomplete,drifted;
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 ELSE
 -- A PAGE READS ONLY THE EVIDENCE THAT CHANGED (20260930232349, re-derived from 20260927160709).
 -- The three week-level counts below are sums over the week's cash records.
 -- A record whose accrual batch exists is frozen: rake_records and
 -- rake_attributions refuse every change once it has one, and the batch and
 -- its sources are insert-only and written together. So its share of each
 -- count never changes while the clubs' union shape stays as it was. The
 -- checkpoint keeps those shares for every batch recorded before its horizon
 -- (a time no transaction still running had started by), and this page adds
 -- the batches recorded since and the records that have no batch yet, read in
 -- one snapshot. The totals are exactly the whole-week counts. The whole
 -- period call above keeps its own full verification.
 digest_now:=public.fn_accounting_clubs_scope_digest();
 SELECT * INTO evidence_cp FROM public.accounting_rakeback_period_evidence_checkpoints cp
  WHERE cp.club_id=p_club_id AND cp.period_start=p_period_start FOR UPDATE;
 IF FOUND AND evidence_cp.period_end=p_period_end AND evidence_cp.clubs_digest=digest_now THEN
  base_horizon:=evidence_cp.horizon;base_records:=evidence_cp.settled_records;
  base_evidence:=evidence_cp.settled_evidence;base_incomplete:=evidence_cp.settled_incomplete;base_drifted:=evidence_cp.settled_drifted;
 ELSE
  -- No checkpoint yet, or the union shape it was taken under has changed:
  -- start again from the week's first batch.
  base_horizon:='-infinity';base_records:=0;base_evidence:=0;base_incomplete:=0;base_drifted:=0;
 END IF;
 next_horizon:=public.fn_accounting_commit_horizon();
 IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;
 SELECT * INTO counts FROM public.fn_cash_period_evidence_since(p_club_id,v_from,v_to,scope_union,base_horizon,next_horizon);
 evidence_issues:=base_evidence+counts.o_evidence;
 incomplete_issues:=base_incomplete+counts.o_incomplete;
 drifted_issues:=base_drifted+counts.o_drifted;
 INSERT INTO public.accounting_rakeback_period_evidence_checkpoints AS cp(club_id,period_start,period_end,horizon,clubs_digest,
   settled_records,settled_evidence,settled_incomplete,settled_drifted)
  VALUES(p_club_id,p_period_start,p_period_end,next_horizon,digest_now,base_records+counts.o_settled_records,
   base_evidence+counts.o_settled_evidence,base_incomplete+counts.o_settled_incomplete,base_drifted+counts.o_settled_drifted)
  ON CONFLICT(club_id,period_start) DO UPDATE SET period_end=EXCLUDED.period_end,horizon=EXCLUDED.horizon,
   clubs_digest=EXCLUDED.clubs_digest,settled_records=EXCLUDED.settled_records,settled_evidence=EXCLUDED.settled_evidence,
   settled_incomplete=EXCLUDED.settled_incomplete,settled_drifted=EXCLUDED.settled_drifted,
   built_at=CASE WHEN base_horizon='-infinity'::timestamptz THEN clock_timestamp() ELSE cp.built_at END,
   advanced_at=clock_timestamp(),advances=cp.advances+1;
 -- Any of these refuses the page whatever the tournament gate says, so the
 -- gate is asked only when none does. Same reasons, counts and order as below.
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 END IF;

 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_cash_rakeback_period_basis' AND md5(p.prosrc)='1d408e24633229b47202d4b246d22a26')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_cash_rakeback_period_basis'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cash_rakeback_period_basis(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '300s'
    AS $$
DECLARE
 v_from timestamptz; v_to timestamptz; v_union uuid; source_issues bigint; missing_terms bigint:=0;
 invalid_terms bigint:=0; legacy_pending bigint; paid_conflicts bigint; v record;
 member_receipt jsonb; agent_receipt jsonb; member_terms jsonb; member_agent uuid;
 rows_by_user jsonb:='{}'; item jsonb; histories jsonb; total_cents numeric:=0; basis_rows jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_basis_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_basis_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
 SELECT union_id INTO v_union FROM public.clubs WHERE id=p_club_id;
 -- Missing attribution cannot be assigned to a particular member club. Hold
 -- every affected union preview when a source under its house club is missing,
 -- rather than quietly omitting the unknown beneficiary. Current club routing
 -- is used only to widen this failure check, never to assign a player's credit.
 WITH scoped_records AS (
  SELECT r.* FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
     AND (r.club_id=p_club_id
       OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)
       OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=r.club_id AND house.is_union IS TRUE
          AND v_union IS NOT NULL AND (house.union_id=v_union OR house.id=v_union)))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 )
 SELECT count(*) INTO source_issues FROM checks WHERE hand_id IS NULL OR attribution_count=0
  OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2);

 FOR v IN
  SELECT a.player_id,a.weighted_rake_credit,r.id AS rake_record_id,r.created_at
   FROM public.rake_attributions a JOIN public.rake_records r ON r.id=a.rake_record_id AND r.hand_id=a.hand_id
   WHERE a.club_id=p_club_id AND r.created_at>=v_from AND r.created_at<v_to
    AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
    AND a.weighted_rake_credit>0 AND a.weighted_rake_credit=round(a.weighted_rake_credit,2)
    AND (p_user_ids IS NULL OR a.player_id=ANY(p_user_ids))
    AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
   ORDER BY r.created_at,r.id,a.player_id
 LOOP
  item:=COALESCE(rows_by_user->v.player_id::text,jsonb_build_object('user_id',v.player_id,
    'rake_generated',0,'source_count',0,'first_earned_at',v.created_at,'contract_versions','[]'::jsonb));
  histories:=item->'contract_versions';
  BEGIN
   member_receipt:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||v.player_id::text,v.created_at);
   member_terms:=member_receipt->'terms';
   IF member_terms IS NULL OR member_terms='null'::jsonb
      OR member_terms->>'club_id' IS DISTINCT FROM p_club_id::text OR member_terms->>'user_id' IS DISTINCT FROM v.player_id::text
      OR member_terms->>'is_active' IS DISTINCT FROM 'true'
      OR COALESCE(member_terms->>'status','') NOT IN('active','approved')
   THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
   histories:=histories||jsonb_build_array(member_receipt->'history_id');
   member_agent:=NULLIF(member_terms->>'agent_id','')::uuid;
   IF member_agent IS NOT NULL THEN
    agent_receipt:=public.fn_accounting_agent_terms_at(p_club_id,member_agent,v.created_at);
    histories:=histories||jsonb_build_array(agent_receipt->'history_id');
   END IF;
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM='accounting_terms_not_observed' THEN missing_terms:=missing_terms+1;
   ELSIF SQLERRM IN('accounting_terms_not_active','accounting_terms_ambiguous') THEN invalid_terms:=invalid_terms+1;
   ELSE RAISE; END IF;
  END;
  SELECT COALESCE(jsonb_agg(DISTINCT h),'[]'::jsonb) INTO histories FROM jsonb_array_elements(histories) h;
  item:=item||jsonb_build_object('rake_generated',(item->>'rake_generated')::numeric+v.weighted_rake_credit,
    'source_count',(item->>'source_count')::bigint+1,'last_earned_at',v.created_at,'contract_versions',histories);
  rows_by_user:=jsonb_set(rows_by_user,ARRAY[v.player_id::text],item,true);
  total_cents:=total_cents+v.weighted_rake_credit*100;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY key),'[]'::jsonb) INTO basis_rows FROM jsonb_each(rows_by_user);
 -- Existing rows do not carry a source version or observed contracts. They
 -- are conflicts for the eventual writer even when the displayed totals match.
 SELECT count(*) FILTER(WHERE status='pending'),count(*) FILTER(WHERE status<>'pending')
  INTO legacy_pending,paid_conflicts FROM public.rakeback_periods
  WHERE club_id=p_club_id AND period_start<=p_period_end AND period_end>=p_period_start
    AND (p_user_ids IS NULL OR user_id=ANY(p_user_ids));
 RETURN jsonb_build_object('source_version',2,'accounting_timezone','America/Los_Angeles','club_id',p_club_id,
  'period_start',p_period_start,'period_end',p_period_end,'from',v_from,'to',v_to,
  'status',CASE WHEN source_issues+missing_terms+invalid_terms+legacy_pending+paid_conflicts=0 THEN 'ready' ELSE 'needs_reconciliation' END,
  'payable',false,'rows',basis_rows,'total_rake',total_cents/100,
  'missing_source_count',source_issues,'missing_terms_count',missing_terms,'invalid_terms_count',invalid_terms,
  'legacy_pending_conflicts',legacy_pending,'paid_period_conflicts',paid_conflicts,
  'scope','cash_only','written',0);
END $$;
CREATE OR REPLACE VIEW public.agent_commissions_unsettled WITH (security_invoker='true') AS
 SELECT id,
    club_id,
    user_id,
    amount,
    commission_rate,
    source_type,
    source_id,
    notes,
    created_at,
    settled_at
   FROM public.agent_commissions ac
  WHERE public.fn_ca_launch_accounting_accepts(ac.club_id,ac.created_at) AND ((settled_at IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.agent_commission_settlements s
          WHERE ((s.club_id = ac.club_id) AND (s.user_id = ac.user_id) AND (ac.created_at >= s.period_start) AND (ac.created_at < s.period_end))))));

-- Preserve original absence of pre-login execution; CREATE OR REPLACE retains other ACL entries.
REVOKE EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid,uuid),public.fn_cash_rakeback_period_basis(uuid,date,date,uuid[]) FROM PUBLIC,anon;

-- Component: cashier-cutoff-component/cashier-cutoff.sql
-- Scoped launch boundary. No compensation, custody bypass or financial rewrite.
CREATE FUNCTION public.fn_ca_launch_cashier_request_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE cut timestamptz;
BEGIN
 cut:=public.fn_ca_launch_accounting_cutoff('club',NEW.club_id);
 IF cut IS NULL THEN RETURN NEW; END IF;
 -- A delayed or backdated request cannot create an old obligation after launch.
 IF TG_OP='INSERT' AND (NEW.created_at IS NULL OR NEW.created_at<cut) THEN
  RAISE EXCEPTION 'LAUNCH_PREVIOUS_CASHIER_REQUEST_IS_WAIVED' USING ERRCODE='55000';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.created_at IS NULL OR OLD.created_at<cut)
   AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.club_id IS DISTINCT FROM OLD.club_id) THEN
  RAISE EXCEPTION 'LAUNCH_PREVIOUS_CASHIER_REQUEST_IS_WAIVED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cashier_request_boundary() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aaa_launch_cashier_boundary BEFORE INSERT OR UPDATE ON public.cashout_requests FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_cashier_request_boundary();
CREATE TRIGGER aaa_launch_cashier_boundary BEFORE INSERT OR UPDATE ON public.chip_requests FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_cashier_request_boundary();
CREATE TRIGGER aaa_launch_cashier_boundary BEFORE INSERT OR UPDATE ON public.credit_requests FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_cashier_request_boundary();

-- Preserve completed idempotent receipts. An unfinished original request is
-- waived, so its original retry path must not move post-launch funds.
DO $intent$
DECLARE original text; needle text:=E'    RETURN jsonb_build_object(''state'', ''proceed'');\n  END IF;';
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb)'::regprocedure)
 IS DISTINCT FROM '3ec6fc367b3dae5c4bf3978d0175ef22' THEN
  RAISE EXCEPTION 'LAUNCH_CASHIER_INTENT_SOURCE_CHANGED'; END IF;
 SELECT pg_get_functiondef('public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb)'::regprocedure) INTO original;
 IF (length(original)-length(replace(original,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'LAUNCH_CASHIER_INTENT_READER_SHAPE_CHANGED'; END IF;
 EXECUTE replace(original,needle,E'    IF NOT public.fn_ca_launch_accounting_accepts(v_existing.club_id,v_existing.created_at) THEN\n      RETURN jsonb_build_object(''state'',''return'',''response'',jsonb_build_object(''success'',false,''error'',''Prior Launch Cashier Request Was Waived''));\n    END IF;\n'||needle);
END $intent$;

CREATE FUNCTION public.fn_ca_launch_cashier_assert_drained(p_operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.ca_launch_reset_operations%ROWTYPE;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN
  RAISE EXCEPTION 'LAUNCH_CASHIER_REQUIRES_ENGINE_AND_FREEZE' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state NOT IN('captured','executed') THEN
  RAISE EXCEPTION 'LAUNCH_CASHIER_OPERATION_REQUIRED'; END IF;
 -- Never cancel a funded hold by changing its status. The original custody
 -- refund must finish before closing positions are captured.
 IF EXISTS(SELECT 1 FROM public.cashout_requests WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','approved','cancelling','completing'))
 OR EXISTS(SELECT 1 FROM public.chip_requests WHERE club_id=ANY(o.scoped_club_ids) AND status='pending')
 OR EXISTS(SELECT 1 FROM public.credit_requests WHERE club_id=ANY(o.scoped_club_ids) AND status='pending')
 OR EXISTS(SELECT 1 FROM public.cashier_rpc_operation_intents WHERE club_id=ANY(o.scoped_club_ids) AND receipt IS NULL)
 OR EXISTS(SELECT 1 FROM public.chip_escrow e JOIN public.cashout_requests r ON r.id=e.cashout_request_id WHERE r.club_id=ANY(o.scoped_club_ids) AND e.released_at IS NULL)
 THEN RAISE EXCEPTION 'LAUNCH_CASHIER_ORIGINAL_REQUEST_DRAIN_REQUIRED' USING ERRCODE='55006'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cashier_assert_drained(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_launch_cashier_activate(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.ca_launch_reset_operations%ROWTYPE; relation text; rows bigint:=0; n bigint;
BEGIN
 PERFORM public.fn_ca_launch_cashier_assert_drained(p_operation);
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=p_operation;
 FOREACH relation IN ARRAY ARRAY['cashout_requests','chip_requests','credit_requests','cashier_rpc_operation_intents','accounting_cashier_events','cashier_operations'] LOOP
  EXECUTE format('INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at) SELECT $1,%L,jsonb_build_array(to_jsonb(t)->%L)::text,to_jsonb(t),encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex''),$2 FROM public.%I t WHERE club_id=ANY($3)',relation,CASE WHEN relation='cashier_rpc_operation_intents' THEN 'operation_id' ELSE 'id' END,relation)
   USING p_operation,o.captured_at,o.scoped_club_ids;
  GET DIAGNOSTICS n=ROW_COUNT; rows:=rows+n;
 END LOOP;
 RETURN jsonb_build_object('operation_id',p_operation,'cashier_rows_archived',rows,'request_balances_mutated',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cashier_activate(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_launch_cashier_undo(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.fn_ca_launch_cashier_assert_drained(p_operation);
 -- No source request, intent or custody row was mutated. Accounting undo
 -- deactivates the shared boundary; original completed receipts stay truthful.
 RETURN jsonb_build_object('operation_id',p_operation,'cashier_sources_unchanged',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cashier_undo(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Component: accounting-component/activation.sql
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES('fn_ca_launch_accounting_activate','approved','Owner-directed exact four-club prelaunch liability waiver and derived stats reset; engine/freeze/drained scoped operation, immutable preimages and exact owned-field undo required'),('fn_ca_launch_accounting_undo','approved','Frozen same launch operation only; guarded exact owned business-field restore, immutable archives and traceable Mint/burn undo owned by original reset') ON CONFLICT(proname) DO NOTHING;
-- Atomic operation component; called only by the guarded, frozen launch reset.
CREATE TABLE public.ca_launch_accounting_store_receipts(
 operation_id uuid NOT NULL,relation_name text NOT NULL,mutated_columns text[],after_row_count bigint NOT NULL,
 receipt_sha256 text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(operation_id,relation_name)
);
ALTER TABLE public.ca_launch_accounting_store_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_store_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_store_receipts_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_store_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE TABLE public.ca_launch_accounting_postimages(
 operation_id uuid NOT NULL,relation_name text NOT NULL,row_key text NOT NULL,row_image jsonb NOT NULL,row_sha256 text NOT NULL,
 PRIMARY KEY(operation_id,relation_name,row_key)
);
ALTER TABLE public.ca_launch_accounting_postimages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_postimages FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_postimages_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_postimages FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE FUNCTION public.fn_ca_launch_accounting_store_query(p_relation text,p_columns text[] DEFAULT NULL) RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE v_scope text;v_keys text;v_value text;
BEGIN
 CASE
 WHEN p_relation IN('club_members','agents','settlement_invoices','rakeback_periods','club_settlement_floor','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly') THEN v_scope:='t.club_id=ANY($1)';
 WHEN p_relation IN('clubs','unions') THEN v_scope:='t.id=ANY($1)';
 WHEN p_relation='union_settlement_floor' THEN v_scope:='t.union_id=ANY($1)';
 WHEN p_relation='credit_invoices' THEN v_scope:='EXISTS(SELECT 1 FROM public.agents a WHERE a.id=t.agent_id AND a.club_id=ANY($1))';
 WHEN p_relation='club_member_table_state' THEN v_scope:='EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))';
 ELSE RAISE EXCEPTION 'launch_accounting_unknown_store: %',p_relation USING ERRCODE='22023';
 END CASE;
 SELECT string_agg(format('t.%I',a.attname),',' ORDER BY k.ord) INTO v_keys
 FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
 WHERE i.indrelid=format('public.%I',p_relation)::regclass AND i.indisprimary;
 IF v_keys IS NULL THEN RAISE EXCEPTION 'launch_accounting_store_has_no_primary_key: %',p_relation; END IF;
 v_value:=CASE WHEN p_columns IS NULL THEN 'to_jsonb(t)' ELSE '(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t))e WHERE e.key=ANY($2))' END;
 RETURN format('SELECT jsonb_build_array(%s)::text AS row_key,%s AS row_image FROM public.%I t WHERE %s',v_keys,v_value,p_relation,v_scope);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_store_query(text,text[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_store_rows(p_relation text,p_clubs uuid[],p_columns text[] DEFAULT NULL) RETURNS TABLE(row_key text,row_image jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RETURN QUERY EXECUTE public.fn_ca_launch_accounting_store_query(p_relation,p_columns) USING p_clubs,p_columns; END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_store_rows(text,uuid[],text[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_analyze(p_operation uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE
  OR p_operation::text IS DISTINCT FROM current_setting('app.launch_reset_operation',true)
  OR NOT EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o WHERE o.operation_id=p_operation AND o.state IN('captured','executed'))
 THEN RAISE EXCEPTION 'launch_accounting_statistics_actor_invalid' USING ERRCODE='42501'; END IF;
 ANALYZE public.ca_launch_accounting_archives;
 ANALYZE public.ca_launch_accounting_postimages;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_analyze(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_activate(p_operation uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o record;r record;v_rows jsonb;v_after jsonb;v_saved text;v_columns text[];v_set text;v_predicate text;
 v_relations text[]:=ARRAY['club_members','agents','clubs','unions','settlement_invoices','credit_invoices','rakeback_periods','club_settlement_floor','union_settlement_floor','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'];
 v_relation text;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'launch_accounting_requires_engine_and_freeze' USING ERRCODE='42501'; END IF;
 SELECT x.* INTO o FROM public.ca_launch_reset_operations x WHERE x.operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'captured' OR NOT isfinite(o.captured_at) OR
  (SELECT array_agg(x ORDER BY x) FROM unnest(o.scoped_club_ids)x) IS DISTINCT FROM ARRAY['2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid,'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'fade0000-0000-0000-0000-000000000001'::uuid]
 THEN RAISE EXCEPTION 'launch_accounting_operation_scope_or_state_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_accounting_boundaries WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'launch_accounting_already_activated'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND (t.club_id=ANY(o.scoped_club_ids) OR t.union_id=ANY(o.scoped_club_ids))) THEN RAISE EXCEPTION 'launch_accounting_live_scope_seats'; END IF;
 -- Today's week has not been certified yet. Do not overwrite a paid or cached current-week certificate.
 IF EXISTS(SELECT 1 FROM public.rakeback_periods p WHERE p.club_id=ANY(o.scoped_club_ids) AND p.period_start=(public.fn_union_week_start(o.captured_at) AT TIME ZONE 'America/Los_Angeles')::date) THEN RAISE EXCEPTION 'launch_accounting_current_week_period_requires_qualification'; END IF;
 v_saved:=current_setting('app.launch_reset_operation',true);PERFORM set_config('app.launch_reset_operation',p_operation::text,true);
 FOREACH v_relation IN ARRAY v_relations LOOP
  EXECUTE 'INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex''),$5 FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,NULL)||')e' USING o.scoped_club_ids,NULL::text[],p_operation,v_relation,o.captured_at;
 END LOOP;
 INSERT INTO public.ca_launch_profile_hand_baselines(operation_id,user_id,hand_offset,captured_total_hands,remaining_club_hands,restored_scope_hands,captured_at)
 SELECT p_operation,p.id,COALESCE(p.total_hands_played,0)-COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE(p.total_hands_played,0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids)),0),o.captured_at
 FROM public.profiles p WHERE EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=p.id AND m.club_id=ANY(o.scoped_club_ids)) OR EXISTS(SELECT 1 FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids));
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) SELECT 'club',x,p_operation,o.captured_at FROM unnest(o.scoped_club_ids)x;
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('union','fade0000-0000-0000-0000-000000000001',p_operation,o.captured_at);
 UPDATE public.club_members SET credit_used=0,sessions_played=0,chips_won=0,chips_lost=0,hands_played=0,total_rake_paid=0,biggest_pot=0,promo_received_total=0,promo_wagered=0,promo_playthrough_required=0,missions_completed=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.agents SET credit_used=0,weekly_rake_generated=0,lifetime_earnings=0,lifetime_rake_generated=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.clubs SET total_rake=0,hands_played=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.unions SET total_rake=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.settlement_invoices SET status='cancelled',updated_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','generated','overdue','disputed');
 UPDATE public.credit_invoices c SET status='void',amount_remaining=0,void_reason='Owner Directed Launch Waiver '||p_operation::text WHERE status IN('pending','partial','overdue','disputed') AND EXISTS(SELECT 1 FROM public.agents a WHERE a.id=c.agent_id AND a.club_id=ANY(o.scoped_club_ids));
 UPDATE public.rakeback_periods SET status='expired',deferred_reason='Owner Directed Launch Waiver '||p_operation::text,deferred_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','open','closed','claiming');
 INSERT INTO public.club_settlement_floor(club_id,earliest_period_start,reason) SELECT x,public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text FROM unnest(o.scoped_club_ids)x ON CONFLICT(club_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 INSERT INTO public.union_settlement_floor(union_id,earliest_period_start,reason) VALUES('fade0000-0000-0000-0000-000000000001',public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text) ON CONFLICT(union_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 FOREACH v_relation IN ARRAY v_relations[10:29] LOOP
  IF v_relation='club_member_table_state' THEN EXECUTE 'DELETE FROM public.club_member_table_state t WHERE EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))' USING o.scoped_club_ids;
  ELSE EXECUTE format('DELETE FROM public.%I t WHERE t.club_id=ANY($1)',v_relation) USING o.scoped_club_ids;END IF;
 END LOOP;
 FOREACH v_relation IN ARRAY v_relations LOOP
  v_columns:=CASE v_relation
   WHEN 'club_members' THEN ARRAY['credit_used','sessions_played','chips_won','chips_lost','hands_played','total_rake_paid','biggest_pot','promo_received_total','promo_wagered','promo_playthrough_required','missions_completed']
   WHEN 'agents' THEN ARRAY['credit_used','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']
   WHEN 'clubs' THEN ARRAY['total_rake','hands_played'] WHEN 'unions' THEN ARRAY['total_rake']
   WHEN 'settlement_invoices' THEN ARRAY['status','updated_at'] WHEN 'credit_invoices' THEN ARRAY['status','amount_remaining','void_reason']
   WHEN 'rakeback_periods' THEN ARRAY['status','deferred_reason','deferred_at']
   WHEN 'club_settlement_floor' THEN ARRAY['earliest_period_start','reason'] WHEN 'union_settlement_floor' THEN ARRAY['earliest_period_start','reason'] ELSE NULL END;
  EXECUTE 'INSERT INTO public.ca_launch_accounting_postimages(operation_id,relation_name,row_key,row_image,row_sha256) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex'') FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,v_columns)||')e' USING o.scoped_club_ids,v_columns,p_operation,v_relation;
  INSERT INTO public.ca_launch_accounting_store_receipts(operation_id,relation_name,mutated_columns,after_row_count,receipt_sha256)
  SELECT p_operation,v_relation,v_columns,count(*),encode(sha256(convert_to(p_operation::text||':'||v_relation||':'||count(*)::text,'UTF8')),'hex') FROM public.ca_launch_accounting_postimages WHERE operation_id=p_operation AND relation_name=v_relation;
 END LOOP;
 PERFORM public.fn_ca_launch_accounting_analyze(p_operation);
 PERFORM set_config('app.launch_reset_operation',COALESCE(v_saved,''),true);
 RETURN jsonb_build_object('activated',true,'operation_id',p_operation,'cutoff_at',o.captured_at,'relations',cardinality(v_relations),'waiver_is_payment',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_activate(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_undo(p_operation uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o record;r record;v_now jsonb;v_before jsonb;v_saved text;v_set text;v_join text;v_predicate text;v_insert_columns text;v_select_columns text;v_changed boolean;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'launch_accounting_requires_engine_and_freeze' USING ERRCODE='42501'; END IF;
 SELECT x.* INTO o FROM public.ca_launch_reset_operations x WHERE x.operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'executed' THEN RAISE EXCEPTION 'launch_accounting_undo_operation_state_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND (t.club_id=ANY(o.scoped_club_ids) OR t.union_id=ANY(o.scoped_club_ids))) THEN RAISE EXCEPTION 'launch_accounting_live_scope_seats'; END IF;
 IF (SELECT count(*) FROM public.ca_launch_accounting_store_receipts WHERE operation_id=p_operation)<>29 OR (SELECT count(*) FROM public.ca_launch_accounting_boundaries WHERE operation_id=p_operation AND undone_at IS NULL)<>5 THEN RAISE EXCEPTION 'launch_accounting_undo_capture_incomplete'; END IF;
 v_saved:=current_setting('app.launch_reset_operation',true);PERFORM set_config('app.launch_reset_operation',p_operation::text,true);
 -- Check EVERY owned business field before restoring anything. Original wallet reset and its undo own wallet fields independently.
 FOR r IN SELECT * FROM public.ca_launch_accounting_store_receipts WHERE operation_id=p_operation ORDER BY relation_name LOOP
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM ('||public.fn_ca_launch_accounting_store_query(r.relation_name,r.mutated_columns)||')n FULL JOIN (SELECT row_key,row_image FROM public.ca_launch_accounting_postimages WHERE operation_id=$3 AND relation_name=$4)p USING(row_key) WHERE n.row_image IS DISTINCT FROM p.row_image AND ($4<>''settlement_invoices'' OR p.row_key IS NOT NULL))' INTO v_changed USING o.scoped_club_ids,r.mutated_columns,p_operation,r.relation_name;
  IF v_changed THEN RAISE EXCEPTION 'launch_accounting_undo_postimage_changed: %',r.relation_name; END IF;
  IF r.after_row_count<>(SELECT count(*) FROM public.ca_launch_accounting_postimages WHERE operation_id=p_operation AND relation_name=r.relation_name) THEN RAISE EXCEPTION 'launch_accounting_postimage_receipt_changed: %',r.relation_name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM public.ca_launch_accounting_store_receipts WHERE operation_id=p_operation ORDER BY relation_name LOOP
  IF r.mutated_columns IS NULL OR r.relation_name IN('club_settlement_floor','union_settlement_floor') THEN
   IF r.relation_name='club_member_table_state' THEN EXECUTE 'DELETE FROM public.club_member_table_state t WHERE EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))' USING o.scoped_club_ids;
   ELSIF r.relation_name='union_settlement_floor' THEN EXECUTE 'DELETE FROM public.union_settlement_floor t WHERE t.union_id=ANY($1)' USING o.scoped_club_ids;
   ELSE EXECUTE format('DELETE FROM public.%I t WHERE t.club_id=ANY($1)',r.relation_name) USING o.scoped_club_ids; END IF;
   SELECT string_agg(format('%I',a.attname),',' ORDER BY a.attnum),string_agg(format('x.%I',a.attname),',' ORDER BY a.attnum) INTO v_insert_columns,v_select_columns FROM pg_attribute a WHERE a.attrelid=format('public.%I',r.relation_name)::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='';
   EXECUTE format('INSERT INTO public.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM public.ca_launch_accounting_archives a CROSS JOIN LATERAL jsonb_populate_record(NULL::public.%I,a.before_image)x WHERE a.operation_id=$1 AND a.relation_name=$2',r.relation_name,v_insert_columns,v_select_columns,r.relation_name) USING p_operation,r.relation_name;
  ELSE
   SELECT string_agg(format('%1$I=r.%1$I',c),',') INTO v_set FROM unnest(r.mutated_columns)c;
   SELECT string_agg(format('t.%1$I IS NOT DISTINCT FROM r.%1$I',a.attname),' AND ' ORDER BY k.ord) INTO v_join
   FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
   WHERE i.indrelid=format('public.%I',r.relation_name)::regclass AND i.indisprimary;
   IF v_join IS NULL THEN RAISE EXCEPTION 'launch_accounting_undo_key_missing: %',r.relation_name; END IF;
   -- Issued paid documents, terms, identities, rates and custody are untouched by the update.
   EXECUTE format('UPDATE public.%I t SET %s FROM public.ca_launch_accounting_archives a CROSS JOIN LATERAL jsonb_populate_record(NULL::public.%I,a.before_image)r WHERE a.operation_id=$1 AND a.relation_name=$2 AND %s AND (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t))e WHERE e.key=ANY($3)) IS DISTINCT FROM (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(r))e WHERE e.key=ANY($3))',r.relation_name,v_set,r.relation_name,v_join) USING p_operation,r.relation_name,r.mutated_columns;
  END IF;
 END LOOP;
 UPDATE public.ca_launch_accounting_boundaries SET undone_at=clock_timestamp() WHERE operation_id=p_operation AND undone_at IS NULL;
 PERFORM set_config('app.launch_reset_operation',COALESCE(v_saved,''),true);
 RETURN jsonb_build_object('undone',true,'operation_id',p_operation,'archives_retained',true,'global_hands_preserved',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_undo(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Component: accounting-component/invoice-visibility.sql
-- Add a restriction to existing permissions; it grants no access and leaves service history intact.
CREATE POLICY launch_current_settlement_invoices ON public.settlement_invoices AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.fn_ca_launch_accounting_accepts(club_id,created_at));
CREATE POLICY launch_current_credit_invoices ON public.credit_invoices AS RESTRICTIVE FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.agents a WHERE a.id=credit_invoices.agent_id AND public.fn_ca_launch_accounting_accepts(a.club_id,credit_invoices.created_at)));

-- Component: incident-component.sql
DO $original_guards$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure)) IS DISTINCT FROM 'e4a7c3e2099706adf19c4bd3885c6dbb' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_CHANGED: fn_ca_alert_resolution_reaches_the_incident()'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_drift_incident_timeline_guard()'::regprocedure)) IS DISTINCT FROM '86e3c04a77d99595901a1810b291ca3f' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_CHANGED: fn_ca_drift_incident_timeline_guard()'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_incident_resolution_reaches_the_alerts()'::regprocedure)) IS DISTINCT FROM '63b671cfa20b9f85c22e50dbe12281e1' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_CHANGED: fn_ca_incident_resolution_reaches_the_alerts()'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_resolution_needs_a_cause()'::regprocedure)) IS DISTINCT FROM '48547879bc49d84f5898e8cb44fe1951' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_CHANGED: fn_ca_resolution_needs_a_cause()'; END IF;
 IF md5(pg_get_functiondef('public.fn_capture_operational_source_event()'::regprocedure)) IS DISTINCT FROM '3031e327bd104873df31362bd21ccafe' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_CHANGED: fn_capture_operational_source_event()'; END IF;
END $original_guards$;
-- The owner waived prelaunch liabilities. This operator closure preserves the
-- uncertified basis and never records a payment or a successful ledger audit.
CREATE TABLE public.ca_launch_incident_waivers(
 operation_id uuid NOT NULL,relation_name text NOT NULL,row_id uuid NOT NULL,
 changed_fields text[] NOT NULL,postimage jsonb NOT NULL,
 PRIMARY KEY(operation_id,relation_name,row_id)
);
ALTER TABLE public.ca_launch_incident_waivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_incident_waivers FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_incident_waivers_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_incident_waivers FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
-- The later witnesses are narrowly identified prelaunch failures, not new debts.
-- The scheduler timeout did not record a period; retain that uncertainty.
CREATE FUNCTION public.fn_ca_launch_incident_waive_remaining(p_operation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o public.ca_launch_reset_operations%ROWTYPE;i public.ca_drift_incidents%ROWTYPE;note text;affected integer:=0;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_REQUIRES_ENGINE_AND_FREEZE'; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=p_operation;
 IF NOT FOUND OR o.state<>'captured' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_EXACT_BOUNDARY_REQUIRED'; END IF;
 FOR i IN SELECT * FROM public.ca_drift_incidents WHERE id IN('d6180536-0d0c-4024-bd3d-ddeb3d5c7e66','b4d32681-eedf-4125-9c98-103c39976b6f','e5113641-d4f0-46e3-afe7-6a3771fe8843','c17b258e-3b4e-407f-9ab3-f92d2c147920') AND status<>'resolved' ORDER BY id FOR UPDATE LOOP
  IF i.detected_at>=o.captured_at OR public.fn_ca_launch_accounting_waived('union','fade0000-0000-0000-0000-000000000001',public.fn_union_week_start(o.captured_at)) IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_NOT_PRELAUNCH'; END IF;
  IF i.source IN('fn_ca_conservation_sweep:fn_union_governance_check','fn_ca_conservation_sweep:fn_union_credit_risk_check') THEN
   IF jsonb_typeof(i.metadata->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(i.metadata->'rows')<>1 OR i.metadata#>>'{rows,0,invariant}' IS DISTINCT FROM 'union_eco_not_recorded' OR i.metadata#>>'{rows,0,offenders}' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_BASIS_CHANGED'; END IF;
   IF EXISTS(SELECT 1 FROM public.fn_union_governance_check() WHERE invariant='union_eco_not_recorded' AND offenders>0) OR EXISTS(SELECT 1 FROM public.fn_union_credit_risk_check() WHERE invariant='union_eco_not_recorded' AND offenders>0) THEN RAISE EXCEPTION 'LAUNCH_CURRENT_ECO_FAILURE_STILL_PRESENT'; END IF;
  ELSIF i.source='financial_alerts:fn_union_treasury_selftest' THEN
   IF i.metadata->>'union_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001' OR i.metadata->>'check' IS DISTINCT FROM 'lapsed_week_unclosed' OR i.metadata->>'alert_id' IS DISTINCT FROM 'a7a59fb9-5491-426b-ac84-1aa5d1e4fedf' THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_BASIS_CHANGED'; END IF;
  ELSIF i.source='financial_alerts:union_accounting_scheduler' THEN
   IF i.metadata->>'scope_kind' IS DISTINCT FROM 'union' OR i.metadata->>'scope_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001' OR i.metadata#>>'{result,error}' IS DISTINCT FROM 'weekly_scope_statement_budget_exhausted' OR i.metadata->>'alert_id' IS DISTINCT FROM '20b37a4b-8d9b-4207-8d5c-af8ee169a484' OR public.fn_union_week_start(i.detected_at) IS DISTINCT FROM public.fn_union_week_start(o.captured_at) THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_BASIS_CHANGED'; END IF;
  ELSE RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_SOURCE_CHANGED'; END IF;
  INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at)
   VALUES(p_operation,'ca_drift_incidents',jsonb_build_array(i.id)::text,to_jsonb(i),encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),o.captured_at);
  PERFORM 1 FROM public.financial_alerts x WHERE x.id=(i.metadata->>'alert_id')::uuid OR x.context->>'incident_id'=i.id::text ORDER BY x.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.financial_alerts x WHERE (x.id=(i.metadata->>'alert_id')::uuid OR x.context->>'incident_id'=i.id::text) AND x.source NOT IN(replace(i.source,'financial_alerts:',''),'drift_incident:'||i.source)) THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_MIRROR_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_alerts x WHERE (x.id=(i.metadata->>'alert_id')::uuid OR x.context->>'incident_id'=i.id::text) AND (
   (i.source='financial_alerts:fn_union_treasury_selftest' AND (x.context->>'union_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001' OR x.context->>'check' IS DISTINCT FROM 'lapsed_week_unclosed'))
   OR (i.source='financial_alerts:union_accounting_scheduler' AND (x.context->>'scope_kind' IS DISTINCT FROM 'union' OR x.context->>'scope_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001' OR x.context#>>'{result,error}' IS DISTINCT FROM 'weekly_scope_statement_budget_exhausted'))
   OR (i.source LIKE 'fn_ca_conservation_sweep:%' AND (x.context#>>'{rows,0,invariant}' IS DISTINCT FROM 'union_eco_not_recorded' OR x.context#>>'{rows,0,offenders}' IS DISTINCT FROM '1')))) THEN RAISE EXCEPTION 'LAUNCH_LATER_INCIDENT_MIRROR_CHANGED'; END IF;
  INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at)
   SELECT p_operation,'financial_alerts',jsonb_build_array(x.id)::text,to_jsonb(x),encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex'),o.captured_at FROM public.financial_alerts x WHERE x.id=(i.metadata->>'alert_id')::uuid OR x.context->>'incident_id'=i.id::text;
  note:='Owner Directed Launch Waiver '||p_operation::text||'. This prelaunch scoped witness is archived under the owner waiver and original launch floor. The timeout did not record an exact period; no historical payment, successful calculation or balanced ledger is asserted.';
  UPDATE public.ca_drift_incidents SET status='resolved',resolved_at=greatest(clock_timestamp(),detected_at),resolved_by=o.performed_by,closure_basis='operator',root_cause='The owner waived prior launch obligations. Original accounting and treasury readers honor the launch boundary, and the original scheduler floor excludes prior closed weeks. Historical uncertainty remains archived.',correction_ref='ruling: Owner Directed Launch Waiver '||p_operation::text,resolution=note WHERE id=i.id;
  UPDATE public.financial_alerts SET resolved=true,resolved_at=greatest(clock_timestamp(),created_at),resolved_by=o.performed_by,resolution=note WHERE (id=(i.metadata->>'alert_id')::uuid OR context->>'incident_id'=i.id::text) AND resolved IS NOT TRUE;
  IF EXISTS(SELECT 1 FROM public.ca_drift_incidents WHERE id=i.id AND status<>'resolved') OR EXISTS(SELECT 1 FROM public.financial_alerts WHERE (id=(i.metadata->>'alert_id')::uuid OR context->>'incident_id'=i.id::text) AND resolved IS NOT TRUE) THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_PROPAGATION_INCOMPLETE'; END IF;
  affected:=affected+1;
 END LOOP;
 RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_incident_waive_remaining(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_incident_prepare(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o public.ca_launch_reset_operations%ROWTYPE;i public.ca_drift_incidents%ROWTYPE;r record;v jsonb;note text;cols text[];
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_REQUIRES_ENGINE_AND_FREEZE'; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'captured' OR (SELECT count(*) FROM public.ca_launch_accounting_boundaries WHERE operation_id=p_operation AND undone_at IS NULL)<>5 THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_EXACT_BOUNDARY_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_incident_waivers WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ALREADY_PREPARED'; END IF;
 SELECT * INTO i FROM public.ca_drift_incidents WHERE id='ee31e7ff-fc2a-4c94-b9df-50cb0624285c' FOR UPDATE;
 IF NOT FOUND OR i.source IS DISTINCT FROM 'financial_alerts:union_accounting_scheduler'
 OR i.metadata->>'union_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'
 OR (i.metadata->>'period_start')::timestamptz IS DISTINCT FROM '2026-10-05 07:00:00+00'::timestamptz
 OR (i.metadata->>'period_end')::timestamptz IS DISTINCT FROM '2026-10-12 07:00:00+00'::timestamptz
 OR i.metadata#>>'{result,error}' IS DISTINCT FROM 'weekly_accounting_calculation_incomplete'
 OR i.metadata->>'alert_id' IS DISTINCT FROM '1df63d8e-7d33-4b55-8be3-02f2f41f9387'
 OR o.captured_at<='2026-10-12 07:00:00+00'::timestamptz THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_ORIGINAL_BASIS_CHANGED'; END IF;
 -- Include the two already-resolved ECO witnesses as immutable testimony,
 -- while preserving the other writer's stronger remeasurement decision.
 INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at)
 SELECT p_operation,'ca_drift_incidents',jsonb_build_array(x.id)::text,to_jsonb(x),encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex'),o.captured_at
 FROM public.ca_drift_incidents x WHERE id IN('ee31e7ff-fc2a-4c94-b9df-50cb0624285c','899985f3-daf0-447b-a6f1-d6e755a5b88d','597a0628-2115-4088-a217-e6980256e80a');
 PERFORM 1 FROM public.financial_alerts WHERE id='1df63d8e-7d33-4b55-8be3-02f2f41f9387' OR context->>'incident_id'=i.id::text ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.financial_alerts x WHERE (x.id='1df63d8e-7d33-4b55-8be3-02f2f41f9387' OR x.context->>'incident_id'=i.id::text)
 AND (x.source NOT IN('union_accounting_scheduler','drift_incident:financial_alerts:union_accounting_scheduler') OR x.context->>'union_id' IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'
 OR (x.context->>'period_start')::timestamptz IS DISTINCT FROM '2026-10-05 07:00:00+00'::timestamptz OR (x.context->>'period_end')::timestamptz IS DISTINCT FROM '2026-10-12 07:00:00+00'::timestamptz))
 THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_MIRROR_BASIS_CHANGED'; END IF;
 INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at)
 SELECT p_operation,'financial_alerts',jsonb_build_array(x.id)::text,to_jsonb(x),encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex'),o.captured_at FROM public.financial_alerts x
 WHERE id='1df63d8e-7d33-4b55-8be3-02f2f41f9387' OR context->>'incident_id'=i.id::text;
 note:='Owner Directed Launch Waiver '||p_operation::text||'. Prior-week liabilities are waived. The incomplete historical calculation and its uncertainty are retained in the immutable archive; no payment or ledger certification is asserted.';
 IF i.status<>'resolved' THEN
  UPDATE public.ca_drift_incidents SET status='resolved',resolved_at=greatest(clock_timestamp(),detected_at),resolved_by=o.performed_by,closure_basis='operator',
   root_cause='The old weekly accounting basis was incomplete. The owner explicitly waived all prelaunch obligations, and the launch cutoff prevents old earnings from becoming new liabilities.',
   correction_ref='ruling: Owner Directed Launch Waiver '||p_operation::text,resolution=note WHERE id=i.id;
 END IF;
 UPDATE public.financial_alerts SET resolved=true,resolved_at=greatest(clock_timestamp(),created_at),resolved_by=o.performed_by,resolution=note
   WHERE (id='1df63d8e-7d33-4b55-8be3-02f2f41f9387' OR context->>'incident_id'=i.id::text) AND (i.status<>'resolved' OR resolved IS NOT TRUE);
 PERFORM public.fn_ca_launch_incident_waive_remaining(p_operation);
 FOR r IN SELECT * FROM public.ca_launch_accounting_archives WHERE operation_id=p_operation AND relation_name IN('ca_drift_incidents','financial_alerts') LOOP
  cols:=CASE r.relation_name WHEN 'ca_drift_incidents' THEN ARRAY['status','resolved_at','resolved_by','closure_basis','root_cause','correction_ref','resolution'] ELSE ARRAY['resolved','resolved_at','resolved_by','resolution'] END;
  EXECUTE format('SELECT (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t))e WHERE e.key=ANY($2)) FROM public.%I t WHERE id=$1',r.relation_name) INTO v USING (r.before_image->>'id')::uuid,cols;
  IF v IS DISTINCT FROM (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(r.before_image)e WHERE e.key=ANY(cols)) THEN
   INSERT INTO public.ca_launch_incident_waivers VALUES(p_operation,r.relation_name,(r.before_image->>'id')::uuid,cols,v);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.ca_drift_incidents WHERE id=i.id AND status<>'resolved') OR EXISTS(SELECT 1 FROM public.financial_alerts WHERE (id='1df63d8e-7d33-4b55-8be3-02f2f41f9387' OR context->>'incident_id'=i.id::text) AND resolved IS NOT TRUE) THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_PROPAGATION_INCOMPLETE'; END IF;
 RETURN jsonb_build_object('operation_id',p_operation,'basis','operator_waiver','ledger_certified',false,'payment_made',false,'historical_basis_retained',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_incident_prepare(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_incident_undo(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o public.ca_launch_reset_operations%ROWTYPE;r record;v jsonb;pred text;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_REQUIRES_ENGINE_AND_FREEZE'; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'executed' THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_UNDO_PHASE_REQUIRED'; END IF;
 FOR r IN SELECT * FROM public.ca_launch_incident_waivers WHERE operation_id=p_operation ORDER BY relation_name,row_id LOOP
  EXECUTE format('SELECT (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t))e WHERE e.key=ANY($2)) FROM public.%I t WHERE id=$1',r.relation_name) INTO v USING r.row_id,r.changed_fields;
  IF v IS DISTINCT FROM r.postimage THEN RAISE EXCEPTION 'LAUNCH_INCIDENT_UNDO_POSTIMAGE_CHANGED'; END IF;
 END LOOP;
 FOR r IN SELECT w.*,a.before_image FROM public.ca_launch_incident_waivers w JOIN public.ca_launch_accounting_archives a ON a.operation_id=w.operation_id AND a.relation_name=w.relation_name AND a.row_key=jsonb_build_array(w.row_id)::text WHERE w.operation_id=p_operation ORDER BY w.relation_name,w.row_id LOOP
  SELECT string_agg(format('%1$I=x.%1$I',c),',') INTO pred FROM unnest(r.changed_fields)c;
  EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1)x WHERE t.id=$2',r.relation_name,pred,r.relation_name) USING r.before_image,r.row_id;
 END LOOP;
 RETURN jsonb_build_object('operation_id',p_operation,'incident_owned_fields_restored',true,'immutable_testimony_retained',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_incident_undo(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Component: reset-undo-component/balance-contract.sql
-- Source component, not independently installable. Integrate after closing and
-- accounting components. Exact-candidate real-trigger qualification is required.


DO $qualified_originals$
DECLARE r record; observed text; expected jsonb := '{"fn_ca_mint(text,text,uuid,numeric,text,text,text)":"da9429ce6483c47c7d536582433a1edd","fn_ca_emergency_issuance_guard()":"ad9f6b99951af4374934a526fe52660e","fn_ca_issuance_leg_is_registered()":"abdf1fd11d589957da51f8bd7554324d","fn_ca_mint_issued_24h(text,uuid)":"e0bf5ff9e14f1d9d070fde617b85ea7c"}'::jsonb;
BEGIN
 FOR r IN SELECT key,value FROM jsonb_each_text(expected) LOOP
  SELECT md5(pg_get_functiondef(('public.'||r.key)::regprocedure)) INTO observed;
  IF observed IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'LAUNCH_QUALIFIED_ORIGINAL_CHANGED: %',r.key; END IF;
 END LOOP;
END $qualified_originals$;
CREATE TABLE public.ca_launch_reset_mutations (
 operation_id uuid NOT NULL,relation_name text NOT NULL,row_key jsonb NOT NULL,
 column_name text NOT NULL,before_value numeric,after_value numeric,
 PRIMARY KEY(operation_id,relation_name,row_key,column_name)
);
CREATE TABLE public.ca_launch_reset_retirement_reversals (
 operation_id uuid NOT NULL,original_register_id uuid PRIMARY KEY,
 original_register jsonb NOT NULL,reverse_leg_id uuid NOT NULL UNIQUE,
 amount numeric(20,2) NOT NULL CHECK(amount>0),holder_id uuid NOT NULL
);
ALTER TABLE public.ca_launch_reset_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_launch_reset_retirement_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_reset_mutations,public.ca_launch_reset_retirement_reversals FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_launch_mutations BEFORE UPDATE OR DELETE ON public.ca_launch_reset_mutations FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE TRIGGER immutable_launch_retirement_reversals BEFORE UPDATE OR DELETE ON public.ca_launch_reset_retirement_reversals FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE TABLE public.ca_launch_reset_opening_authorizations (
 club_id uuid PRIMARY KEY,operation_id uuid NOT NULL,operation_key text NOT NULL UNIQUE,
 closing_sha256 text NOT NULL,horse_wallets integer NOT NULL CHECK(horse_wallets>0),
 amount numeric(20,2) NOT NULL CHECK(amount=horse_wallets::numeric*10000),performed_by uuid NOT NULL
);
ALTER TABLE public.ca_launch_reset_opening_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_reset_opening_authorizations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_launch_opening_authorizations BEFORE UPDATE OR DELETE ON public.ca_launch_reset_opening_authorizations FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE FUNCTION public.fn_ca_launch_opening_authorized(p_key text,p_asset text,p_destination text,p_target uuid,p_amount numeric) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ca_launch_reset_opening_authorizations a
 JOIN public.ca_launch_reset_operations o ON o.operation_id=a.operation_id
 WHERE a.operation_key=p_key AND p_amount <= (SELECT per_operation_cap_chips FROM public.ca_mint_policy WHERE id=1) AND p_asset='chips' AND p_destination='club' AND p_target=a.club_id AND p_amount=a.amount
 AND a.operation_key='launch-open:'||a.operation_id::text||':'||a.club_id::text
 AND a.performed_by=o.performed_by AND a.closing_sha256=o.closing_sha256
 AND o.state IN('captured','executed','undone') AND a.club_id=ANY(o.scoped_club_ids)
 AND a.horse_wallets=(SELECT count(*) FROM public.ca_launch_reset_rows r WHERE r.operation_id=a.operation_id AND r.relation_name='club_members' AND r.raw_row->>'club_id'=a.club_id::text AND r.raw_row->>'launch_is_horse'='true')
 AND ((SELECT count(*) FROM public.ca_launch_accounting_boundaries b WHERE b.operation_id=o.operation_id AND b.cutoff_at=o.captured_at AND ((b.scope_kind='club' AND b.scope_id=ANY(o.scoped_club_ids)) OR (b.scope_kind='union' AND b.scope_id='fade0000-0000-0000-0000-000000000001'))) = 5
 OR (o.state='undone' AND EXISTS(SELECT 1 FROM public.ca_mint_ledger m JOIN public.chip_ledger l ON l.id=m.chip_ledger_id WHERE m.op_id=a.operation_key AND m.asset='chips' AND m.action='mint' AND m.holder_id=a.club_id AND m.holder_type='club' AND m.amount=a.amount AND l.idempotency_key='mint:'||a.operation_key AND l.from_type='issuance_reserve' AND l.to_type='club_treasury' AND l.to_entity_id=a.club_id AND l.amount=a.amount))));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_opening_authorized(text,text,text,uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
-- This finite explicit owner grant replaces this captured roster's bankrolls.
-- It does not change ca_mint_policy or authorize an arbitrary other mint. All
-- normal mints still consume and obey the ordinary rolling/per-leg ceiling.
DO $opening_mint$
DECLARE old_def text; new_def text; needle text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_mint(text,text,uuid,numeric,text,text,text)'::regprocedure) INTO old_def;
 needle:='IF v_24h > v_roll THEN';
 IF strpos(old_def,needle)=0 THEN RAISE EXCEPTION 'LAUNCH_ORIGINAL_MINT_SHAPE_CHANGED'; END IF;
 new_def:=replace(old_def,needle,'IF v_24h > v_roll AND NOT public.fn_ca_launch_opening_authorized(p_op_id,v_asset,v_dest,p_target_id,p_amount) THEN');
 EXECUTE new_def;
END $opening_mint$;
CREATE TABLE public.ca_launch_reset_wallet_movements (
 operation_id uuid NOT NULL,operation_key text PRIMARY KEY,relation_name text NOT NULL,
 row_key jsonb NOT NULL,column_name text NOT NULL,account_type text NOT NULL,
 entity_id uuid NOT NULL,club_id uuid NOT NULL,before_value numeric NOT NULL,
 after_value numeric NOT NULL,bank_before numeric NOT NULL,bank_after numeric NOT NULL,
 performed_by uuid NOT NULL,direction text NOT NULL
);
ALTER TABLE public.ca_launch_reset_wallet_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_reset_wallet_movements FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_launch_wallet_movements BEFORE UPDATE OR DELETE ON public.ca_launch_reset_wallet_movements FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE FUNCTION public.fn_ca_launch_is_internal_transfer(p_leg uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.chip_ledger%ROWTYPE; m public.ca_launch_reset_wallet_movements%ROWTYPE;
 o public.ca_launch_reset_operations%ROWTYPE; p public.ca_launch_reset_positions%ROWTYPE;
BEGIN
 -- Each exact private proof is resolved by its own original unique key. This
 -- preserves all proof predicates without a cached multi-table join choosing
 -- a wallet-sized outer relation for every transfer.
 SELECT * INTO l FROM public.chip_ledger WHERE id=p_leg;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO m FROM public.ca_launch_reset_wallet_movements WHERE operation_key=l.idempotency_key;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=m.operation_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO p FROM public.ca_launch_reset_positions
 WHERE operation_id=m.operation_id AND relation_name=m.relation_name
 AND row_key=m.row_key AND column_name=m.column_name;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN coalesce(l.id=p_leg AND o.state IN('captured','executed','undone')
 AND m.performed_by=o.performed_by AND l.performed_by=m.performed_by
 AND l.status='posted' AND l.correlation_id=m.operation_id AND l.club_id=m.club_id
 AND m.club_id=p.club_id AND m.club_id=ANY(o.scoped_club_ids) AND m.entity_id=p.entity_id AND m.account_type=p.account_type
 AND m.after_value>=0 AND m.before_value>=0 AND m.bank_after=m.bank_before+m.before_value-m.after_value
 AND m.bank_before>=0 AND m.bank_after>=0
 AND l.amount=abs(m.after_value-m.before_value) AND l.amount>0
 AND l.category=CASE WHEN m.after_value>m.before_value THEN 'club_bank_send' ELSE 'club_bank_claim' END
 AND l.from_type=CASE WHEN m.after_value>m.before_value THEN 'club_treasury' ELSE m.account_type END
 AND l.from_entity_id=CASE WHEN m.after_value>m.before_value THEN m.club_id ELSE m.entity_id END
 AND l.to_type=CASE WHEN m.after_value>m.before_value THEN m.account_type ELSE 'club_treasury' END
 AND l.to_entity_id=CASE WHEN m.after_value>m.before_value THEN m.entity_id ELSE m.club_id END
 AND m.operation_key='launch-wallet:'||m.operation_id::text||':'||m.direction||':'||m.relation_name||':'||m.row_key::text||':'||m.column_name
 AND ((m.direction IN('retire','undo-opening') AND m.after_value=0)
 OR (m.direction='opening' AND m.relation_name='club_members' AND m.column_name='chip_balance' AND m.after_value=10000 AND EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r WHERE r.operation_id=m.operation_id AND r.relation_name=m.relation_name AND r.row_key=m.row_key AND r.raw_row->>'launch_is_horse'='true'))
 OR (m.direction='undo-retirement' AND m.after_value=p.balance)),false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_is_internal_transfer(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $internal_invoice$
DECLARE old_def text; needle text:=E'IF leg.metadata->>''entry_kind''=''launch_closing_position'' THEN RETURN NULL; END IF;';
BEGIN
 SELECT pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure) INTO old_def;
 IF strpos(old_def,needle)=0 THEN RAISE EXCEPTION 'LAUNCH_INTERNAL_INVOICE_OWNER_SHAPE_CHANGED'; END IF;
 EXECUTE replace(old_def,needle,needle||E'\n IF public.fn_ca_launch_is_internal_transfer(leg.id) THEN RETURN NULL; END IF;');
END $internal_invoice$;
CREATE FUNCTION public.fn_ca_launch_is_retirement_reversal(p_leg uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT EXISTS(SELECT 1 FROM public.ca_launch_reset_retirement_reversals r
 JOIN public.ca_launch_reset_operations o ON o.operation_id=r.operation_id
 JOIN public.ca_mint_ledger m ON m.id=r.original_register_id
 JOIN public.chip_ledger original ON original.id=m.chip_ledger_id
 JOIN public.chip_ledger reverse ON reverse.id=r.reverse_leg_id
 WHERE reverse.id=p_leg AND o.state IN('executed','undone')
 AND to_jsonb(m)=r.original_register AND m.asset='chips' AND m.action='burn'
 AND m.op_id='launch-retire:'||r.operation_id::text||':'||r.holder_id::text
 AND m.holder_id=r.holder_id AND m.amount=r.amount
 AND m.holder_type='club' AND m.balance_before-m.balance_after=r.amount
 AND original.category='burn' AND original.amount=r.amount
 AND original.from_type='club_treasury' AND original.from_entity_id=r.holder_id
 AND original.idempotency_key='burn:'||m.op_id
 AND original.to_type='chip_retirement'
 AND reverse.from_entity_id IS NULL
 AND reverse.from_type='chip_retirement' AND reverse.to_type='club_treasury'
 AND reverse.to_entity_id=r.holder_id AND reverse.amount=r.amount
 AND reverse.category='reversal'
 AND reverse.idempotency_key='launch-retirement-reversal:'||r.operation_id::text||':'||r.holder_id::text
 AND reverse.performed_by=o.performed_by
 AND reverse.metadata->>'original_register_id'=m.id::text);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_is_retirement_reversal(uuid) FROM PUBLIC,anon,authenticated,service_role;
-- Restoration of the exact receipt this operation retired is not fresh
-- discretionary issuance. It stays in both journals and in register supply.
-- Its proof cannot be asserted through a reason, caller GUC or arbitrary key.
DO $restore_guards$
DECLARE old_def text; new_def text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_issuance_leg_is_registered()'::regprocedure) INTO old_def;
 IF strpos(old_def,E'AND NEW.category <> ''correction'' THEN')=0 THEN RAISE EXCEPTION 'LAUNCH_ISSUANCE_GUARD_SHAPE_CHANGED'; END IF;
 new_def:=replace(old_def,E'AND NEW.category <> ''correction'' THEN',E'AND NEW.category <> ''correction'' AND NOT public.fn_ca_launch_is_retirement_reversal(NEW.id) AND NOT (NEW.from_type=''issuance_reserve'' AND NEW.to_type=''club_treasury'' AND left(NEW.idempotency_key,5)=''mint:'' AND public.fn_ca_launch_opening_authorized(substr(NEW.idempotency_key,6),''chips'',''club'',NEW.to_entity_id,NEW.amount)) THEN');
 EXECUTE new_def;
 SELECT pg_get_functiondef('public.fn_ca_mint_issued_24h(text,uuid)'::regprocedure) INTO old_def;
 IF strpos(old_def,E'AND m.origin <> ''baseline''')=0 THEN RAISE EXCEPTION 'LAUNCH_ROLLING_MINT_READER_SHAPE_CHANGED'; END IF;
 new_def:=replace(old_def,E'AND m.origin <> ''baseline''',E'AND m.origin <> ''baseline'' AND NOT public.fn_ca_launch_is_retirement_reversal(m.chip_ledger_id)');
 EXECUTE new_def;
 SELECT pg_get_functiondef('public.fn_ca_emergency_issuance_guard()'::regprocedure) INTO old_def;
 IF strpos(old_def,E'IF NEW.asset IN(''chips'',''diamonds'')')=0 THEN RAISE EXCEPTION 'LAUNCH_EMERGENCY_ISSUANCE_GUARD_SHAPE_CHANGED'; END IF;
 new_def:=replace(old_def,E'IF NEW.asset IN(''chips'',''diamonds'')',E'IF NEW.asset=''chips'' AND NEW.action=''mint'' AND public.fn_ca_launch_is_retirement_reversal(NEW.chip_ledger_id) THEN RETURN NEW; END IF;\n IF NEW.asset IN(''chips'',''diamonds'')');
 EXECUTE new_def;
END $restore_guards$;
-- Original tally verification remains the authority. A complete balanced prefix
-- may retire only its already-verified transaction JSON accumulator; versions
-- stay monotonic, so every later delta still queues the original commit guard.
CREATE TABLE public.ca_launch_reset_tally_prefixes (
 operation_id uuid NOT NULL,phase text NOT NULL,checked_version bigint NOT NULL,
 account_count integer NOT NULL,map_sha256 text NOT NULL,last_movement_key text NOT NULL,
 performed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(operation_id,phase,checked_version)
);
ALTER TABLE public.ca_launch_reset_tally_prefixes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_reset_tally_prefixes FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_launch_tally_prefixes BEFORE UPDATE OR DELETE ON public.ca_launch_reset_tally_prefixes FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_reset_testimony_immutable();
CREATE FUNCTION public.fn_ca_launch_reset_check_prefix(p_operation uuid,p_phase text,p_last_movement text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.ca_launch_reset_operations; tally jsonb; checked text; version text; n integer;
BEGIN
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation;
 IF op.operation_id IS NULL OR auth.uid() IS DISTINCT FROM op.performed_by
 OR public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE
 OR NOT ((p_phase IN('retire','opening') AND op.state='captured') OR (p_phase IN('undo-opening','undo-retirement') AND op.state='executed'))
 OR NOT EXISTS(SELECT 1 FROM public.ca_launch_reset_wallet_movements m JOIN public.chip_ledger l ON l.idempotency_key=m.operation_key
 WHERE m.operation_id=p_operation AND m.operation_key=p_last_movement AND m.direction=p_phase AND public.fn_ca_launch_is_internal_transfer(l.id)) THEN RAISE EXCEPTION 'LAUNCH_PREFIX_WRONG_OWNER_OR_PROOF' USING ERRCODE='42501'; END IF;
 tally:=coalesce(nullif(current_setting('ca.ledger_tally',true),'')::jsonb,'{}'::jsonb);
 SELECT count(*) INTO n FROM jsonb_each(tally);
 IF n<64 THEN RETURN; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 -- Original deferred writers may have appended deltas while flushing. Inspect
 -- the final checked map and version after every original constraint ran.
 tally:=coalesce(nullif(current_setting('ca.ledger_tally',true),'')::jsonb,'{}'::jsonb);
 version:=nullif(current_setting('ca.ledger_tally_ver',true),'');
 checked:=nullif(current_setting('ca.ledger_tally_checked',true),'');
 IF version IS NULL OR checked IS DISTINCT FROM version
 OR EXISTS(SELECT 1 FROM jsonb_each(tally) e WHERE coalesce((e.value->>'b')::numeric,0) IS DISTINCT FROM coalesce((e.value->>'l')::numeric,0))
 OR coalesce((tally->'settlement_suspense'->>'s')::numeric,0)<>0 THEN RAISE EXCEPTION 'LAUNCH_PREFIX_NOT_ORIGINALLY_VERIFIED'; END IF;
 INSERT INTO public.ca_launch_reset_tally_prefixes(operation_id,phase,checked_version,account_count,map_sha256,last_movement_key,performed_by)
 VALUES(p_operation,p_phase,version::bigint,(SELECT count(*)::integer FROM jsonb_each(tally)),encode(extensions.digest(tally::text,'sha256'),'hex'),p_last_movement,op.performed_by);
 PERFORM set_config('ca.ledger_tally','{}',true);
 -- Keep ca.ledger_tally_ver and checked unchanged: next real delta increments
 -- the original version and the original missing-leg refusal runs again.
 SET CONSTRAINTS ALL DEFERRED;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_check_prefix(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
('fn_ca_launch_reset_wallet_move','approved','Private exact captured wallet and treasury transfer. Original single-leg declaration, gated by scoped launch owner.'),
('fn_ca_launch_reset_execute','approved','Owner-authorized scoped launch. Frozen drained exact closing preimage, original Mint/register opening, journaled retirement, no reserve erasure.'),
('fn_ca_launch_reset_undo','approved','Frozen exact launch undo before resumed play. Exact post-position guard, receipt-bounded retirement reversal, original opening retirement, immutable journals retained.');
CREATE FUNCTION public.fn_ca_launch_reset_wallet_move(p_operation uuid,p_relation text,p_key jsonb,p_column text,p_target numeric,p_direction text) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pos public.ca_launch_reset_positions%ROWTYPE; op public.ca_launch_reset_operations%ROWTYPE; bank numeric; value numeric; delta numeric; predicate text; key text; leg uuid;
BEGIN
 SELECT * INTO pos FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name=p_relation AND row_key=p_key AND column_name=p_column;
 IF NOT FOUND OR p_relation NOT IN('club_members','agents') OR p_column NOT IN('chip_balance','promo_balance','agent_wallet_balance','promo_wallet_balance') OR p_target IS NULL OR p_target<0 OR p_target<>round(p_target,2) THEN RAISE EXCEPTION 'LAUNCH_WALLET_MOVE_NOT_IN_CAPTURE'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation;
 IF NOT FOUND OR auth.uid() IS DISTINCT FROM op.performed_by
 OR NOT ((p_direction IN('retire','opening') AND op.state='captured') OR (p_direction IN('undo-opening','undo-retirement') AND op.state='executed')) THEN RAISE EXCEPTION 'LAUNCH_WALLET_MOVE_WRONG_OWNER_PHASE'; END IF;
 IF (p_direction IN('retire','undo-opening') AND p_target<>0) OR (p_direction='undo-retirement' AND p_target IS DISTINCT FROM pos.balance) OR (p_direction IN('opening','undo-opening') AND NOT (p_relation='club_members' AND p_column='chip_balance' AND EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r WHERE r.operation_id=p_operation AND r.relation_name=p_relation AND r.row_key=p_key AND r.raw_row->>'launch_is_horse'='true'))) OR (p_direction='opening' AND p_target<>10000) THEN RAISE EXCEPTION 'LAUNCH_WALLET_TARGET_IS_NOT_AUTHORIZED'; END IF;
 SELECT chip_treasury INTO bank FROM public.clubs WHERE id=pos.club_id FOR UPDATE;
 predicate:=CASE WHEN p_relation='club_members'  THEN format('club_id=%L::uuid AND user_id=%L::uuid',p_key->>'club_id',p_key->>'user_id') ELSE format('id=%L::uuid',p_key->>'id') END;
 EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',p_column,p_relation,predicate) INTO value;
 IF value IS NULL THEN RAISE EXCEPTION 'LAUNCH_WALLET_VALUE_IS_NULL'; END IF;
 delta:=p_target-value;
 IF delta=0 THEN RETURN 0; END IF;
 key:='launch-wallet:'||p_operation::text||':'||p_direction||':'||p_relation||':'||p_key::text||':'||p_column;
 INSERT INTO public.ca_launch_reset_wallet_movements VALUES(p_operation,key,p_relation,p_key,p_column,pos.account_type,pos.entity_id,pos.club_id,value,p_target,bank,bank-delta,op.performed_by,p_direction);
 -- Original bank transfer contract: wallet journal writes the single leg;
 -- bank autoledger is stood down only for its matching other balance side.
 PERFORM public.fn_ca_declare_ledger(CASE WHEN delta>0 THEN 'club_bank_send' ELSE 'club_bank_claim' END,'club_treasury',pos.club_id,NULL,key,ARRAY['clubs']);
 PERFORM set_config('app.ledger_correlation',p_operation::text,true);
 PERFORM set_config('app.ledger_autoskip_'||p_relation,'',true);
 EXECUTE format('UPDATE public.%I SET %I=$1 WHERE %s',p_relation,p_column,predicate) USING p_target;
 UPDATE public.clubs SET chip_treasury=chip_treasury-delta WHERE id=pos.club_id;
 SELECT id INTO leg FROM public.chip_ledger WHERE idempotency_key=key;
 IF leg IS NULL OR NOT public.fn_ca_launch_is_internal_transfer(leg) THEN RAISE EXCEPTION 'LAUNCH_WALLET_TRANSFER_HAS_NO_EXACT_LEG'; END IF;
 PERFORM set_config('app.ledger_autoskip_clubs','',true);
 PERFORM public.fn_ca_launch_reset_check_prefix(p_operation,p_direction,key);
 RETURN -delta;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_wallet_move(uuid,text,jsonb,text,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_reset_execute(p_operation uuid,p_expected_closing_sha256 text,p_expected_horse_wallets integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='4s' AS $$
DECLARE op public.ca_launch_reset_operations%ROWTYPE; pos public.ca_launch_reset_positions%ROWTYPE; c uuid; retired numeric; opening numeric; answer jsonb; got numeric; predicate text; selected_rows bigint; roster integer; pool public.bbj_pools%ROWTYPE; difference numeric;
BEGIN
 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF NOT pg_try_advisory_xact_lock(530090,1) OR NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'LAUNCH_RESET_ENTRY_GATE_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR op.state<>'captured' OR op.closing_sha256 IS DISTINCT FROM p_expected_closing_sha256 THEN RAISE EXCEPTION 'LAUNCH_RESET_NOT_EXACT_CAPTURE'; END IF;
 IF p_expected_horse_wallets IS NULL OR p_expected_horse_wallets<=0 THEN RAISE EXCEPTION 'LAUNCH_RESET_EXPECTED_ROSTER_REQUIRED'; END IF;
 PERFORM 1 FROM public.clubs WHERE id=ANY(op.scoped_club_ids) ORDER BY id FOR UPDATE;
 -- Preserve the captured roster. A late departure/join/status change is not
 -- silently given a different bankroll by a changed cutover enumeration.
 SELECT count(*) INTO roster FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members' AND raw_row->>'launch_is_horse'='true';
 IF roster<>p_expected_horse_wallets OR roster=0 OR (SELECT count(*) FROM public.club_members WHERE club_id=ANY(op.scoped_club_ids))<>(SELECT count(*) FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members') THEN RAISE EXCEPTION 'LAUNCH_RESET_ROSTER_CHANGED'; END IF;
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',pos.column_name,pos.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM pos.balance THEN RAISE EXCEPTION 'LAUNCH_RESET_POSITION_CHANGED: % %',pos.relation_name,pos.column_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.agents WHERE club_id=ANY(op.scoped_club_ids)
 AND (player_wallet_balance IS DISTINCT FROM round(player_wallet_balance,2) OR player_wallet_balance IS DISTINCT FROM player_balance)) THEN RAISE EXCEPTION 'LAUNCH_RESET_AGENT_ALIAS_IS_NOT_EXACTLY_RESTORABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r LEFT JOIN public.club_members m ON m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid LEFT JOIN public.profiles p ON p.id=m.user_id
 WHERE r.operation_id=p_operation AND r.relation_name='club_members'
 AND (m.user_id IS NULL OR p.id IS NULL OR to_jsonb(p.is_horse) IS DISTINCT FROM r.raw_row->'launch_is_horse'
 OR to_jsonb(p.status) IS DISTINCT FROM r.raw_row->'launch_profile_status' OR to_jsonb(m.status) IS DISTINCT FROM r.raw_row->'status' OR to_jsonb(m.membership_lifecycle_status) IS DISTINCT FROM r.raw_row->'membership_lifecycle_status'
 OR (p.is_horse IS TRUE AND p.status='deleted'))) THEN RAISE EXCEPTION 'LAUNCH_RESET_ROSTER_IDENTITY_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_positions positionrow JOIN public.profiles p ON p.id=positionrow.entity_id WHERE positionrow.operation_id=p_operation AND positionrow.relation_name IN('club_members','agents') AND positionrow.counted_in_supply AND p.status='deleted' AND coalesce(positionrow.balance,0)<>0) THEN RAISE EXCEPTION 'LAUNCH_RESET_DELETED_CUSTODY_PREIMAGE_IS_NOT_ZERO'; END IF;
 PERFORM public.fn_ca_launch_cashier_activate(p_operation);
 PERFORM public.fn_ca_launch_accounting_activate(p_operation);
 PERFORM public.fn_ca_launch_incident_prepare(p_operation);
 answer:=public.fn_ca_epoch3_preflight();
 IF (answer->>'pass')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_RESET_PREFLIGHT_FAILED: %',answer; END IF;
 FOREACH c IN ARRAY op.scoped_club_ids LOOP
  retired:=0;
  FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND club_id=c AND ((relation_name='club_members' AND column_name IN('chip_balance','promo_balance')) OR (relation_name='agents' AND column_name IN('agent_wallet_balance','promo_wallet_balance'))) ORDER BY relation_name,row_key::text,column_name LOOP
   retired:=retired+public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,0,'retire');
  END LOOP;
  IF retired>0 THEN
   answer:=public.fn_ca_burn('chips','club',c,retired,'Owner Authorized Launch Retirement Of Prior Player And Agent Balances','launch-retire:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_RETIREMENT_REFUSED: %',answer; END IF;
  END IF;
  SELECT count(*)*10000 INTO opening FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members' AND raw_row->>'club_id'=c::text AND raw_row->>'launch_is_horse'='true';
  IF opening>0 THEN
   INSERT INTO public.ca_launch_reset_opening_authorizations VALUES(c,p_operation,'launch-open:'||p_operation::text||':'||c::text,op.closing_sha256,(opening/10000)::integer,opening,op.performed_by);
   PERFORM set_config('app.ledger_autoskip_clubs','',true);
   answer:=public.fn_ca_mint('chips','club',c,opening,'Owner Authorized Launch Bankroll 10000 Chips In Each Horse Club Wallet','launch-open:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_OPENING_MINT_REFUSED: %',answer; END IF;
   FOR pos IN SELECT p.* FROM public.ca_launch_reset_positions p JOIN public.ca_launch_reset_rows r USING(operation_id,relation_name,row_key) WHERE p.operation_id=p_operation AND p.relation_name='club_members' AND p.column_name='chip_balance' AND p.club_id=c AND r.raw_row->>'launch_is_horse'='true' ORDER BY p.row_key::text LOOP
    PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,10000,'opening');
   END LOOP;
  END IF;
 END LOOP;
 -- Displayed legacy player aliases are not counted as additional chip supply.
 -- They are cleared explicitly and restored exactly in undo after validation.
 UPDATE public.agents SET player_wallet_balance=0 WHERE club_id=ANY(op.scoped_club_ids);
 SELECT * INTO pool FROM public.bbj_pools WHERE id='f9806a7f-e7a2-47d2-a676-36336e3a5337' AND union_id='fade0000-0000-0000-0000-000000000001' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LAUNCH_BBJ_POOL_CHANGED'; END IF;
 difference:=pool.main_balance-12350;
 IF difference<>0 THEN
  PERFORM public.fn_ca_declare_ledger('treasury_transfer','union_bank',pool.union_id,NULL,'launch-bbj:'||p_operation::text,ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation',p_operation::text,true);
  UPDATE public.bbj_pools SET main_balance=12350 WHERE id=pool.id;
  UPDATE public.union_wallets SET chip_balance=chip_balance+difference WHERE union_id=pool.union_id;
  PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.club_members m JOIN public.ca_launch_reset_rows r ON r.operation_id=p_operation AND r.relation_name='club_members' AND m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid
 WHERE m.chip_balance IS DISTINCT FROM CASE WHEN r.raw_row->>'launch_is_horse'='true' THEN 10000::numeric ELSE 0::numeric END OR coalesce(m.promo_balance,0)<>0) THEN RAISE EXCEPTION 'LAUNCH_OPENING_WALLET_POSTCONDITION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM public.agents WHERE club_id=ANY(op.scoped_club_ids) AND (coalesce(agent_wallet_balance,0)<>0 OR coalesce(promo_wallet_balance,0)<>0 OR coalesce(player_wallet_balance,0)<>0 OR coalesce(player_balance,0)<>0)) THEN RAISE EXCEPTION 'LAUNCH_AGENT_ZERO_POSTCONDITION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_positions p JOIN public.clubs c ON c.id=p.entity_id WHERE p.operation_id=p_operation AND p.relation_name='clubs' AND p.column_name='chip_treasury' AND c.chip_treasury IS DISTINCT FROM p.balance) THEN RAISE EXCEPTION 'LAUNCH_BANK_PRESERVATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.bbj_pools WHERE id=pool.id AND main_balance=12350 AND backup_balance=pool.backup_balance AND promo_balance=pool.promo_balance) THEN RAISE EXCEPTION 'LAUNCH_BBJ_POSTCONDITION_FAILED'; END IF;
 -- Exact mutations manifest from immutable preimage, including preserved banks.
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s',pos.column_name,pos.relation_name,predicate) INTO got;
  INSERT INTO public.ca_launch_reset_mutations VALUES(p_operation,pos.relation_name,pos.row_key,pos.column_name,pos.balance,got);
 END LOOP;
 UPDATE public.ca_launch_reset_operations SET state='executed',executed_at=clock_timestamp(),result=jsonb_build_object('horse_wallets',roster,'horse_opening',roster*10000,'bbj_main',12350) WHERE operation_id=p_operation RETURNING result INTO answer;
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_execute(uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_reset_execute(uuid,text,integer) TO service_role;
CREATE FUNCTION public.fn_ca_launch_reset_undo(p_operation uuid,p_expected_closing_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='4s' AS $$
DECLARE op public.ca_launch_reset_operations%ROWTYPE; pos public.ca_launch_reset_positions%ROWTYPE;
 mutation public.ca_launch_reset_mutations%ROWTYPE; c uuid; minted numeric; answer jsonb; original public.ca_mint_ledger%ROWTYPE;
 v_leg uuid; v_before numeric; v_after numeric; got numeric; predicate text; selected_rows bigint; pool public.bbj_pools%ROWTYPE; old_main numeric; difference numeric;
BEGIN
 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF NOT pg_try_advisory_xact_lock(530090,1) OR NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'LAUNCH_RESET_ENTRY_GATE_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR op.state<>'executed' OR op.closing_sha256 IS DISTINCT FROM p_expected_closing_sha256 THEN RAISE EXCEPTION 'LAUNCH_UNDO_NOT_EXACT_EXECUTION'; END IF;
 PERFORM 1 FROM public.clubs WHERE id=ANY(op.scoped_club_ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.club_members WHERE club_id=ANY(op.scoped_club_ids))<>(SELECT count(*) FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members') THEN RAISE EXCEPTION 'LAUNCH_UNDO_ROSTER_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r LEFT JOIN public.club_members m ON m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid LEFT JOIN public.profiles p ON p.id=m.user_id WHERE r.operation_id=p_operation AND r.relation_name='club_members' AND (p.id IS NULL OR to_jsonb(p.status) IS DISTINCT FROM r.raw_row->'launch_profile_status' OR to_jsonb(p.is_horse) IS DISTINCT FROM r.raw_row->'launch_is_horse')) THEN RAISE EXCEPTION 'LAUNCH_UNDO_IDENTITY_CHANGED'; END IF;
 -- A stale undo may never overwrite resumed play or a later deposit. Refuse
 -- before restoring any value when any captured post-position has moved.
 FOR mutation IN SELECT * FROM public.ca_launch_reset_mutations WHERE operation_id=p_operation ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN mutation.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',mutation.row_key->>'club_id',mutation.row_key->>'user_id') ELSE format('id=%L::uuid',mutation.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',mutation.column_name,mutation.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM mutation.after_value THEN RAISE EXCEPTION 'LAUNCH_UNDO_POST_POSITION_CHANGED: % %',mutation.relation_name,mutation.column_name; END IF;
 END LOOP;
 FOREACH c IN ARRAY op.scoped_club_ids LOOP
  SELECT coalesce(sum(amount),0) INTO minted FROM public.ca_mint_ledger WHERE op_id='launch-open:'||p_operation::text||':'||c::text AND asset='chips' AND action='mint';
  IF minted>0 THEN
   FOR pos IN SELECT p.* FROM public.ca_launch_reset_positions p JOIN public.ca_launch_reset_rows r USING(operation_id,relation_name,row_key) WHERE p.operation_id=p_operation AND p.relation_name='club_members' AND p.column_name='chip_balance' AND p.club_id=c AND r.raw_row->>'launch_is_horse'='true' ORDER BY p.row_key::text LOOP
    PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,0,'undo-opening');
   END LOOP;
   answer:=public.fn_ca_burn('chips','club',c,minted,'Exact Undo Of This Launch Opening Mint','launch-undo-opening:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_UNDO_OPENING_BURN_REFUSED: %',answer; END IF;
  END IF;
  SELECT * INTO original FROM public.ca_mint_ledger WHERE op_id='launch-retire:'||p_operation::text||':'||c::text AND asset='chips' AND action='burn';
  IF FOUND THEN
   v_leg:=gen_random_uuid();
   INSERT INTO public.ca_launch_reset_retirement_reversals VALUES(p_operation,original.id,to_jsonb(original),v_leg,original.amount,c);
   SELECT chip_treasury INTO v_before FROM public.clubs WHERE id=c FOR UPDATE;
   PERFORM set_config('app.ledger_autoskip_clubs','1',true);
   UPDATE public.clubs SET chip_treasury=chip_treasury+original.amount WHERE id=c RETURNING chip_treasury INTO v_after;
   INSERT INTO public.chip_ledger(id,performed_by,from_type,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,correlation_id,pre_to_balance,post_to_balance,metadata)
   VALUES(v_leg,op.performed_by,'chip_retirement','club_treasury',c,original.amount,'reversal',c,'Exact Restoration Of This Launch Retirement Receipt','launch-retirement-reversal:'||p_operation::text||':'||c::text,p_operation,v_before,v_after,jsonb_build_object('original_register_id',original.id));
   PERFORM set_config('app.ledger_autoskip_clubs','',true);
   -- Materialize the existing authoritative register now, so postconditions
   -- read it before deferred commit checks. Those checks still run normally.
   PERFORM public.fn_ca_register_issuance_leg(v_leg);
   IF NOT public.fn_ca_launch_is_retirement_reversal(v_leg) THEN RAISE EXCEPTION 'LAUNCH_UNDO_RETIREMENT_RECEIPT_UNPROVEN'; END IF;
  END IF;
  FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND club_id=c AND ((relation_name='club_members' AND column_name IN('chip_balance','promo_balance')) OR (relation_name='agents' AND column_name IN('agent_wallet_balance','promo_wallet_balance'))) ORDER BY relation_name,row_key::text,column_name LOOP
   IF pos.balance IS NOT NULL THEN PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,pos.balance,'undo-retirement'); END IF;
  END LOOP;
 END LOOP;
 SELECT * INTO pool FROM public.bbj_pools WHERE id='f9806a7f-e7a2-47d2-a676-36336e3a5337' FOR UPDATE;
 SELECT balance INTO old_main FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name='bbj_pools' AND row_key=jsonb_build_object('id',pool.id) AND column_name='main_balance';
 IF old_main IS NULL THEN RAISE EXCEPTION 'LAUNCH_UNDO_BBJ_PREIMAGE_MISSING'; END IF;
 difference:=pool.main_balance-old_main;
 IF difference<>0 THEN
  PERFORM public.fn_ca_declare_ledger('treasury_transfer','union_bank',pool.union_id,NULL,'launch-bbj-undo:'||p_operation::text,ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation',p_operation::text,true);
  UPDATE public.bbj_pools SET main_balance=old_main WHERE id=pool.id;
  UPDATE public.union_wallets SET chip_balance=chip_balance+difference WHERE union_id=pool.union_id;
  PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
 END IF;
 UPDATE public.agents a SET player_wallet_balance=(r.raw_row->>'player_wallet_balance')::numeric
 FROM public.ca_launch_reset_rows r WHERE r.operation_id=p_operation AND r.relation_name='agents' AND a.id=(r.row_key->>'id')::uuid;
 PERFORM public.fn_ca_launch_cashier_undo(p_operation);
 PERFORM public.fn_ca_launch_incident_undo(p_operation);
 PERFORM public.fn_ca_launch_accounting_undo(p_operation);
 -- Compare every financial pre-position after both owners restored their data.
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s',pos.column_name,pos.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM pos.balance THEN RAISE EXCEPTION 'LAUNCH_UNDO_DID_NOT_RESTORE_EXACT_POSITION: % %',pos.relation_name,pos.column_name; END IF;
 END LOOP;
 UPDATE public.ca_launch_reset_operations SET state='undone',undone_at=clock_timestamp() WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operation_id',p_operation,'state','undone','closing_sha256',op.closing_sha256,'journals_retained',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reset_undo(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_reset_undo(uuid,text) TO service_role;

-- Component: reset-undo-component/velocity-wiring.sql
-- Exact existing observer wiring, no threshold or ordinary-Mint exception change.

CREATE FUNCTION public.fn_ca_launch_velocity_receipt(p_leg uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT EXISTS (
 SELECT 1 FROM public.chip_ledger l JOIN public.ca_mint_ledger m ON m.chip_ledger_id=l.id
 JOIN public.ca_launch_reset_operations o ON o.performed_by=l.performed_by
 WHERE l.id=p_leg AND l.status='posted' AND m.asset='chips' AND m.amount=l.amount
 AND m.holder_type='club' AND m.holder_id=ANY(o.scoped_club_ids)
 AND o.state IN('captured','executed','undone')
 AND (
 (m.action='mint' AND l.category='mint' AND l.from_type='issuance_reserve' AND l.to_type='club_treasury'
 AND l.to_entity_id=m.holder_id AND l.idempotency_key='mint:'||m.op_id
 AND public.fn_ca_launch_opening_authorized(m.op_id,'chips','club',m.holder_id,m.amount))
 OR (m.action='burn' AND l.category='burn' AND l.from_type='club_treasury' AND l.from_entity_id=m.holder_id
 AND l.to_type='chip_retirement' AND l.idempotency_key='burn:'||m.op_id
 AND m.op_id='launch-retire:'||o.operation_id::text||':'||m.holder_id::text
 AND m.amount=(SELECT sum(p.balance) FROM public.ca_launch_reset_positions p WHERE p.operation_id=o.operation_id AND p.club_id=m.holder_id
 AND ((p.relation_name='club_members' AND p.column_name IN('chip_balance','promo_balance')) OR (p.relation_name='agents' AND p.column_name IN('agent_wallet_balance','promo_wallet_balance')))))
 OR (m.action='burn' AND l.category='burn' AND l.from_type='club_treasury' AND l.from_entity_id=m.holder_id
 AND l.to_type='chip_retirement' AND l.idempotency_key='burn:'||m.op_id
 AND m.op_id='launch-undo-opening:'||o.operation_id::text||':'||m.holder_id::text
 AND o.state IN('executed','undone') AND EXISTS(SELECT 1 FROM public.ca_launch_reset_opening_authorizations a
 WHERE a.operation_id=o.operation_id AND a.club_id=m.holder_id AND a.amount=m.amount AND a.closing_sha256=o.closing_sha256))
 OR public.fn_ca_launch_is_retirement_reversal(l.id)
 ));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_velocity_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $velocity_owner$
DECLARE original text; changed text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure) INTO original;
 IF md5(original) IS DISTINCT FROM 'c22bbee2e281142c032212d4220a0a17' THEN RAISE EXCEPTION 'LAUNCH_VELOCITY_ORIGINAL_CHANGED'; END IF;
 changed:=replace(original,'v_ops bigint; v_op_chips numeric;','v_ops bigint; v_op_chips numeric; v_launch_count bigint; v_launch_mint numeric; v_launch_burn numeric;');
 changed:=replace(changed,'AND NOT o.declared_operator_mint), 0)','AND NOT o.declared_operator_mint AND NOT x.launch_receipt), 0)');
 changed:=replace(changed,'WHERE l.to_type   IN (''system_burn'',''chip_retirement'')), 0)','WHERE l.to_type   IN (''system_burn'',''chip_retirement'') AND NOT x.launch_receipt), 0)');
 changed:=replace(changed,'COALESCE(sum(l.amount) FILTER (WHERE o.declared_operator_mint), 0)','COALESCE(sum(l.amount) FILTER (WHERE o.declared_operator_mint), 0), count(*) FILTER(WHERE x.launch_receipt), COALESCE(sum(l.amount) FILTER(WHERE x.launch_receipt AND l.from_type IN(''issuance_reserve'',''chip_retirement'')),0), COALESCE(sum(l.amount) FILTER(WHERE x.launch_receipt AND l.to_type=''chip_retirement''),0)');
 changed:=replace(changed,'INTO v_mint, v_burn, v_grants, v_grant_chips, v_ops, v_op_chips','INTO v_mint, v_burn, v_grants, v_grant_chips, v_ops, v_op_chips, v_launch_count, v_launch_mint, v_launch_burn');
 changed:=replace(changed,'FROM public.chip_ledger l','FROM public.chip_ledger l CROSS JOIN LATERAL (SELECT public.fn_ca_launch_velocity_receipt(l.id) AS launch_receipt) x');
 changed:=replace(changed,'''operator_mints_counted'', v_ops > 3','''operator_mints_counted'', v_ops > 3, ''declared_launch_receipts_10m'',v_launch_count,''declared_launch_mint_or_restore_chips_10m'',v_launch_mint,''declared_launch_burn_chips_10m'',v_launch_burn');
 changed:=replace(changed,'''burn_10m'', round(v_burn,2)))','''burn_10m'', round(v_burn,2), ''declared_launch_receipts_10m'',v_launch_count,''declared_launch_mint_or_restore_chips_10m'',v_launch_mint,''declared_launch_burn_chips_10m'',v_launch_burn))');
 EXECUTE changed;
END $velocity_owner$;

-- Component: accounting-component/source-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_club_rake_daily_user_apply' AND md5(p.prosrc)='764e982b48283abe0f9b7537f38364e2')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_club_rake_daily_user_apply'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_apply(p_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         (ra.created_at AT TIME ZONE 'UTC')::date,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.id = ANY (p_ids)
     AND ra.club_id IS NOT NULL
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
   GROUP BY 1, 2, 3
  ON CONFLICT (club_id, day, user_id) DO UPDATE
     SET rake_cents = public.ca_club_rake_daily_user.rake_cents + EXCLUDED.rake_cents,
         hands      = public.ca_club_rake_daily_user.hands + EXCLUDED.hands,
         updated_at = now();
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_club_rake_daily_user_rebuild_day' AND md5(p.prosrc)='272a2d51a7673cc5fea0cb613e254464')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_club_rake_daily_user_rebuild_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(p_club_id uuid, p_day date, p_user_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_rows bigint := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_rake_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day
     AND (p_user_id IS NULL OR d.user_id = p_user_id);

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         p_day,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.club_id = p_club_id
     AND ra.created_at >= p_day::timestamptz
     AND ra.created_at <  (p_day + 1)::timestamptz
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
     AND (p_user_id IS NULL OR ra.player_id = p_user_id)
   GROUP BY 1, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_rake_rollup_day' AND md5(p.prosrc)='65727eb0a34be7db566dd971d6030144')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_rake_rollup_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH split AS (
    SELECT a.player_id AS user_id, round(a.rake_amount * 100)::bigint AS cents
      FROM rake_attributions a
     WHERE a.club_id = p_club_id
       AND a.created_at >= v_start AND a.created_at < v_end
       AND a.rake_amount > 0
       AND public.fn_ca_launch_accounting_accepts(a.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=a.rake_record_id))
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_refresh_player_stats' AND md5(p.prosrc)='a096c10af612ed5a6d60deccf8dc05c3')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_refresh_player_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_refresh_player_stats(p_since timestamp with time zone DEFAULT (now() - '7 days'::interval)) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_users integer := 0; v_hands integer := 0; v_try integer;
BEGIN
  CREATE TEMP TABLE _ps ON COMMIT DROP AS
  WITH h AS (
    SELECT hh.id, hh.players, hh.actions, t.club_id
      FROM hand_history hh
      LEFT JOIN tables t ON t.id = hh.table_id
     WHERE hh.created_at >= p_since          -- indexed
       AND public.fn_ca_launch_accounting_accepts(t.club_id,hh.created_at)
       AND hh.players IS NOT NULL
       AND jsonb_typeof(hh.players) = 'array'
  ),
  seats AS (
    SELECT h.id AS hand_id, h.club_id,
           (p->>'seat')::int AS seat,
           (p->>'userId')::uuid AS user_id
      FROM h, jsonb_array_elements(h.players) p
     WHERE p->>'userId' IS NOT NULL AND p->>'seat' IS NOT NULL
  ),
  acts AS (
    SELECT h.id AS hand_id,
           (a->>'seat')::int AS seat,
           bool_or(a->>'action' IN ('call','raise','bet','all_in','allin')) AS vpip,
           bool_or(a->>'action' IN ('raise','bet','all_in','allin')) AS pfr
      FROM h, jsonb_array_elements(h.actions) a
     WHERE jsonb_typeof(h.actions) = 'array'
       AND lower(COALESCE(a->>'stage','')) = 'preflop'
       AND a->>'seat' IS NOT NULL
     GROUP BY 1, 2
  )
  SELECT s.user_id, s.club_id,
         count(*)::int AS hands,
         count(*) FILTER (WHERE COALESCE(ac.vpip,false))::int AS vpip_hands,
         count(*) FILTER (WHERE COALESCE(ac.pfr,false))::int  AS pfr_hands
    FROM seats s
    LEFT JOIN acts ac ON ac.hand_id = s.hand_id AND ac.seat = s.seat
   WHERE s.club_id IS NOT NULL
   GROUP BY s.user_id, s.club_id;

  SELECT count(*), COALESCE(sum(hands),0) INTO v_users, v_hands FROM _ps;

  /* A REFRESH STEPS AROUND A LIVE HAND (2026-10-03). The hourly upsert
     wrote every (user, club) row of the last 90 minutes in one statement, in
     no particular order, while the per-hand writers (the hand_history
     fold-stats trigger and the post-commit projection) update the same
     player_stats rows for the seats of each hand they settle. Two writers
     taking the same rows in different orders deadlock: 2 of the 7 runs to
     03:17 UTC were chosen as the victim ("while inserting index tuple ... in
     relation player_stats"), and the whole hour's refresh rolled back.
     Now the refresh first locks, in key order, only the existing rows no live
     hand is holding (SKIP LOCKED), and writes those plus the rows that do not
     exist yet, in key order. A row a hand holds right now is left to that
     hand and refreshed by the next run, which reads the same 90-minute window
     again. If a deadlock still picks this run (a brand-new key raced by a
     hand), only this block rolls back - releasing what it locked - and it
     tries again, up to three times, before failing as before. */
  FOR v_try IN 1 .. 3 LOOP
    BEGIN
      CREATE TEMP TABLE _ps_locked ON COMMIT DROP AS
        SELECT ps.user_id, ps.club_id
          FROM player_stats ps
          JOIN _ps p ON p.user_id = ps.user_id AND p.club_id = ps.club_id
         ORDER BY ps.user_id, ps.club_id
           FOR UPDATE OF ps SKIP LOCKED;

      INSERT INTO player_stats (user_id, club_id, hands_played, vpip, pfr, updated_at)
      SELECT p.user_id, p.club_id, p.hands,
             round((p.vpip_hands::numeric / NULLIF(p.hands,0)) * 100, 2),
             round((p.pfr_hands::numeric  / NULLIF(p.hands,0)) * 100, 2),
             now()
        FROM _ps p
       WHERE EXISTS (SELECT 1 FROM _ps_locked l
                      WHERE l.user_id = p.user_id AND l.club_id = p.club_id)
          OR NOT EXISTS (SELECT 1 FROM player_stats ps
                          WHERE ps.user_id = p.user_id AND ps.club_id = p.club_id)
       ORDER BY p.user_id, p.club_id
      ON CONFLICT (user_id, club_id) DO UPDATE
         SET hands_played = GREATEST(COALESCE(player_stats.hands_played,0), EXCLUDED.hands_played),
             vpip = EXCLUDED.vpip,
             pfr  = EXCLUDED.pfr,
             updated_at = now();
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_try >= 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('users', v_users, 'hands_counted', v_hands, 'since', p_since);
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_process_cash_accounting_source' AND md5(p.prosrc)='745e3038834a2e955bdadeb2b71b0d2c')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_process_cash_accounting_source'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_process_cash_accounting_source(p_rake_record_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r public.rake_records%ROWTYPE;w public.accounting_cash_source_work%ROWTYPE;
 receipt public.accounting_cash_source_receipts%ROWTYPE; fingerprint text;result jsonb;credits jsonb:='[]';
 status_value text:='accrued';reason_value text;state_value text;detail_value text;scope jsonb;
 player record;club record;week_start date;next_attempt bigint; applied boolean; v_terminal boolean:=false;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR COALESCE(r.is_tournament,false) OR r.tournament_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_source_record_required' USING ERRCODE='22023'; END IF;
 -- Share the existing hand authority. Nothing locks work rows before this.
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN r.hand_id IS NULL THEN 'accounting_cash_source:'||r.id::text
  ELSE 'accounting_cash_hand:'||r.hand_id::text END,0));
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 SELECT md5(jsonb_build_object('id',r.id,'hand',r.hand_id,'club',r.club_id,'rake',r.rake_amount,
  'earned_at',r.created_at,'metadata',r.metadata,'attributions',COALESCE(jsonb_agg(
   jsonb_build_array(a.id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.id),'[]'::jsonb))::text)
  INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=r.id;
 SELECT * INTO w FROM public.accounting_cash_source_work WHERE rake_record_id=r.id;
 IF w.status='accrued' AND w.source_fingerprint=fingerprint THEN
  SELECT * INTO receipt FROM public.accounting_cash_source_receipts WHERE id=w.receipt_id;
  RETURN receipt.result||jsonb_build_object('duplicate',true);
 END IF;
 IF NOT public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) THEN
  RETURN jsonb_build_object('status','waived','recorded',false,'reason','owner_directed_launch_waiver','rake_record_id',r.id,'earned_at',r.created_at);
 END IF;
 next_attempt:=COALESCE(w.attempts,0)+1;
 BEGIN
  IF r.hand_id IS NULL OR NOT isfinite(r.created_at) OR r.rake_amount IS NULL OR r.rake_amount<=0
   OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.rake_amount<>round(r.rake_amount,2)
   OR (SELECT count(*) FROM public.rake_records WHERE hand_id=r.hand_id)<>1 THEN
   RAISE EXCEPTION 'cash_source_identity_or_amount_invalid' USING ERRCODE='23514'; END IF;
  result:=public.fn_accrue_cash_hand_commissions(r.hand_id);
  IF result->>'status'='legacy_unverified' AND result->>'recorded'='true' THEN
   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';v_terminal:=true;
  ELSE
   IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
    OR result->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id=r.id AND status='accrued') THEN
    RAISE EXCEPTION 'cash_source_accrual_receipt_invalid' USING ERRCODE='23514'; END IF;
   week_start:=(public.fn_union_week_start(r.created_at) AT TIME ZONE 'America/Los_Angeles')::date;
   FOR player IN SELECT * FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id,player_id LOOP
    applied:=public.apply_rakeback_player_stats(r.id,player.player_id,player.club_id,1,player.rake_credit);
    IF NOT EXISTS(SELECT 1 FROM public.rakeback_stats_applied a WHERE a.rake_record_id=r.id AND a.user_id=player.player_id
      AND a.hands=1 AND a.rake=player.rake_credit) THEN
     RAISE EXCEPTION 'cash_source_player_stats_receipt_invalid' USING ERRCODE='23514'; END IF;
    credits:=credits||jsonb_build_array(jsonb_build_object('player_id',player.player_id,'club_id',player.club_id,
      'rake_credit',player.rake_credit,'period_start',week_start,'period_end',week_start+6));
   END LOOP;
   IF jsonb_array_length(credits)=0 THEN RAISE EXCEPTION 'cash_source_contributor_receipts_missing' USING ERRCODE='23514'; END IF;
   -- Queue the existing complete-week calculator; do not invent another
   -- calculator or depend on a later hand arriving to repair this source.
   FOR club IN SELECT DISTINCT club_id FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||club.club_id::text||':'||week_start::text,0));
    INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
     VALUES(club.club_id,week_start,week_start+6)
     ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
   END LOOP;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS reason_value=MESSAGE_TEXT,state_value=RETURNED_SQLSTATE,detail_value=PG_EXCEPTION_DETAIL;
  status_value:='blocked';credits:='[]';v_terminal:=false;
 END;
 scope:=public.fn_cash_source_refusal_scope(r.id);
 receipt.id:=gen_random_uuid();
 result:=jsonb_build_object('receipt_version',3,'receipt_id',receipt.id,'rake_record_id',r.id,'hand_id',r.hand_id,
  'earned_at',r.created_at,'status',status_value,'recorded',true,'attempt',next_attempt,
  'source_fingerprint',fingerprint,'reason',reason_value,'sqlstate',state_value,'scope',scope,'credits',credits);
 INSERT INTO public.accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,sqlstate,error_detail,scope,result)
  VALUES(receipt.id,r.id,next_attempt,r.created_at,fingerprint,status_value,reason_value,state_value,detail_value,scope,result);
 INSERT INTO public.accounting_cash_source_work(rake_record_id,receipt_id,source_fingerprint,status,attempts,next_attempt_at)
  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,CASE WHEN v_terminal THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int) END)
  ON CONFLICT(rake_record_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,source_fingerprint=EXCLUDED.source_fingerprint,
   status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at;
 RETURN result;
END $$;

CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH (security_invoker='true') AS
 SELECT 'cash_rake_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    NULL::uuid AS tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    s.contract
   FROM public.accounting_cash_rake_sources s
  WHERE public.fn_ca_launch_accounting_accepts(s.club_id,s.earned_at)
UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    s.tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    rs.recognized_at AS earned_at,
    s.rake_credit,
    s.contract
   FROM ((public.accounting_tournament_fee_sources s
     JOIN public.accounting_tournament_recognized_sources rs ON (((rs.source_id = s.id) AND (rs.tournament_id = s.tournament_id))))
     JOIN public.accounting_tournament_fee_recognitions r ON ((r.tournament_id = s.tournament_id)))
  WHERE public.fn_ca_launch_accounting_accepts(s.club_id,s.charged_at) AND public.fn_ca_launch_accounting_accepts(s.club_id,rs.recognized_at) AND ((rs.disposition = 'earned'::text) AND (r.status = 'recognized'::text) AND (rs.rake_credit = s.rake_credit) AND (rs.recognized_at = r.recognized_at) AND (NOT (s.union_id IS DISTINCT FROM r.union_id)));

-- Component: accounting-component/consumer-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_credit_risk_check' AND md5(p.prosrc)='dfd4be7dcfcb05621538c354cf2d18c0')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_credit_risk_check'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_credit_risk_check() RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_eco_not_recorded', 'warning', count(*),
         'Unions with ECO enabled and no union_eco_ledger row for the settlement '
         || 'week that has CLOSED: that week''s win tax / loss rebate is not reproducible. '
         || 'The ledger is written at close, so the week in progress is not asked about'
    FROM unions un
   WHERE COALESCE((un.settings->>'eco_enabled')::boolean, false)
     AND NOT public.fn_ca_launch_accounting_waived('union',un.id,public.fn_union_week_start())
     AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
     AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                      WHERE l.union_id = un.id
                        AND l.period_start >= fn_union_week_start() - interval '7 days')
     -- A WEEK'S ECO ROW IS WRITTEN AT ITS CLOSE, SO IT IS ASKED FOR ONCE THE
     -- CLOSE IS OWED (2026-10-05). Before the close's run time
     -- (fn_union_accounting_run_at), while an accounting_close_gates row holds
     -- the first attempt for a quiet hour, and while the close is running, the
     -- row cannot exist yet. On 2026-10-05 this filed two ledger_imbalance
     -- incidents at 07:52 for a close gated until 2026-10-06 13:00 by the
     -- coordinator decision of 2026-10-03. A close that is owed and has not
     -- written the row - past its run time, no gate holding it, nothing
     -- running - is still found, and so is a finished close without one.
     -- Migration 20261005113359.
     AND NOT (now() < fn_union_accounting_run_at(fn_union_week_start())
              OR EXISTS (SELECT 1 FROM accounting_close_gates g
                          WHERE g.scope_kind = 'union' AND g.scope_id = un.id
                            AND g.period_end = fn_union_week_start()
                            AND g.gate_until > now()
                            AND NOT EXISTS (SELECT 1 FROM union_accounting_runs r
                                             WHERE r.scope_kind = 'union' AND r.scope_id = un.id
                                               AND r.period_start = g.period_start
                                               AND r.period_end = g.period_end))
              OR EXISTS (SELECT 1 FROM union_accounting_runs q
                          WHERE q.scope_kind = 'union' AND q.scope_id = un.id
                            AND q.period_end = fn_union_week_start()
                            AND q.status = 'running'))
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stakes_above_cap', 'warning', count(*),
         'Live tables above the club''s agreed stakes cap: '
         || COALESCE(string_agg(y.club_name || ' bb=' || y.big_blind
                                || ' cap=' || y.stakes_cap_bb, '; '), '')
    FROM (
      SELECT c.name AS club_name, tb.big_blind, t.stakes_cap_bb
        FROM union_club_terms t
        JOIN clubs c ON c.id = t.club_id
        JOIN tables tb ON tb.club_id = t.club_id
       WHERE t.stakes_cap_bb IS NOT NULL
         AND tb.big_blind > t.stakes_cap_bb
         AND COALESCE(tb.is_deleted, false) = false
         AND tb.status NOT IN ('closed','deleted')
    ) y
  HAVING count(*) > 0

  UNION ALL
  SELECT * FROM fn_anon_exposure_check();
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_governance_check' AND md5(p.prosrc)='b59473f1e8e9691b78a917570de56d9a')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_governance_check'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_governance_check() RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 'club_owned_cash_table_in_union', 'critical', count(*),
         'Open cash tables under a union club with no union_id and not private'
    FROM tables t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.tournament_id IS NULL AND COALESCE(t.is_deleted,false) = false
     AND t.status NOT IN ('closed','deleted')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'club_owned_tournament_in_union', 'critical', count(*),
         'Live non-private tournaments under a union club with no union_id'
    FROM tournaments t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_game_not_owned_by_union', 'critical', count(*),
         'Live union games whose club_id names a member club instead of the union '
         || '(cash/MTT/SNG/Spin)'
    FROM (
      SELECT id FROM tables
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND COALESCE(is_deleted,false) = false AND status NOT IN ('closed','deleted')
      UNION ALL
      SELECT id FROM tournaments
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_lost_a_member_club', 'critical', count(*),
         'Clubs expected in Midway Union that are no longer members'
    FROM (
      SELECT c.id FROM clubs c
       WHERE c.id IN ('a0000000-0000-0000-0000-000000000001',
                      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
         AND NOT EXISTS (SELECT 1 FROM union_clubs uc
                          WHERE uc.club_id = c.id
                            AND uc.union_id = 'fade0000-0000-0000-0000-000000000001')
    ) m
  HAVING count(*) > 0

  UNION ALL
  SELECT 'clubs_union_id_mirror_drift', 'critical', count(*),
         'clubs.union_id disagrees with union_clubs'
    FROM union_clubs uc JOIN clubs c ON c.id = uc.club_id
   WHERE c.union_id IS DISTINCT FROM uc.union_id
  HAVING count(*) > 0

  UNION ALL
  SELECT 'private_game_union_visible', 'critical', count(*),
         'Rows flagged private that still carry a union_id'
    FROM (
      SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
      UNION ALL
      SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'ownership_triggers_missing', 'critical', 5 - count(*),
         'Expected 5 union ownership/mirror triggers'
    FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership',
                    'trg_union_clubs_sync_mirror','trg_tables_union_ownership_upd',
                    'trg_tournaments_union_ownership_upd')
  HAVING count(*) < 5

  UNION ALL
  SELECT 'tables_rls_not_private_aware', 'critical', 1,
         'tables SELECT policy no longer considers is_private'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.tables'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%is_private%')

  UNION ALL
  SELECT 'union_clubs_unreadable_by_members', 'critical', 1,
         'A club member can no longer discover their own union (union_clubs RLS)'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.union_clubs'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%club_members%')

  UNION ALL
  SELECT 'union_rake_wallet_stale', 'warning', count(*),
         'Union rake wallets holding a balance with no rakeback in 14 days'
    FROM union_wallets uw
   WHERE uw.rake_wallet > 0
     AND NOT EXISTS (
       SELECT 1 FROM union_wallet_transactions t
        WHERE t.union_id = uw.union_id AND t.wallet = 'rake_wallet'
          AND t.direction = 'debit' AND t.created_at > now() - interval '14 days')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_needs_review', 'warning', count(*),
         'Player P&L periods parked for review and never re-settled'
    FROM union_pnl_settlements WHERE status = 'needs_review'
     AND NOT public.fn_ca_launch_accounting_waived('union',union_id,period_end)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_period_overdue_open', 'warning', count(*),
         'settlement_periods still open/processing more than 24h past end_at'
    FROM settlement_periods
   WHERE status IN ('open','processing') AND end_at < now() - interval '24 hours'
     AND NOT public.fn_ca_launch_accounting_waived(CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END,COALESCE(union_id,club_id),end_at)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_period_orphan', 'critical', count(*),
         'settlement_periods with NULL club_id AND NULL union_id'
    FROM settlement_periods
   WHERE club_id IS NULL AND union_id IS NULL
  HAVING count(*) > 0

  UNION ALL
  -- 2026-08-20: the rake rollup is a speed cache only (a stale day is
  -- recomputed live), so this is a WARNING, not a correctness alarm: it means
  -- the settlement will do that work inline while holding treasury locks.
  SELECT 'union_rake_rollup_unmaintained', 'warning', count(*),
         'Unions with 3+ missing rake rollup days in the last week - the '
         || 'weekly settlement would recompute them while holding treasury locks'
    FROM (
      SELECT un.id,
             (SELECT count(*)
                FROM generate_series((now() AT TIME ZONE 'UTC')::date - 7,
                                     (now() AT TIME ZONE 'UTC')::date - 1,
                                     interval '1 day') gs
               WHERE NOT EXISTS (SELECT 1 FROM union_rake_rollup_days rd
                                  WHERE rd.union_id = un.id
                                    AND rd.day = gs::date)) AS stale_days
        FROM unions un
       WHERE EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
    ) s
   WHERE s.stale_days >= 3
  HAVING count(*) > 0

  UNION ALL
  SELECT * FROM fn_union_credit_risk_check()
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_club_invoice' AND md5(p.prosrc)='9b7688577f1dee71e46044d886aa81df')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_club_invoice'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_club_invoice(p_union_id uuid, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(club_id uuid, club_name text, period_start timestamp with time zone, period_end timestamp with time zone, rake_generated numeric, union_fee_kept numeric, rakeback_due numeric, players_won numeric, player_pnl_net numeric, eco_amount numeric, eco_enabled boolean, presettled numeric, settled_in_chips numeric, outstanding numeric, net_position numeric, direction text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
BEGIN
  v_start:=public.fn_ca_launch_accounting_start('union',p_union_id,v_start);
  IF v_start>=v_end THEN RETURN; END IF;
  RETURN QUERY
  WITH eco AS (
    SELECT e.club_id, e.club_name, e.players_won, e.rake_generated,
           e.rake_earned, e.eco_base, e.eco_amount, e.eco_enabled
      FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e
  ),
  recorded AS (
    /* THE DOCUMENT QUOTES THE RECORD (2026-09-21). fn_union_eco_adjustment is
       a VOLATILE recomputation of the whole week; fn_union_eco_record wrote
       its answer to union_eco_ledger earlier in this same settlement, and a
       second recomputation is a second answer. On 2026-09-14 that cost club
       a41434bb 1.21 of overstated debt on an invoice whose other three
       figures matched the ledger exactly. Read what was recorded. */
    SELECT l.club_id, l.eco_amount
      FROM union_eco_ledger l
     WHERE l.union_id = p_union_id
       AND l.period_start = v_start
       AND l.period_end   = v_end
  ),
  pre AS (
    -- Unapplied cash held against the running balance. Closed out by
    -- applied_settlement_id, never by age: a payment made during a week that
    -- did not settle must still reach the club's next statement.
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at < v_end
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    /* Phase 6 (20260907): rakeback_due IS round 1's payout for the club - the
       same fn_union_club_rake_basis rows, per game type, truncated to the
       cent - not a flat rate applied to a different rake total. */
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated - eco.rake_earned, 2) AS union_fee_kept,
           eco.rake_earned                                AS rakeback_due,
           eco.players_won,
           round(eco.players_won + eco.rake_generated, 2) AS player_pnl_net,
           /* The recorded ECO when the settlement has recorded one; the live
              figure only for the read-only preview of a week that has not
              been settled yet, which has no record to quote. */
           CASE WHEN eco.eco_enabled
                  THEN COALESCE(rec.eco_amount, eco.eco_amount)
                ELSE 0 END AS eco_amount,
           eco.eco_enabled,
           COALESCE(pre.amt, 0) AS presettled
      FROM eco
      LEFT JOIN recorded rec ON rec.club_id = eco.club_id
      LEFT JOIN pre          ON pre.club_id = eco.club_id
  )
  SELECT calc.club_id, calc.club_name, v_start, v_end,
         calc.rake_generated, calc.union_fee_kept, calc.rakeback_due,
         calc.players_won, calc.player_pnl_net,
         calc.eco_amount, calc.eco_enabled, calc.presettled,
         round(calc.player_pnl_net + calc.rakeback_due, 2) AS settled_in_chips,
         round(calc.eco_amount + calc.presettled, 2)       AS outstanding,
         round(calc.player_pnl_net + calc.rakeback_due
               + calc.eco_amount + calc.presettled, 2)     AS net_position,
         CASE WHEN round(calc.eco_amount + calc.presettled, 2) > 0
                THEN 'union owes club'
              WHEN round(calc.eco_amount + calc.presettled, 2) < 0
                THEN 'club owes union'
              ELSE 'square' END::text
    FROM calc
   ORDER BY calc.club_name;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_settlement_cascade' AND md5(p.prosrc)='99c6569b985e5827978d52dbb312a272')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_settlement_cascade'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_preparation jsonb; v_credit_club record;
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_club_statements jsonb; v_previous_validated text;
  v_sqlstate text; v_msg text; v_detail text; v_context text;
  v_pending jsonb; v_posted record;
  -- CHUNKED CLOSE (20261003): set by job 272's tick; see
  -- fn_process_weekly_accounting_scope. Off, this function is unchanged.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked', true), '') = 'on';

BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  IF public.fn_ca_launch_accounting_waived('union',p_union_id,v_to) THEN
    RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver','union_id',p_union_id,'period_start',v_from,'period_end',v_to);
  END IF;
  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.'))::text;
  END IF;

  /* WARM THE CACHE BEFORE THE FIRST LOCK (2026-09-09). union_rake_rollup_days
     is a speed cache: a day that is missing is recomputed live and correct,
     but it is recomputed INSIDE the settlement, while it holds treasury rows -
     which is where this union has been deadlocking. Doing it here costs the
     same work at a moment when nothing is locked. A failure is not fatal:
     the live path still answers, just more slowly. */
  BEGIN
    PERFORM public.fn_union_rake_rollup_refresh_day(p_union_id, g.d::date)
       FROM generate_series(v_from::date, (v_to - interval '1 day')::date, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                         WHERE rd.union_id = p_union_id AND rd.day = g.d::date)
        AND g.d::date < (now() AT TIME ZONE 'UTC')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'settlement could not warm the rake rollup (%); the live path will answer instead', SQLERRM;
  END;

  IF v_from IS NULL OR NOT isfinite(v_from) OR v_from<>public.fn_union_week_start(v_from)
   OR v_to IS DISTINCT FROM public.fn_union_week_start(v_from+interval '8 days') THEN
   RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023';
  END IF;
  PERFORM public.fn_union_pnl_closed_book_barrier(v_to);
  -- Serialize every entry point for this union/period. A replay must read
  -- the receipts after the competing transaction commits, before moving chips.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'union-accounting:' || p_union_id::text || ':' || extract(epoch FROM v_from)::text || ':' || extract(epoch FROM v_to)::text, 0));

  -- A union-owned table is not a player's earning club. These outstanding
  -- records are invisible to the member-club join in Round 3. Never certify
  -- completion while they exist, and never guess a replacement beneficiary.
  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
       WHERE rp.club_id = p_union_id AND rp.status = 'pending'
         AND rp.rakeback_amount > 0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_to
         AND ((rp.period_end + 1)::timestamp AT TIME ZONE 'UTC') > v_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_rakeback_wrong_club',
      DETAIL = 'Pending player rakeback is booked under the union ID. Reconcile the earning-club evidence before settlement.';
  END IF;

  -- THE UNION WALLET IS DEBITED LAST (20260929): round 1 leaves its rake
  -- wallet debit pending for this exact book; it is posted below, after the
  -- statements, so live hands are never queued behind the close.
  -- CHUNKED CLOSE (20261003): a round that commits in its own transaction
  -- posts its own union wallet debit (round 1's original undeferred path):
  -- a pending debit is a transaction-local setting and cannot outlive it.
  PERFORM set_config('app.union_close_defer_rake_debit', CASE WHEN v_chunked THEN '' ELSE p_union_id::text || ':'
    || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END, true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  PERFORM public.fn_assert_cash_commission_period(p_union_id,NULL,v_from,v_to);
  v_preparation:=public.fn_prepare_accounting_week(p_union_id,NULL,v_from,v_to);
  IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
  END IF;
  PERFORM public.fn_weekly_accounting_deadline_check();
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;

  -- CHUNKED CLOSE (20261003): a round that moved money ends this attempt
  -- here; it commits with its receipts (union_rakeback_log, the final
  -- ca_settlements row, union_settlement_rounds round 1) and the next attempt
  -- skips it by them ('already_executed'). Nothing after this point - no
  -- period is marked settled, no statement or square-up is issued - until
  -- the attempt that finds every round committed.
  IF v_chunked AND v_r1->>'success' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 1,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1);
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  PERFORM public.fn_weekly_accounting_deadline_check();
  -- CHUNKED CLOSE (20261003): a round 2 an earlier attempt committed is
  -- answered from its own receipt - exactly what the stage returns for it
  -- as a duplicate - instead of reading the whole week again to prove it.
  -- Every attempt has first re-run the book's barrier, accrual, refusal and
  -- preparation checks, under which no source of this closed week can change.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r2 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=2;
  END IF;
  IF v_r2 IS NULL THEN
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  END IF;
  IF v_r2->>'routing_version' IS DISTINCT FROM '3'
    OR v_r2->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
      WHERE r.union_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=2
       AND r.result=(v_r2-'duplicate')) THEN
    RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';
  END IF;
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Round 2 carries no 'success' key: it raises on error and returns
  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for
  -- 'success' would be unreachable. Assert the CONTRACT instead - a round that
  -- stops reporting an amount must stop the cascade, not record 0 and carry on.
  IF (v_r2->>'amount') IS NULL OR (v_r2->>'payees') IS NULL
     OR (v_r2->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r2->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;

  -- CHUNKED CLOSE (20261003): round 2 commits on its own only with no
  -- shortfall, exactly what the unchunked close would have kept; the next
  -- attempt finds its receipt (accounting_routed_settlement_runs round 2)
  -- and the stage returns it as a duplicate.
  IF v_chunked AND v_r2->>'duplicate' IS DISTINCT FROM 'true' THEN
    IF (v_r2->>'shortfalls')::numeric <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
        'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
        'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2))::text;
    END IF;
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 2,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2);
  END IF;

  -- ROUND 3 - agents pay their players.
  PERFORM public.fn_weekly_accounting_deadline_check();
  -- CHUNKED CLOSE (20261003): the same for a committed round 3.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r3 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=3;
  END IF;
  IF v_r3 IS NULL THEN
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  END IF;
  -- CHUNKED CLOSE (20261003, round 3 in batches): a batch that paid part of
  -- round 3 ends this attempt as a committed step; the next attempt pays on.
  IF v_chunked AND v_r3->>'batch_committed' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3, 'stage', 'round3_batch',
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to, 'round3_batch', v_r3);
  END IF;
  IF v_r3->>'routing_version' IS DISTINCT FROM '3'
    OR v_r3->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
      WHERE r.union_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=3
       AND r.result=(v_r3-'duplicate')) THEN
    RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';
  END IF;
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r3->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.'))::text;
  END IF;

  -- A round can post funded recipients while reporting others still unpaid.
  -- Keep that durable progress, but do not mark the period settled or issue
  -- completion statements until every reported shortfall is zero.
  IF (v_r2->>'shortfalls')::numeric <> 0
     OR (v_r3->>'shortfalls')::numeric <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
      'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3))::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
      JOIN public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) uc ON uc.club_id=rp.club_id
      WHERE rp.status='pending' AND rp.rakeback_amount>0
        AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
        AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_player_obligations_remaining';
  END IF;

  -- CONSERVATION, asserted before anything else is written. Raises on a
  -- breach, which rolls this union's whole settlement back.
  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);

  -- CHUNKED CLOSE (20261003): round 3 commits on its own only after every
  -- test the unchunked close applies to it - no shortfall, no pending player
  -- period, conservation asserted - and the attempt that finds all three
  -- rounds committed repeats those tests before it settles the period.
  IF v_chunked AND v_r3->>'duplicate' IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3);
  END IF;

  -- The period is an accounting object, not a by-product of invoicing.
  PERFORM public.fn_mark_scope_accounting_settled('union',p_union_id,v_from,v_to);

  IF public.fn_union_pnl_qualified_clubs(p_union_id,v_from,v_to)#>>'{eco_commercial_terms_evidence,segments,0,terms,eco_enabled}'='true' THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF v_eco->>'success' = 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_eco_record_failed', DETAIL = v_eco::text;
  END IF;

  PERFORM public.fn_weekly_accounting_deadline_check();
  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: the union setting weekly_invoices_enabled is 0. '
                || 'Since Phase 6 (20260907) the statement reads the same fn_union_club_rake_basis '
                || 'rows round 1 pays on; switching statements back on is a setting, not a fix.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=EXCLUDED.detail,payees=EXCLUDED.payees;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv))::text;
  END IF;

  IF COALESCE((v_inv->>'skipped')::boolean, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_invoices_not_issued', DETAIL = v_inv::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) uc
    WHERE uc.club_id<>p_union_id
      AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
        WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
          AND si.breakdown->>'union_id'=p_union_id::text
          AND (si.breakdown->>'period_start')::timestamptz=v_from
          AND (si.breakdown->>'period_end')::timestamptz=v_to
          AND si.message_sent=true AND si.status<>'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;

  -- THE SQUARE-UP'S OWN PERIOD SETTLES WITH ITS WEEK (2026-10-08). The
  -- settler above ran before round 4, and the square-up then opened the
  -- union's own club row (clubs.id = union id) as 'processing', so that one
  -- period never settled (cc6c056b, week of 2026-09-28). Settle every period
  -- this week opened once more, now that the last opener has run, and prove it.
  PERFORM public.fn_mark_scope_accounting_settled('union',p_union_id,v_from,v_to);
  IF EXISTS (SELECT 1 FROM public.settlement_periods sp
              WHERE sp.union_id=p_union_id AND sp.start_at=v_from AND sp.end_at=v_to
                AND sp.status NOT IN ('settled','closed')) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='union_week_period_left_unsettled';
  END IF;

  PERFORM public.fn_weekly_accounting_deadline_check();
  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP
    PERFORM public.fn_generate_scope_credit_invoices(v_credit_club.club_id,v_from,v_to);
  END LOOP;
  v_previous_validated:=current_setting('app.union_accounting_validated_period',true);
  PERFORM set_config('app.union_accounting_validated_period',p_union_id::text||':'||v_from::text||':'||v_to::text,true);
  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM public.fn_weekly_accounting_deadline_check();
  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  v_pending := NULLIF(current_setting('app.union_close_pending_rake_debit', true), '')::jsonb;
  PERFORM set_config('app.union_close_defer_rake_debit', '', true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);
  IF v_r1->>'success' = 'true' AND COALESCE((v_r1->>'period_rake')::numeric, 0) > 0 AND (v_pending IS NULL OR v_pending->>'settlement_id' IS DISTINCT FROM v_r1->>'settlement_id') THEN
    RAISE EXCEPTION 'union_close_rake_debit_not_pending' USING ERRCODE='55000';
  END IF;
  IF v_pending IS NOT NULL THEN
    IF v_r1->>'success' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'union_close_rake_debit_without_round1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_posted FROM public.fn_union_close_post_rake_debit(v_pending);
    v_r1 := v_r1 || jsonb_build_object('rake_wallet_after', v_posted.rw_after, 'chip_balance_after', v_posted.cb_after,
      'rake_debit_posted', 'last_write_of_cascade');
  END IF;
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'club_weekly_statements',v_club_statements,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_weekly_rakeback_close' AND md5(p.prosrc)='721a8450335861b423e29770a60e64b7')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_weekly_rakeback_close'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_source_plan jsonb; v_ledger_id uuid; v_prior_context jsonb; context_key text;
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_rw_before    numeric;
  v_cb_before    numeric;
  v_clubs_before numeric := 0;
  v_clubs_after  numeric := 0;
  v_credit       jsonb;
  v_sref         text;
  v_sid          uuid;
  v_sstate       text;
  v_actor        uuid;
  v_pending      jsonb;
  v_deferred     boolean := false;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF public.fn_ca_launch_accounting_waived('union',p_union_id,p_period_end) THEN
    RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
  END IF;
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id
                AND p_period_start < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor');
  END IF;

  -- Every entry point uses the union's calendar, including DST boundaries.
  IF p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end <> public.fn_union_week_start(p_period_end)
     OR p_period_end <> public.fn_union_week_start(p_period_start+interval '8 days')
     OR p_period_end > public.fn_union_week_start(now()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed_union_weeks');
  END IF;

  -- Accrual and bank producers acquire this exact scope before writing.
  PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'
    ||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  -- settlement walk: one row per (union, period), resumable after 'failed'
  v_sref := p_union_id::text || ':'
    || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT id, state INTO v_sid, v_sstate
    FROM ca_settlements
   WHERE settlement_type = 'union_rakeback_close' AND external_ref = v_sref
   FOR UPDATE;
  IF v_sid IS NULL THEN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, union_id, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close', v_sref, 'open', p_union_id, '{}'::jsonb)
    RETURNING id INTO v_sid;
  ELSIF v_sstate = 'final' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed', 'settlement_id', v_sid);
  ELSIF v_sstate = 'failed' THEN
    UPDATE ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_sid;  -- resume
  ELSE
    -- intermediate states never persist (single transaction), so anything
    -- else here is a concurrent close of the same period. Refuse loudly.
    RETURN jsonb_build_object('success', false, 'error', 'close_already_in_state_' || v_sstate,
                              'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;

  -- LIVE CONTENTION (20260929): read, never lock. Every hand of this union
  -- credits this row; the debit below takes its lock at the last moment.
  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id;
  IF v_wallet.union_id IS NULL THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'no_wallet' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet', 'settlement_id', v_sid);
  END IF;

  -- Recheck after the union wallet lock: concurrent overlapping closes cannot
  -- both consume the same rake credits under different period identities.
  IF EXISTS (SELECT 1 FROM public.union_rakeback_log l
              WHERE l.union_id = p_union_id
                AND l.period_start < p_period_end AND l.period_end > p_period_start) THEN
    UPDATE public.ca_settlements SET state = 'failed', error_detail = 'overlapping_closed_period' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'overlapping_closed_period', 'settlement_id', v_sid);
  END IF;

  BEGIN
    PERFORM 1 FROM public.union_wallet_transactions t WHERE t.union_id=p_union_id
      AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
      AND t.created_at>=p_period_start AND t.created_at<p_period_end ORDER BY t.id FOR SHARE;
    v_source_plan:=public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.ca_settlements SET state='failed',error_detail=left(SQLERRM,2000) WHERE id=v_sid;
    RETURN jsonb_build_object('success',false,'error','union_earning_source_not_certified','detail',SQLERRM,'settlement_id',v_sid);
  END;

  /* THE PERIOD (unchanged): everything the rake treasury received. Each credit
     now also carries the GAME TYPE it came from: the named tournament's
     tournament_type, or cash when it names none. */
  DROP TABLE IF EXISTS _uwrb_credits;
  CREATE TEMP TABLE _uwrb_credits ON COMMIT DROP AS
  WITH raw AS (
    SELECT t.id, t.amount, t.notes, t.created_at,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_period_start AND t.created_at < p_period_end
  )
  SELECT r.id, r.amount, r.notes, r.created_at, r.tournament_id,
         CASE WHEN r.tournament_id IS NULL THEN 'cash'
              ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
    FROM raw r
    LEFT JOIN tournaments tr ON tr.id = r.tournament_id;

  DROP TABLE IF EXISTS _uwrb_by_type;
  /* THE BASIS (Dan, 2026-09-03) lives in fn_union_club_rake_basis since
     Phase 6 (20260907): the statement and the reconciliation report read
     the same function, so what is paid and what is described cannot
     diverge. The block that used to be here is that function, verbatim. */
  CREATE TEMP TABLE _uwrb_by_type ON COMMIT DROP AS
  SELECT b.club_id, b.game_type, b.rake_in, b.rate, b.payout
    FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true) b;

  /* The per-club roll-up the money section pays from. */
  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT club_id,
         round(sum(rake_in), 2) AS rake_in,
         round(sum(payout), 2)  AS payout
    FROM _uwrb_by_type
   GROUP BY club_id;

  SELECT round(COALESCE(SUM(amount), 0), 2) INTO v_period_total FROM _uwrb_credits;
  SELECT round(COALESCE(SUM(payout), 0), 2) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;
  IF v_period_total IS DISTINCT FROM (v_source_plan->>'period_rake')::numeric THEN
    RAISE EXCEPTION 'union_rake_bank_changed_during_close' USING ERRCODE='55000';
  END IF;
  v_retained := round(v_period_total - v_payout_total, 2);

  /* a share can never exceed what the treasury received: the attribution is
     a view of the same credits, so this only trips on a data fault */
  IF v_payout_total > v_period_total THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'attribution_exceeds_treasury' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'attribution_exceeds_treasury',
      'period_rake', v_period_total, 'payout', v_payout_total, 'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements
     SET state = 'calculated',
         totals = jsonb_build_object('period_rake', v_period_total, 'payout_total', v_payout_total,
                                     'retained', v_retained,
                                     'basis', 'immutable_earned_sources_matched_to_bank',
                                     'accounting_version',3,
                                     'source_fingerprint',v_source_plan->'source_fingerprint',
                                     'house_rake',v_source_plan->'house_rake',
                                     'rate_model', 'observed_per_source_truncated_per_club_game',
                                     'basis_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, rake_in), '{}'::jsonb) FROM _uwrb),
                                     'payout_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, payout), '{}'::jsonb) FROM _uwrb),
                                     'basis_detail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'game_type', game_type, 'rake_in', rake_in, 'rate', rate, 'payout', payout) ORDER BY club_id, game_type), '[]'::jsonb) FROM _uwrb_by_type),
                                     'basis_by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type, x), '{}'::jsonb)
                                                              FROM (SELECT game_type,
                                                                           jsonb_build_object('basis', round(sum(rake_in), 2),
                                                                                              'payout', round(sum(payout), 2)) AS x
                                                                      FROM _uwrb_by_type GROUP BY game_type) g),
                                     'rates', (SELECT COALESCE(jsonb_object_agg(club_id::text || ':' || game_type, rate), '{}'::jsonb)
                                                 FROM _uwrb_by_type))
   WHERE id = v_sid;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake',
      'settlement_id', v_sid);
  END IF;

  /* SEPARATE POTS (Phase 2.1). The rake treasury owes the whole period: the
     clubs' share leaves it as rakeback, the union's share leaves it for the
     general bank. The general bank is never a source. A treasury that cannot
     cover the period refuses the close whole - never partial, never from the
     bank - and says so. Who eats a short treasury is Dan's ruling
     (roadmap decision 4). */
  IF v_period_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'insufficient_rake_treasury' WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-insufficient:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      v_period_total - COALESCE(v_wallet.rake_wallet, 0),
      v_period_total,
      COALESCE(v_wallet.rake_wallet, 0),
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      'union rake treasury cannot cover the period it owes; close refused before any movement (the general bank is never a source)',
      true,
      jsonb_build_object('rake_wallet', v_wallet.rake_wallet,
                         'chip_balance', v_wallet.chip_balance,
                         'period_total', v_period_total,
                         'payout', v_payout_total, 'retained', v_retained,
                         'period_start', p_period_start, 'period_end', p_period_end));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_rake_treasury', 'retryable', true,
      'period_rake', v_period_total, 'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance,
      'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;

  SELECT jsonb_object_agg(k,current_setting(k,true)) INTO v_prior_context FROM unnest(ARRAY[
    'app.ledger_autoskip_clubs','app.ledger_autoskip_union_wallets','app.ledger_category',
    'app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_settlement'])k;
  -- guarded money section: all of it lands, or none of it does
  BEGIN
    /* One declaration for every balance write below. The union_wallets
       auto-ledger is skipped: the union side of each club credit is the
       from-leg of the club's own row, and the retained share is written
       explicitly. */
    PERFORM public.fn_ca_declare_ledger('rakeback', 'union_wallet', p_union_id, v_sid, NULL,
                                        ARRAY['union_wallets','clubs']);
    v_actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    v_rw_before := round(COALESCE(v_wallet.rake_wallet, 0), 2);
    v_cb_before := round(COALESCE(v_wallet.chip_balance, 0), 2);
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_before
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    FOR v_club IN
      SELECT club_id, rake_in, payout FROM _uwrb
       WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0 ORDER BY club_id
    LOOP
      v_credit := fn_credit_treasury(
        v_club.club_id, v_club.payout,
        'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
          || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
        jsonb_build_object('union_id', p_union_id,
                           'period_start', p_period_start, 'period_end', p_period_end,
                           'rake_basis', v_club.rake_in, 'rate', 'per_game_type',
                           'by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type,
                                                     jsonb_build_object('basis', rake_in, 'rate', rate, 'payout', payout)), '{}'::jsonb)
                                              FROM _uwrb_by_type g WHERE g.club_id = v_club.club_id),
                           'settlement_id', v_sid),
        'union_close:' || v_sid::text || ':' || v_club.club_id::text
      );
      IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
      END IF;
      -- The earning union is explicit even if the club has since left or
      -- joined another union. Do not derive this journal scope from the club's
      -- current union_id via its generic balance trigger.
      INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,
        club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance,from_label)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',v_club.club_id,v_club.payout,'rakeback',
        v_club.club_id,p_union_id,'Union weekly rakeback from recorded earnings',
        'union_close:'||v_sid::text||':'||v_club.club_id::text,
        jsonb_build_object('settlement_id',v_sid,'period_start',p_period_start,'period_end',p_period_end,
          'rake_basis',v_club.rake_in,'accounting_version',3,'source_fingerprint',v_source_plan->'source_fingerprint'),
        (v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric,'union_wallets.rake_wallet') RETURNING id INTO v_ledger_id;
      IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
        AND i.net_amount=v_club.payout AND i.chips_transferred AND i.message_sent
        AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
        RAISE EXCEPTION 'union_close_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
      v_clubs_paid := v_clubs_paid + 1;
    END LOOP;

    -- THE UNION WALLET DEBIT (20260929): one guarded update in
    -- fn_union_close_post_rake_debit. Inside the weekly cascade it is posted as
    -- the cascade's last write, so the row every hand credits is held only
    -- from then to commit; called on its own, it is posted here, as before.
    v_pending := jsonb_build_object('union_id', p_union_id, 'settlement_id', v_sid,
      'period_start', p_period_start, 'period_end', p_period_end,
      'period_total', v_period_total, 'payout_total', v_payout_total, 'retained', v_retained,
      'clubs_paid', v_clubs_paid, 'actor', v_actor,
      'clubs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'payout', payout) ORDER BY club_id), '[]'::jsonb)
                  FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0));
    IF current_setting('app.union_close_defer_rake_debit', true) = v_sref THEN
      IF NULLIF(current_setting('app.union_close_pending_rake_debit', true), '') IS NOT NULL THEN
        RAISE EXCEPTION 'union_close_rake_debit_already_pending' USING ERRCODE='55000';
      END IF;
      PERFORM set_config('app.union_close_pending_rake_debit', v_pending::text, true);
      v_deferred := true;
      -- the union side is proved when it posts; the clubs side is proved below
      v_rw_before := 0; v_new_rw := -v_period_total; v_cb_before := 0; v_new_cb := v_retained;
    ELSE
      SELECT d.rw_before, d.rw_after, d.cb_before, d.cb_after INTO v_rw_before, v_new_rw, v_cb_before, v_new_cb
        FROM public.fn_union_close_post_rake_debit(v_pending) d;
    END IF;

    /* CONSERVATION, ASSERTED ON THE BALANCES THEMSELVES (not on the plan).
       What left the treasury must equal what the clubs and the bank received,
       to the cent, or none of it lands. */
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_after
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    IF round((v_new_rw - v_rw_before) + (v_new_cb - v_cb_before) + (v_clubs_after - v_clubs_before), 2) <> 0
       OR round(v_new_rw - v_rw_before, 2) <> round(-v_period_total, 2)
       OR round(v_clubs_after - v_clubs_before, 2) <> round(v_payout_total, 2)
       OR round(v_new_cb - v_cb_before, 2) <> round(v_retained, 2) THEN
      RAISE EXCEPTION 'conservation violation in the weekly union close: treasury % -> %, bank % -> %, clubs % -> %, period % payout % retained %',
        v_rw_before, v_new_rw, v_cb_before, v_new_cb, v_clubs_before, v_clubs_after,
        v_period_total, v_payout_total, v_retained;
    END IF;

    IF v_deferred THEN v_new_rw := NULL; v_new_cb := NULL; END IF;
    UPDATE ca_settlements
       SET state = 'ledger_posted',
           totals = totals || jsonb_build_object('clubs_paid', v_clubs_paid,
                                                 'retained', v_retained,
                                                 'rw_debit', v_period_total,
                                                 'conservation', 'asserted')
     WHERE id = v_sid;

    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  EXCEPTION WHEN OTHERS THEN
    -- every money movement above just rolled back to the section start
    UPDATE ca_settlements
       SET state = 'failed', error_detail = left(SQLERRM, 2000)
     WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-close-failed:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      0, NULL, NULL,
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      left('weekly rakeback close aborted mid-flight and rolled back cleanly: ' || SQLERRM, 500),
      true,
      jsonb_build_object('sqlstate', SQLSTATE,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'clubs_paid_before_abort', v_clubs_paid));
    RETURN jsonb_build_object('success', false, 'error', 'close_failed', 'retryable', true,
      'detail', SQLERRM, 'settlement_id', v_sid);
  END;

  FOR context_key IN SELECT jsonb_object_keys(v_prior_context) LOOP
    PERFORM set_config(context_key,COALESCE(v_prior_context->>context_key,''),true);
  END LOOP;
  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'retained_to_bank', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb,
    'conservation', 'asserted',
    'settlement_id', v_sid);
END
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_settle_player_pnl' AND md5(p.prosrc)='51ee8a629fc463f804f8115d0d71a453')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_settle_player_pnl'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_dry_run boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_settlement_id uuid; v_prev jsonb; r record;
  v_results jsonb := '[]'::jsonb;
  v_collect_total numeric := 0; v_pay_total numeric := 0; v_unpaid_total numeric := 0;
  v_treasury numeric; v_take numeric; v_union_balance numeric; v_pay numeric; v_owed numeric;
  v_period_id uuid; v_scale numeric := 1; v_winners_total numeric := 0; v_residual numeric := 0;
  v_ca_id uuid; v_ca_state text; v_walk boolean := false;
  v_expected_balance numeric; v_err text;
  v_existing record; v_floor timestamptz; v_needed numeric; v_initial_union numeric;
  v_prior_ledger jsonb; v_receipt_count int;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_arguments');
  END IF;
  IF NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end <= p_start OR p_end>now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
  END IF;

  IF public.fn_ca_launch_accounting_waived('union',p_union_id,p_end) THEN
    RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
  END IF;
  SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor WHERE union_id=p_union_id;
  IF v_floor IS NOT NULL AND p_start<v_floor THEN
    RETURN jsonb_build_object('success',false,'error','before_settlement_floor','settlement_floor',v_floor);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id) THEN
    RETURN jsonb_build_object('success',false,'error','unknown_union');
  END IF;
  PERFORM public.fn_union_pnl_closed_book_barrier(p_end);
  -- Share the weekly scope lock, then serialize overlapping P&L callers for this union.
  PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_start)::text||':'||extract(epoch FROM p_end)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('union-player-pnl:'||p_union_id::text,0));
  -- Preview, replay and payment share one quality gate after original auth,
  -- window/floor validation and scope locks. No historical record is changed.
  PERFORM public.fn_require_union_pnl_evidence(p_union_id,p_start,p_end);
  SELECT * INTO v_existing FROM public.union_pnl_settlements
   WHERE union_id=p_union_id AND status IN('settled','in_progress')
    AND period_start<p_end AND period_end>p_start
   ORDER BY period_start,id LIMIT 1 FOR UPDATE;
  IF FOUND AND NOT p_dry_run THEN
    IF v_existing.period_start=p_start AND v_existing.period_end=p_end
      AND v_existing.status='settled' AND v_existing.total_unpaid=0
      AND v_existing.total_collected>=0 AND v_existing.total_paid>=0 THEN
      RETURN jsonb_build_object('success',true,'already_settled',true,'settlement_id',v_existing.id,
       'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
       'total_collected',v_existing.total_collected,'total_paid',v_existing.total_paid,'total_unpaid',0);
    END IF;
    RETURN jsonb_build_object('success',false,'error',CASE
      WHEN v_existing.status='settled' AND v_existing.total_unpaid IS DISTINCT FROM 0 THEN 'legacy_partial_pnl_requires_reconciliation'
      WHEN v_existing.status='in_progress' THEN 'pnl_claim_requires_reconciliation'
      ELSE 'pnl_period_overlap' END,'settlement_id',v_existing.id,
      'existing_period_start',v_existing.period_start,'existing_period_end',v_existing.period_end,
      'total_unpaid',v_existing.total_unpaid);
  END IF;

  -- These rows already reconcile accepted outcomes, original cash flows,
  -- exact boundary holdings, tournament deferral and the one rake basis.
  v_prev:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
  CREATE TEMP TABLE IF NOT EXISTS _pnl_tmp (
    club_id uuid PRIMARY KEY,net numeric,seated numeric,detail jsonb,opening_treasury numeric) ON COMMIT DROP;
  DELETE FROM pg_temp._pnl_tmp WHERE true;
  INSERT INTO pg_temp._pnl_tmp(club_id,net,seated,detail)
  SELECT (x->>'club_id')::uuid,(x->>'net')::numeric,(x->>'seated_end')::numeric,x
  FROM jsonb_array_elements(v_prev->'clubs') x;

  SELECT COALESCE(round(SUM(net), 2), 0) INTO v_residual FROM pg_temp._pnl_tmp;

  IF p_dry_run THEN
    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM pg_temp._pnl_tmp;
    RETURN jsonb_build_object('success', true, 'dry_run', true, 'union_id', p_union_id,
      'house_residual', v_residual, 'imbalance', v_residual,
      'clubs', COALESCE(v_results, '[]'::jsonb));
  END IF;

  IF NOT EXISTS(SELECT 1 FROM pg_temp._pnl_tmp) THEN
    RETURN jsonb_build_object('success',false,'error','pnl_no_club_basis');
  END IF;
  IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE net IS NULL OR net::text IN('NaN','Infinity','-Infinity') OR net<>round(net,2)) THEN
    RETURN jsonb_build_object('success',false,'error','pnl_invalid_basis');
  END IF;
  -- A final or advanced state with no matching fully-paid claim cannot be replayed.
  SELECT id,state INTO v_ca_id,v_ca_state FROM public.ca_settlements
   WHERE settlement_type='union_player_pnl'
    AND (idempotency_key='pnl:'||p_union_id::text||':'||extract(epoch FROM p_start)::bigint
      OR external_ref=p_union_id::text||':'||to_char(p_start,'YYYY-MM-DD"T"HH24:MI:SSOF'))
   ORDER BY id LIMIT 1 FOR UPDATE;
  IF FOUND AND v_ca_state NOT IN('failed','open') THEN
    RETURN jsonb_build_object('success',false,'error','pnl_journal_requires_reconciliation','journal_id',v_ca_id,'state',v_ca_state);
  END IF;
  v_ca_id:=NULL; v_ca_state:=NULL;
  UPDATE union_pnl_settlements SET status = 'superseded' 
   WHERE union_id = p_union_id AND period_start = p_start AND status = 'needs_review';

  BEGIN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status)
    VALUES (p_union_id, p_start, p_end, 'in_progress') RETURNING id INTO v_settlement_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success',false,'error','pnl_claim_conflict','union_id',p_union_id,'period_start',p_start);
  END;

  -- ZERO-DRIFT phase 3: register on the settlement state machine (resume a
  -- prior failed run; leave an unexpected 'final' row untouched).
  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, union_id, idempotency_key)
  VALUES ('union_player_pnl', p_union_id::text || ':' || to_char(p_start, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
          'open', p_union_id, 'pnl:' || p_union_id::text || ':' || extract(epoch from p_start)::bigint)
  ON CONFLICT (settlement_type, external_ref) DO NOTHING
  RETURNING id INTO v_ca_id;
  IF v_ca_id IS NULL THEN
    SELECT id, state INTO v_ca_id, v_ca_state FROM public.ca_settlements
     WHERE settlement_type = 'union_player_pnl'
       AND external_ref = p_union_id::text || ':' || to_char(p_start, 'YYYY-MM-DD"T"HH24:MI:SSOF');
    IF v_ca_state = 'failed' THEN
      UPDATE public.ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_ca_id;
      v_walk := true;
    ELSIF v_ca_state = 'open' THEN
      v_walk := true;
    END IF; -- any later state: leave the machine alone, evidence stands
  ELSE
    v_walk := true;
  END IF;

  -- A failed attempt preserves only the claim and incident; period/invoice/ledger writes roll back.
  BEGIN
  -- (C) FIX: every club in the settlement gets a period row for THIS window.
  INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
  SELECT t.club_id, p_union_id,
         EXTRACT(week FROM p_start)::int, EXTRACT(isoyear FROM p_start)::int,
         p_start, p_end, 'processing'
    FROM pg_temp._pnl_tmp t
   WHERE NOT EXISTS (
     SELECT 1 FROM settlement_periods sp
      WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
        AND sp.start_at = p_start AND sp.end_at = p_end);

    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'locked_for_calculation' WHERE id = v_ca_id;
      UPDATE public.ca_settlements SET state = 'calculated',
        totals = jsonb_build_object('house_residual', v_residual,
                                    'clubs', (SELECT count(*) FROM pg_temp._pnl_tmp))
        WHERE id = v_ca_id;
    END IF;

    SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'pnl_union_wallet_missing'; END IF;

    -- Freeze every participating treasury in stable order before the first leg.
    PERFORM c.id FROM public.clubs c JOIN pg_temp._pnl_tmp t ON t.club_id=c.id ORDER BY c.id FOR UPDATE OF c;
    UPDATE pg_temp._pnl_tmp t SET opening_treasury=c.chip_treasury FROM public.clubs c WHERE c.id=t.club_id;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE opening_treasury IS NULL
      OR opening_treasury::text IN('NaN','Infinity','-Infinity') OR opening_treasury<0
      OR opening_treasury<>round(opening_treasury,2))
      OR v_union_balance IS NULL OR v_union_balance::text IN('NaN','Infinity','-Infinity')
      OR v_union_balance<0 OR v_union_balance<>round(v_union_balance,2) THEN
      RAISE EXCEPTION 'pnl_invalid_funding_balance' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(-net),0) INTO v_needed FROM pg_temp._pnl_tmp WHERE net<0;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE net<0 AND opening_treasury < -net) THEN
      RAISE EXCEPTION 'pnl_club_funding_shortfall' USING DETAIL=(
        SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'owed',-net,'available',opening_treasury) ORDER BY club_id)::text
         FROM pg_temp._pnl_tmp WHERE net<0 AND opening_treasury < -net);
    END IF;
    v_initial_union:=v_union_balance;
    -- ZERO-DRIFT phase 3 validation before any chips move.
    SELECT COALESCE(SUM(net), 0) INTO v_winners_total FROM pg_temp._pnl_tmp WHERE net > 0;
    IF v_union_balance+v_needed<v_winners_total THEN
      RAISE EXCEPTION 'pnl_union_funding_shortfall' USING DETAIL=jsonb_build_object('owed',v_winners_total,'available_after_collection',v_union_balance+v_needed)::text;
    END IF;
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'validated' WHERE id = v_ca_id;
    END IF;

    -- ZERO-DRIFT phase 3: P&L legs journal as pnl_settlement vs the union
    -- wallet, single-posted from the club-treasury side.
    v_prior_ledger:=jsonb_build_object('category',current_setting('app.ledger_category',true),'counterparty',current_setting('app.ledger_counterparty',true),'entity',current_setting('app.ledger_counterparty_entity',true),'settlement',current_setting('app.ledger_settlement',true),'autoskip',current_setting('app.ledger_autoskip_union_wallets',true));
    PERFORM set_config('app.ledger_category', 'pnl_settlement', true);
    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.chip_balance', true);
    PERFORM set_config('app.ledger_settlement', COALESCE(v_ca_id::text, ''), true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);

    FOR r IN SELECT * FROM pg_temp._pnl_tmp WHERE net < 0 ORDER BY club_id LOOP
      v_owed := round(-r.net, 2);
      SELECT chip_treasury INTO v_treasury FROM clubs WHERE id = r.club_id FOR UPDATE;
      v_take := v_owed;
      IF v_take > v_owed OR v_take < 0 THEN
        RAISE EXCEPTION 'pnl validation: collect leg out of bounds (take % owed %)', v_take, v_owed;
      END IF;
      IF v_take > 0 THEN
        UPDATE clubs SET chip_treasury = chip_treasury - v_take WHERE id = r.club_id;
        v_union_balance := v_union_balance + v_take;
        UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
        v_collect_total := v_collect_total + v_take;
        INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
        VALUES (p_union_id, 'chip_balance', 'credit', v_take, v_union_balance, 'player_pnl_collect', r.club_id,
                'Weekly player P&L: collected from club (owed ' || v_owed || ')');
        INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
        VALUES (r.club_id, v_take, 'union_pnl_collect',
                'Weekly union player P&L settlement: club owed ' || v_owed,
                jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                   'period_start', p_start, 'net', r.net));
      END IF;

      SELECT id INTO v_period_id FROM settlement_periods
        WHERE club_id = r.club_id AND union_id = p_union_id
          AND start_at = p_start AND end_at = p_end
        ORDER BY created_at DESC LIMIT 1;
      IF v_period_id IS NULL THEN
        RAISE EXCEPTION 'settlement period row missing for club % in window % .. %', r.club_id, p_start, p_end;
      END IF;
      SELECT count(*) INTO v_receipt_count FROM public.chip_ledger l
       JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
       WHERE l.settlement_id=v_ca_id::text AND l.club_id=r.club_id AND l.category='pnl_settlement'
        AND l.from_type='club_treasury' AND l.from_entity_id=r.club_id
        AND l.to_type='union_wallet' AND l.to_entity_id=p_union_id AND l.status='posted' AND l.amount=v_owed
        AND i.status='paid' AND i.chips_transferred AND i.message_sent
        AND i.gross_amount=v_owed AND i.net_amount=v_owed AND i.deductions=0;
      IF v_receipt_count<>1 THEN RAISE EXCEPTION 'pnl_posted_receipt_missing_or_ambiguous'; END IF;
      v_unpaid_total := v_unpaid_total + round(v_owed - v_take, 2);
    END LOOP;

    FOR r IN SELECT * FROM pg_temp._pnl_tmp WHERE net > 0 ORDER BY club_id LOOP
      v_owed := round(r.net, 2);
      v_pay := v_owed;
      IF v_pay > v_owed OR v_pay < 0 THEN
        RAISE EXCEPTION 'pnl validation: pay leg out of bounds (pay % owed %)', v_pay, v_owed;
      END IF;
      IF v_pay > 0 THEN
        UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_pay WHERE id = r.club_id;
        v_union_balance := v_union_balance - v_pay;
        UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
        v_pay_total := v_pay_total + v_pay;
        INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
        VALUES (p_union_id, 'chip_balance', 'debit', v_pay, v_union_balance, 'player_pnl_pay', r.club_id,
                'Weekly player P&L: paid to club (owed ' || v_owed || ')');
        INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
        VALUES (r.club_id, v_pay, 'union_pnl_payout',
                'Weekly union player P&L settlement: union owed ' || v_owed,
                jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                   'period_start', p_start, 'net', r.net));
      END IF;

      SELECT id INTO v_period_id FROM settlement_periods
        WHERE club_id = r.club_id AND union_id = p_union_id
          AND start_at = p_start AND end_at = p_end
        ORDER BY created_at DESC LIMIT 1;
      IF v_period_id IS NULL THEN
        RAISE EXCEPTION 'settlement period row missing for club % in window % .. %', r.club_id, p_start, p_end;
      END IF;
      SELECT count(*) INTO v_receipt_count FROM public.chip_ledger l
       JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
       WHERE l.settlement_id=v_ca_id::text AND l.club_id=r.club_id AND l.category='pnl_settlement'
        AND l.from_type='union_wallet' AND l.from_entity_id=p_union_id
        AND l.to_type='club_treasury' AND l.to_entity_id=r.club_id AND l.status='posted' AND l.amount=v_owed
        AND i.status='paid' AND i.chips_transferred AND i.message_sent
        AND i.gross_amount=v_owed AND i.net_amount=v_owed AND i.deductions=0;
      IF v_receipt_count<>1 THEN RAISE EXCEPTION 'pnl_posted_receipt_missing_or_ambiguous'; END IF;
      v_unpaid_total := v_unpaid_total + round(v_owed - v_pay, 2);
    END LOOP;

    IF v_unpaid_total<>0 OR v_collect_total<>v_needed OR v_pay_total<>v_winners_total THEN
      RAISE EXCEPTION 'pnl_obligations_not_fully_settled' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp t JOIN public.clubs c ON c.id=t.club_id
       WHERE c.chip_treasury IS DISTINCT FROM t.opening_treasury+t.net)
      OR v_union_balance<>v_initial_union+v_collect_total-v_pay_total THEN
      RAISE EXCEPTION 'pnl_balance_conservation_failed' USING ERRCODE='23514';
    END IF;
    PERFORM set_config('app.ledger_category',COALESCE(v_prior_ledger->>'category',''),true);
    PERFORM set_config('app.ledger_counterparty',COALESCE(v_prior_ledger->>'counterparty',''),true);
    PERFORM set_config('app.ledger_counterparty_entity',COALESCE(v_prior_ledger->>'entity',''),true);
    PERFORM set_config('app.ledger_settlement',COALESCE(v_prior_ledger->>'settlement',''),true);
    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);
    PERFORM set_config('app.ledger_counterparty_label','',true);

    IF abs(v_residual) >= 0.01 THEN
      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
      VALUES (p_union_id, 'chip_balance',
              CASE WHEN v_residual < 0 THEN 'credit' ELSE 'debit' END,
              abs(v_residual), v_union_balance, 'player_pnl_house_residual',
              'Net player clearing residual for the period, including all players, absorbed by the union '
              || 'as clearing house (settlement ' || v_settlement_id || ')');
    END IF;

    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'ledger_posted' WHERE id = v_ca_id;
    END IF;

    UPDATE settlement_periods sp
       SET total_player_winnings = COALESCE((t.detail->>'winnings')::numeric, 0),
           total_player_losses   = COALESCE((t.detail->>'losses')::numeric, 0),
           seated_stack_snapshot = t.seated,
           status = 'settled',
           settled_at = now()
      FROM pg_temp._pnl_tmp t
     WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
       AND sp.start_at = p_start AND sp.end_at = p_end;

    -- Post-commit verification: the wallet must hold exactly what the legs say.
    SELECT chip_balance INTO v_expected_balance FROM union_wallets WHERE union_id = p_union_id;
    IF round(COALESCE(v_expected_balance, 0), 2) <> round(v_union_balance, 2) THEN
      RAISE EXCEPTION 'pnl post-commit verify: wallet % but legs say %', v_expected_balance, v_union_balance;
    END IF;
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'post_commit_verified' WHERE id = v_ca_id;
      UPDATE public.ca_settlements SET state = 'final',
        totals = COALESCE(totals, '{}'::jsonb) || jsonb_build_object(
          'collected', v_collect_total, 'paid', v_pay_total,
          'unpaid', v_unpaid_total, 'house_residual', v_residual)
        WHERE id = v_ca_id;
    END IF;

    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM pg_temp._pnl_tmp;
    UPDATE union_pnl_settlements
       SET status='settled', total_collected=v_collect_total, total_paid=v_pay_total,
           total_unpaid=v_unpaid_total, house_residual=v_residual,
           club_results=COALESCE(v_results,'[]'::jsonb), settled_at=now()
     WHERE id = v_settlement_id;

  EXCEPTION WHEN OTHERS THEN
    -- Every chip movement above is rolled back to the block savepoint here.
    v_err := SQLERRM;
    UPDATE union_pnl_settlements SET status = 'failed' WHERE id = v_settlement_id;
    UPDATE public.ca_settlements SET state = 'failed', error_detail = left(v_err, 2000)
     WHERE id = v_ca_id;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_union_settle_player_pnl', 'settlement_error', 'critical',
      'pnl-settle-failed:' || p_union_id::text || ':' || extract(epoch from p_start)::bigint,
      0, NULL, NULL, 'settlement', 'union_pnl_settlements',
      v_settlement_id, NULL, p_union_id, NULL, NULL, NULL, v_ca_id::text, NULL, NULL,
      'Weekly player P&L settlement failed and was fully rolled back (no chips moved): ' || left(v_err, 300)
        || ' - fix the cause and re-run; the failed claim does not block a retry',
      false, jsonb_build_object('period_start', p_start, 'period_end', p_end, 'error', left(v_err, 500)));
    RETURN jsonb_build_object('success', false, 'error', v_err, 'rolled_back', true,
      'settlement_id', v_settlement_id, 'union_id', p_union_id, 'period_start', p_start);
  END;

  RETURN jsonb_build_object('success', true, 'settlement_id', v_settlement_id, 'union_id', p_union_id,
    'period_start', p_start, 'period_end', p_end, 'house_residual', v_residual,
    'total_collected', v_collect_total, 'total_paid', v_pay_total, 'total_unpaid', v_unpaid_total,
    'union_balance_after', v_union_balance, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_settle_accounting_rakeback_stage' AND md5(p.prosrc)='188d1636852e25fafc397dfb0a6260e9')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_settle_accounting_rakeback_stage'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived(p_scope_kind,p_scope_id,p_period_end) THEN
  RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr LEFT JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
    WHERE COALESCE(pc.id IS NULL OR pc.accounting_version<>2 OR pc.coordinator_union_id IS DISTINCT FROM p_union_id OR pr.period_start<>from_date OR pr.period_end<>to_date
   OR pc.club_id IS DISTINCT FROM pr.club_id OR pc.player_id IS DISTINCT FROM pr.user_id
   OR pc.period_start IS DISTINCT FROM pr.period_start OR pc.period_end IS DISTINCT FROM pr.period_end
   OR pc.rake_generated IS DISTINCT FROM pr.rake_generated OR pc.rake_generated IS DISTINCT FROM pr.total_rake_paid
   OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_amount OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_earned
   OR pc.display_rate IS DISTINCT FROM pr.rakeback_rate OR pc.rakeback_amount<0 OR pc.rakeback_amount<>round(pc.rakeback_amount,2)
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id',rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   END IF;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM pc.payer_user_id),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
     WHERE COALESCE((COALESCE(ag.allocation_count,0)=0 OR COALESCE(ag.allocation_count,0)<>COALESCE(ag.matched_count,0) OR COALESCE(ag.allocation_count,0)<>COALESCE(w.n,0)
       OR ag.generated IS DISTINCT FROM pc.rake_generated
       OR round(ag.unrounded,2) IS DISTINCT FROM pc.rakeback_amount
       OR pc.display_rate IS DISTINCT FROM (CASE WHEN ag.generated>0 THEN round(ag.unrounded/ag.generated,4) ELSE 0 END))
      OR COALESCE(ag.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT pr.id,pc.id,pr.club_id,pr.user_id,pc.payer_kind,pc.payer_user_id,pc.rakeback_amount,pc.rake_generated,pc.display_rate,pc.source_fingerprint,pr.status
     FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END);
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_todo
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 v_stop:=clock_timestamp()+interval '90 seconds';
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,t.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   UNION ALL SELECT t.club_id,t.payer_user,-t.owed FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id WHERE t.payer_kind='agent') x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_rakeback_recompute_periods' AND md5(p.prosrc)='ed1bf785878e21d7b491fa77a0331d76')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_rakeback_recompute_periods'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '300s'
    AS $$
DECLARE request public.accounting_period_recompute_requests%ROWTYPE; result jsonb; request_state text;
 v_from timestamptz; v_to timestamptz; cutover timestamptz; unaccrued bigint:=0;
 v_wait_from timestamptz; witnessed boolean:=false; waited integer:=0;
 defer_request_lock boolean:=false;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived('club',p_club_id,(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles') THEN
  RETURN jsonb_build_object('status','waived','written',0,'reason','owner_directed_launch_waiver');
 END IF;
 -- A PAGE WAITS BRIEFLY FOR ITS WITNESS, BEFORE IT HOLDS ANYTHING
 -- (20260926133201). Once the settler is current, the hands of an open week
 -- that have no accrued batch are only the ones dealt since its last page -
 -- a club's next attributed hand is a median 1.1-1.7 s away (p95 5.3-8.6 s,
 -- measured 2026-09-26 13:00-13:30). A call that arrives in that gap found no
 -- witness in the door below and paid the full-week calculator, 20-130 s,
 -- holding the club-week lock and the request row that
 -- fn_complete_tournament_terminal also takes. This wait decides nothing: it
 -- holds no lock and writes nothing, only waits (at most 16 x 0.5 s) for one
 -- such hand to exist; the unchanged door below still decides, under the lock,
 -- from its own read. Page-scoped calls of an open week only.
 IF p_user_ids IS NOT NULL THEN
  v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
  v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
  SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
  IF cutover IS NOT NULL AND v_from>=cutover AND clock_timestamp()<v_to
     AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
   LOOP
    v_wait_from:=greatest(v_from,clock_timestamp()-interval '1 minute');
    SELECT EXISTS(SELECT 1 FROM public.rake_records r
      JOIN public.rake_attributions a ON a.rake_record_id=r.id AND a.club_id=p_club_id
     WHERE r.created_at>=v_wait_from AND r.created_at<v_to AND r.rake_amount>0
       AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                       WHERE b.rake_record_id=r.id AND b.status='accrued')) INTO witnessed;
    EXIT WHEN witnessed OR waited>=16 OR clock_timestamp()>=v_to;
    PERFORM pg_sleep(0.5);
    waited:=waited+1;
   END LOOP;
  END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 -- A live page cannot complete a weekly book. Keep the original club-week
 -- advisory lock, but let terminal recognition record its pending request
 -- while this page reads the week. Whole-week and closed-week calls keep the
 -- original request-first order. Evaluate the boundary after advisory admission.
 defer_request_lock:=p_user_ids IS NOT NULL AND cutover IS NOT NULL
  AND v_from>=cutover AND clock_timestamp()>=v_from AND clock_timestamp()<v_to
  AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id);
 IF NOT defer_request_lock THEN
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 END IF;
 BEGIN
  -- A PAGE CANNOT CERTIFY A WEEK THAT STILL HOLDS AN UNACCRUED HAND
  -- (20260926091232). The calculator counts, as `incomplete`, every
  -- attribution of this club on a week record with no accrued batch, and a
  -- non-zero count refuses the call with written=0 whatever else it finds.
  -- When one such hand is already in view the full-week read can only reach
  -- a refusal, so answer from the hand. Only a page-scoped call takes this
  -- door; a whole-period call, a week before the cutover, an unknown club and
  -- a week whose newest hands are all accrued go to the unchanged calculator.
  IF p_user_ids IS NOT NULL THEN
   v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
   v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
   SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
   IF cutover IS NOT NULL AND v_from>=cutover AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
    SELECT count(*) INTO unaccrued
     FROM (SELECT r.id FROM public.rake_records r
            WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
              AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL
            ORDER BY r.created_at DESC LIMIT 200) w
     JOIN public.rake_attributions a ON a.rake_record_id=w.id AND a.club_id=p_club_id
     WHERE NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                       WHERE b.rake_record_id=w.id AND b.status='accrued');
   END IF;
  END IF;
  IF unaccrued>0 THEN
   result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'written',0,'status','blocked','reason','cash_source_receipts_incomplete',
    'source_count',unaccrued);
  ELSE
   result:=public.fn_calculate_cash_rakeback_periods(p_club_id,p_period_start,p_period_end,p_user_ids);
  END IF;
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolls back every period/certificate write before the
  -- durable request is marked blocked. The source cursor can keep accruing
  -- later hands; the weekly coordinator still refuses this unfinished book.
  result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'status','blocked','written',0,'reason',SQLERRM);
 END;
 IF defer_request_lock THEN
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 END IF;
 request_state:=CASE WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'
                     WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END $$;

-- Preserve original absence of pre-login execution; CREATE OR REPLACE retains other ACL entries.
REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check(),public.fn_union_governance_check() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;

-- Component: accounting-component/fact-projection-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_insert' AND md5(p.prosrc)='ea2f75bd25c52d9e0ac3edb8966add70')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_update' AND md5(p.prosrc)='75ab10fa07164f249d129f23bcfb7d3d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_update'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at) UNION ALL SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_delete' AND md5(p.prosrc)='d6defd06bafb66eb2ea1fafc387b7e35')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_delete'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

-- Component: accounting-component/reporting-boundary.sql
-- Reporting uses original charge evidence, including the producer manifest before the fee source rows exist.
CREATE FUNCTION public.fn_ca_launch_reporting_fee_credit(p_club uuid,p_record uuid,p_at timestamptz,p_metadata jsonb,p_amount numeric,p_legacy numeric) RETURNS numeric
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c timestamptz;v_credit numeric;v_total numeric;v_floors numeric;v_cents bigint;v_manifest jsonb;
BEGIN
 c:=public.fn_ca_launch_accounting_cutoff('club',p_club);
 IF c IS NULL THEN RETURN p_legacy; END IF;
 IF public.fn_ca_launch_accounting_accepts(p_club,p_at) IS NOT TRUE THEN RETURN 0; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=p_record) THEN
  SELECT COALESCE(sum(f.rake_credit),0) INTO v_credit FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=p_record AND f.club_id=p_club AND public.fn_ca_launch_accounting_accepts(p_club,f.charged_at);
  RETURN v_credit;
 END IF;
 v_manifest:=p_metadata->'accounting_fee_source'->'contributors';
 IF p_metadata->>'accounting_source_version' IS DISTINCT FROM '2' OR jsonb_typeof(v_manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(v_manifest)=0 THEN RETURN 0; END IF;
 -- This is the original producer's largest-remainder allocation, read-only; its financial transaction still validates every contributor.
 v_cents:=(p_amount*100)::bigint;
 SELECT sum((x->>'weight')::numeric) INTO v_total FROM jsonb_array_elements(v_manifest)x;
 IF v_total IS NULL OR v_total<=0 THEN RETURN 0; END IF;
 SELECT sum(floor(v_cents*(x->>'weight')::numeric/v_total)) INTO v_floors FROM jsonb_array_elements(v_manifest)x;
 SELECT COALESCE(sum(cents)/100.0,0) INTO v_credit FROM (
  SELECT x,floor(v_cents*(x->>'weight')::numeric/v_total)+CASE WHEN row_number() OVER(ORDER BY v_cents*(x->>'weight')::numeric/v_total-floor(v_cents*(x->>'weight')::numeric/v_total) DESC,x->>'player_id')<=v_cents-v_floors THEN 1 ELSE 0 END cents FROM jsonb_array_elements(v_manifest)x
 )q WHERE (x->>'club_id')::uuid=p_club AND public.fn_ca_launch_accounting_accepts(p_club,(x->>'charged_at')::timestamptz);
 RETURN v_credit;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reporting_fee_credit(uuid,uuid,timestamptz,jsonb,numeric,numeric) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_reporting_wallet_accepts(p_club uuid,p_at timestamptz,p_category text,p_tournament uuid,p_user uuid) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.fn_ca_launch_accounting_cutoff('club',p_club) IS NULL THEN RETURN true; END IF;
 IF public.fn_ca_launch_accounting_accepts(p_club,p_at) IS NOT TRUE THEN RETURN false; END IF;
 IF p_tournament IS NOT NULL AND p_category IN('prize','bounty','prize_reversal','refund') THEN
  RETURN EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament AND public.fn_ca_launch_accounting_accepts(p_club,t.started_at)) OR (p_category='refund' AND EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament AND tp.user_id=p_user AND public.fn_ca_launch_accounting_accepts(p_club,tp.registered_at)));
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reporting_wallet_accepts(uuid,timestamptz,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Component: accounting-component/reporting-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_club_rake_daily_compute' AND md5(p.prosrc)='0ed157ecefbeea1939e208c3350497fd')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_club_rake_daily_compute'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_compute(p_from timestamp with time zone, p_to timestamp with time zone, p_ids uuid[]) RETURNS TABLE(club_id uuid, stat_date date, hands bigint, rake numeric, bbj numeric, pot numeric, source_rows bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  WITH src AS (
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0) AS rake, coalesce(r.bbj_contribution, 0) AS bbj,
           coalesce(r.pot_size, 0) AS pot, r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NOT NULL AND r.id = ANY (p_ids)
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
    UNION ALL
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0), coalesce(r.bbj_contribution, 0),
           coalesce(r.pot_size, 0), r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NULL AND r.created_at >= p_from AND r.created_at < p_to
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
  ),
  tbl AS (
    SELECT s.id, s.club_id AS table_club, (s.created_at AT TIME ZONE 'UTC')::date AS day,
           s.rake, s.bbj, s.pot, s.player_contributions, t.union_id
      FROM src s
      LEFT JOIN tables t ON t.id = s.table_id
     WHERE t.id IS NULL OR t.tournament_id IS NULL
  ),
  -- Only a union table needs its contributions read: a standalone table's
  -- rake has exactly one place to go. A key that is not a uuid or a value
  -- that is not a number is ignored, never raised: a reporting rollup must
  -- not fail a ledger write. A contribution of zero still counts the hand
  -- for that player's club, as club_table_daily counts it.
  contrib AS (
    SELECT b.id, b.union_id,
           CASE WHEN e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN e.key::uuid END AS uid,
           CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric END AS contrib
      FROM tbl b
      CROSS JOIN LATERAL jsonb_each_text(
        CASE WHEN jsonb_typeof(b.player_contributions) = 'object'
             THEN b.player_contributions ELSE '{}'::jsonb END) e
     WHERE b.union_id IS NOT NULL
  ),
  attributed AS (
    SELECT c.id, c.contrib,
           coalesce((SELECT cm.club_id
                       FROM club_members cm
                       JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = c.union_id
                      WHERE cm.user_id = c.uid
                      ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
                      LIMIT 1),
                    b.table_club) AS club_id
      FROM contrib c JOIN tbl b ON b.id = c.id
     WHERE c.uid IS NOT NULL AND c.contrib IS NOT NULL AND c.contrib >= 0
  ),
  split AS (
    SELECT a.id, a.club_id, sum(a.contrib) AS contrib, count(*) AS src_rows
      FROM attributed a GROUP BY a.id, a.club_id
  ),
  split_total AS (
    SELECT s.id, sum(s.contrib) AS tot FROM split s GROUP BY s.id
  ),
  hand_rows AS (
    SELECT b.*, EXISTS (SELECT 1 FROM split_total st WHERE st.id = b.id AND st.tot > 0) AS has_split
      FROM tbl b
  ),
  parts AS (
    -- A union hand with a usable split: rake by contribution share, and one
    -- hand for every club that contributed.
    SELECT h.day, s.club_id, 1::bigint AS hands, h.rake * s.contrib / st.tot AS rake,
           0::numeric AS bbj, 0::numeric AS pot, s.src_rows
      FROM split s
      JOIN split_total st ON st.id = s.id AND st.tot > 0
      JOIN hand_rows h ON h.id = s.id
    UNION ALL
    -- The table's club: the drop and the pot volume of every hand it hosted,
    -- plus the whole hand when nothing could be attributed.
    SELECT h.day, h.table_club,
           CASE WHEN h.has_split THEN 0 ELSE 1 END,
           CASE WHEN h.has_split THEN 0 ELSE h.rake END,
           h.bbj, h.pot,
           CASE WHEN h.has_split THEN 0 ELSE 1 END
      FROM hand_rows h
  )
  SELECT p.club_id, p.day, sum(p.hands)::bigint, sum(p.rake), sum(p.bbj), sum(p.pot),
         sum(p.src_rows)::bigint
    FROM parts p
   GROUP BY p.club_id, p.day;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refresh_player_stats' AND md5(p.prosrc)='754582f1c22c0fe8a02e8f9089a3440e')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: refresh_player_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.refresh_player_stats() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
    DECLARE v_count INTEGER := 0;
    BEGIN
      INSERT INTO player_stats (user_id, club_id, hands_played, total_winnings, total_losses)
      SELECT hp.user_id, t.club_id, COUNT(*)::INTEGER as hands_played,
        COALESCE(SUM(hp.chips_won), 0) as total_winnings, COALESCE(SUM(hp.chips_lost), 0) as total_losses
      FROM hand_players hp JOIN hands h ON h.id = hp.hand_id JOIN tables t ON t.id = h.table_id
      WHERE t.club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(t.club_id,h.created_at) GROUP BY hp.user_id, t.club_id
      ON CONFLICT (user_id, club_id) DO UPDATE SET
        hands_played = EXCLUDED.hands_played, total_winnings = EXCLUDED.total_winnings,
        total_losses = EXCLUDED.total_losses, updated_at = NOW();
      GET DIAGNOSTICS v_count = ROW_COUNT;
      RETURN v_count;
    END; $$;

-- Component: accounting-component/reporting-extra-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ca_refresh_reporting_rollups_base' AND md5(p.prosrc)='40937321494caccce9d2b73da6f04aa4')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: ca_refresh_reporting_rollups_base'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from := v_start::timestamp AT TIME ZONE 'UTC';
  v_to := (v_end + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id, cm.club_id
      FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id, club_id FROM home
    UNION
    SELECT user_id, club_id FROM standalone
  ), mapped AS MATERIALIZED (
    -- 2026-09-04: cash rows are the ones with a table (buy-in, cash-out,
    -- add-on, rebuy, refund); tournament rows have a tournament and no table
    -- (buy-in, add-on, rebuy, refund, prize, bounty, prize reversal). The sign
    -- is the row's type. This read buy-in/cash-out and buy-in/prize/bounty.
    SELECT 'cash'::text AS kind,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
       AND tb.tournament_id IS NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(h.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    -- standalone tables, which this rollup never read.
    SELECT 'cash',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           tb.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
       AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(tb.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT 'tournament',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.kind='cash'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.kind='tournament'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),now()
    FROM mapped m GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id)
           uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  ), wallet_mapped AS MATERIALIZED (
    SELECT a.club_id,wt.related_entity_id AS tournament_id,wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.type='credit' THEN wt.amount
                WHEN wt.type='debit' THEN -wt.amount ELSE 0 END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  ), entrant_totals AS MATERIALIZED (
    SELECT tp.tournament_id,count(*)::numeric AS total_players
      FROM public.tournament_players tp GROUP BY tp.tournament_id
  ), entrant_clubs AS MATERIALIZED (
    SELECT tp.tournament_id,a.club_id,count(*)::numeric AS club_players
      FROM public.tournament_players tp JOIN affiliations a ON a.user_id=tp.user_id
     GROUP BY tp.tournament_id,a.club_id
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,(r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END AS club_id,
           public.fn_ca_launch_reporting_fee_credit(CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END,r.id,r.created_at,r.metadata,r.rake_amount,CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount ELSE r.rake_amount*ec.club_players/NULLIF(et.total_players,0) END) AS fee
      FROM public.rake_records r
      LEFT JOIN affiliations a ON r.metadata ? 'user_id'
       AND a.user_id::text=r.metadata->>'user_id'
      LEFT JOIN entrant_clubs ec ON NOT (r.metadata ? 'user_id')
       AND ec.tournament_id=r.tournament_id
      LEFT JOIN entrant_totals et ON et.tournament_id=r.tournament_id
     WHERE r.created_at>=v_from AND r.created_at<v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount<>0
  ), combined AS (
    SELECT wm.club_id,wm.tournament_id,wm.stat_date,0::numeric AS fee,
           sum(wm.winnings) AS winnings FROM wallet_mapped wm GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id,rm.tournament_id,rm.stat_date,sum(rm.fee),0::numeric
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL AND rm.fee<>0 GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id,tournament_id,stat_date,fee,winnings,updated_at)
  SELECT club_id,tournament_id,stat_date,sum(fee),sum(winnings),now()
    FROM combined GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id,tournament_id,user_id,stat_date,updated_at)
  SELECT DISTINCT a.club_id,wt.related_entity_id,wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date,now()
    FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
   WHERE wt.created_at>=v_from AND wt.created_at<v_to
     AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
     AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL;

  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'player_facts',v_players,
    'tournament_facts',v_tournaments,'participant_facts',v_participants,
    'refreshed_at',now());
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_table_daily_refresh_day' AND md5(p.prosrc)='4290ee1bfda7de2b6b5dda5ebdfef561')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_table_daily_refresh_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_rows int;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;

  DELETE FROM club_table_daily WHERE stat_date = p_day;

  WITH att AS (
    SELECT DISTINCT ON (cm.user_id, uc.union_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY cm.user_id, uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  rr AS (
    SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id AS table_club,
           e.key AS uid, (e.value)::numeric AS contrib,
           SUM((e.value)::numeric) OVER (PARTITION BY r.id) AS tot
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.player_contributions IS NOT NULL
       AND r.rake_amount > 0
       AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) x
          WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    UNION ALL
    -- 2026-09-04: a raked hand with no usable contribution (none recorded,
    -- not an object, no uuid keys, nothing positive) used to vanish from this
    -- rollup: 109 rows and 173.38 chips on the reference club's three days.
    -- It is the table's club's rake and it goes there whole, as one synthetic
    -- row of weight 1 and no player.
    SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id,
           NULL::text, 1::numeric, 1::numeric
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) e
          WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
  ),
  raked AS (
    SELECT COALESCE(a.club_id, rr.table_club) AS club_id,
           rr.table_id,
           rr.union_id,
           SUM(rr.rake_amount * rr.contrib / rr.tot) AS rake,
           COUNT(DISTINCT rr.id)  AS hands,
           COUNT(DISTINCT rr.uid) AS players,
           COUNT(*)               AS src
      FROM rr
      LEFT JOIN att a ON a.user_id::text = rr.uid AND a.union_id IS NOT DISTINCT FROM rr.union_id
     WHERE rr.tot > 0 AND public.fn_ca_launch_accounting_accepts(COALESCE(a.club_id,rr.table_club),rr.created_at)
     GROUP BY 1, 2, 3
  ),
  -- 2026-09-04: a table add-on (a top-up, 'addon'), a rebuy and a refund are
  -- buy-in money too; this read 'buyin' and 'cashout' alone and so put every
  -- top-up (1.76M chips across the platform in 30 days) on the players' side
  -- of the table net. Debits are money onto the table, credits money off it.
  wal AS (
    SELECT COALESCE(a.club_id, t.club_id) AS club_id,
           wt.table_id,
           t.union_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN tables t ON t.id = wt.table_id AND t.tournament_id IS NULL
      LEFT JOIN att a ON a.user_id = wt.user_id AND a.union_id IS NOT DISTINCT FROM t.union_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(COALESCE(a.club_id,t.club_id),wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund')
     GROUP BY 1, 2, 3
  ),
  merged AS (
    SELECT COALESCE(k.club_id,  w.club_id)  AS club_id,
           COALESCE(k.table_id, w.table_id) AS table_id,
           COALESCE(k.union_id, w.union_id) AS union_id,
           COALESCE(k.rake, 0)     AS rake,
           COALESCE(k.hands, 0)    AS hands,
           COALESCE(k.players, 0)  AS players,
           COALESCE(k.src, 0)      AS src,
           COALESCE(w.buyins, 0)   AS buyins,
           COALESCE(w.cashouts, 0) AS cashouts
      FROM raked k
      FULL OUTER JOIN wal w
        ON w.club_id = k.club_id AND w.table_id = k.table_id
  )
  INSERT INTO club_table_daily (club_id, table_id, stat_date, union_id,
                                rake, hands, players, buyins, cashouts, net,
                                source_rows, updated_at)
  SELECT m.club_id, m.table_id, p_day, m.union_id,
         round(m.rake, 4), m.hands, m.players,
         round(m.buyins, 2), round(m.cashouts, 2),
         round(m.cashouts - m.buyins, 2),
         m.src, now()
    FROM merged m
   WHERE m.club_id IS NOT NULL AND m.table_id IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'day', p_day, 'rows', v_rows);
END;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_ca_reporting_rake_insert' AND md5(p.prosrc)='8a7f9c06565d8c99c66dcaadf69995c1')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_ca_reporting_rake_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_day date; r record; v_fee numeric;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount);
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount*r.club_players/NULLIF(r.total_players,0));
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_ca_reporting_wallet_insert' AND md5(p.prosrc)='05cff3cd3111a01271fa5b74d1dc18d3')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_ca_reporting_wallet_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL AND public.fn_ca_launch_reporting_wallet_accepts(v_club,NEW.created_at,NEW.category,NULL,NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
      IF NOT public.fn_ca_launch_reporting_wallet_accepts(r.club_id,NEW.created_at,NEW.category,NEW.related_entity_id,NEW.user_id) THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_agent_downline_rake' AND md5(p.prosrc)='eea1a3fd9804401d32ad31ea0fb19f91')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_agent_downline_rake'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500) RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
  v_overseer_clubs uuid[];
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
       AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))
  ),
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  everyone AS MATERIALIZED (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch WHERE ch.depth > 0
  ),
  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM club_rake_rollup_complete rc
      JOIN in_scope_clubs c ON c.club_id = rc.club_id
     WHERE rc.day >= v_day_lo AND rc.day < v_day_hi
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM in_scope_clubs c
      CROSS JOIN generate_series(v_day_lo, v_day_hi - 1, interval '1 day') g
     WHERE v_day_hi > v_day_lo
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN ok_days o  ON o.club_id = rd.club_id AND o.day = rd.day
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     GROUP BY rd.user_id, rd.club_id
  ),
  edge_hands AS MATERIALIZED (
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_tail_start AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM gap_days gd
      JOIN rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at <  (gd.day + 1)::timestamptz
     WHERE public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- LEDGER-READ (2026-08-29): stored per-player credits when present, the
  -- canonical allocator when not.
  edge_split AS MATERIALIZED (
    SELECT s.user_id, eh.club_id, eh.created_at,
           round(s.credit * 100)::bigint AS cents
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions, COALESCE(eh.rake_method, 'DEALT_EQUAL')
      ) s
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
      JOIN everyone e ON e.player_id = s.user_id AND e.club_id = s.club_id
     GROUP BY s.user_id, s.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at,'-infinity'::timestamptz),
                    COALESCE(b.last_at,'-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id AND b.club_id = a.club_id
  ),
  downline_agg AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, SUM(ea.rake) AS rake
      FROM earned ea
      JOIN club_members cm ON cm.user_id = ea.user_id AND cm.club_id = ea.club_id
     WHERE cm.agent_id IS NOT NULL
     GROUP BY cm.agent_id, cm.club_id
  ),
  downline_cnt AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, count(*)::int AS players
      FROM club_members cm
     WHERE cm.agent_id IN (SELECT player_id FROM everyone)
     GROUP BY cm.agent_id, cm.club_id
  )
  SELECT e.player_id,
         COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(public.fn_arena_name(up.alias, up.username, up.display_name, up.first_name, up.last_name, up.full_name), up.username),
         COALESCE(ea.rake, 0), COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0), COALESCE(da.rake, 0)
    FROM everyone e
    LEFT JOIN earned ea       ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN downline_agg da ON da.upline  = e.player_id AND da.club_id = e.club_id
    LEFT JOIN downline_cnt dc ON dc.upline  = e.player_id AND dc.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl    ON cl.id = e.club_id
    LEFT JOIN agents ag   ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                         AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_rake_by_agent' AND md5(p.prosrc)='ac26cdcf55b0876d0966b159695fc4a0')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_rake_by_agent'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), paid_cut AS MATERIALIZED (
    -- EVERY INSTANT IN [v_from, v_to) AT WHICH "PAID" CAN CHANGE, AND v_from.
    -- fn_agent_commission_paid_by_period is SELECT EXISTS (...), and a SQL
    -- body with a sublink is never inlined, so asking it inside the FILTERs
    -- below made it a function call, twice for every open commission row in
    -- the range: 4,024,562 calls and 42 s for SHARK CLUB's month. For any
    -- agent the answer can only change where one of this club's paid periods
    -- starts or ends. Between two consecutive cuts it is constant, so it is
    -- asked once per stretch, at the stretch's first instant.
    SELECT v_from AS cut
    UNION
    SELECT s.period_start FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_start > v_from AND s.period_start < v_to
    UNION
    SELECT s.period_end FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_end > v_from AND s.period_end < v_to
  ), stretch AS MATERIALIZED (
    -- [lo, hi) stretches that tile [v_from, v_to) exactly: no gap, no overlap.
    SELECT c.cut AS lo, COALESCE(lead(c.cut) OVER (ORDER BY c.cut), v_to) AS hi
      FROM paid_cut c
  ), commission_part AS (
    -- One range read of idx_agent_commissions_club_created per stretch, summed
    -- per (agent, own settled_at set or not). No function call per row. The
    -- half-open window of fn_club_commission_accrued (>= since, < until) is
    -- stated outright as well: the stretches tile it exactly, so it removes
    -- nothing, and no stretch can ever widen what is summed.
    SELECT st.lo, x.user_id, x.open, x.amount
      FROM stretch st
      CROSS JOIN LATERAL (
        SELECT ac.user_id, ac.settled_at IS NULL AS open, SUM(ac.amount) AS amount
          FROM public.agent_commissions ac
         WHERE ac.club_id = p_club_id
           AND ac.created_at >= v_from AND ac.created_at < v_to
           AND ac.created_at >= st.lo AND ac.created_at < st.hi
         GROUP BY ac.user_id, ac.settled_at IS NULL) x
  ), commission AS (
    -- The same predicate and the same two FILTERs, asked once per stretch.
    -- Every sum covers exactly the rows it did (numeric addition is exact and
    -- keeps the largest input scale), and is NULL exactly when it was.
    SELECT cp.user_id,
           SUM(cp.amount)                                          AS earned,
           SUM(cp.amount) FILTER (WHERE cp.open AND NOT public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS outstanding,
           SUM(cp.amount) FILTER (WHERE NOT cp.open OR public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS settled
      FROM commission_part cp
     GROUP BY cp.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC,
               f.agent_user_id::text ASC NULLS LAST) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$$;

-- Preserve original absence of pre-login execution; CREATE OR REPLACE retains other ACL entries.
REVOKE EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamptz,timestamptz,uuid[]) FROM PUBLIC,anon;

-- Component: accounting-component/union-reporting-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_union_rake_weekly' AND md5(p.prosrc)='35dbcba12e3c197de1997339e45d0276')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_union_rake_weekly'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_union_rake_weekly() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.fn_ca_launch_accounting_accepts(NEW.club_id,NEW.created_at) OR (public.fn_ca_launch_accounting_cutoff('union',NEW.union_id) IS NOT NULL AND (NEW.created_at IS NULL OR NEW.created_at<public.fn_ca_launch_accounting_cutoff('union',NEW.union_id))) THEN RETURN NULL; END IF;
  IF NEW.union_id IS NOT NULL
     AND NEW.wallet = 'rake_wallet'
     AND NEW.direction = 'credit'
     AND NEW.tx_type = 'rake' THEN
    INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total, updated_at)
    VALUES (NEW.union_id, NEW.club_id, date_trunc('week', NEW.created_at)::date,
            COALESCE(NEW.amount, 0), now())
    ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
      SET rake_total = public.union_rake_weekly.rake_total + EXCLUDED.rake_total,
          updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never let a display rollup block the engine banking rake. A failure here
  -- costs a stale panel; the function's fallback still reads the ledger.
  RAISE WARNING 'union_rake_weekly maintenance failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_money_panel' AND md5(p.prosrc)='ae32bb8e315f339b1ba954325e8cc524')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_money_panel'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_union_id uuid; v_club record;
  v_is_member boolean := false; v_is_club_staff boolean := false; v_is_union_staff boolean := false;
  v_scope text; v_pool record; v_w record;
  v_week_start timestamptz := date_trunc('week', now());
  v_club_rake numeric := 0; v_rate numeric := 0.90;
  v_clubs_wallet numeric; v_union_week numeric; v_out jsonb;
  v_spin_idle numeric := 0; v_spin_deployed numeric := 0;
  v_bbj jsonb;
BEGIN
  IF v_uid IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_auth');
  END IF;

  SELECT id, name, union_id, COALESCE(chip_treasury,0) AS chip_treasury,
         COALESCE(chip_pool,0) AS chip_pool, COALESCE(promo_balance,0) AS promo_balance,
         owner_id
    INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'club_not_found');
  END IF;
  v_union_id := v_club.union_id;
  v_week_start:=public.fn_ca_launch_accounting_start('club',p_club_id,public.fn_ca_launch_accounting_start('union',v_union_id,v_week_start));

  -- The jackpot, resolved BEFORE the membership gate. Union-first, exactly as
  -- the engine banks it: a club inside a union contributes to the UNION pool.
  SELECT bp.id, COALESCE(bp.main_balance,0) main_balance,
         COALESCE(bp.backup_balance,0) backup_balance,
         COALESCE(bp.promo_balance,0) promo_balance,
         bp.union_id IS NOT NULL AS is_union_pool
    INTO v_pool FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL  AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  v_bbj := jsonb_build_object(
    'pool_id', v_pool.id, 'is_union_pool', COALESCE(v_pool.is_union_pool, false),
    'main', round(COALESCE(v_pool.main_balance,0), 2),
    'backup', round(COALESCE(v_pool.backup_balance,0), 2),
    'promo_in_pool', round(COALESCE(v_pool.promo_balance,0), 2));

  SELECT EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid)
    INTO v_is_member;
  v_is_club_staff := (v_club.owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
                 AND lower(COALESCE(cm.role,'')) IN ('owner','co_owner','admin','manager'));

  IF v_union_id IS NOT NULL THEN
    v_is_union_staff := EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = v_uid)
      OR EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = v_uid);
  END IF;

  IF NOT (v_is_member OR v_is_club_staff OR v_is_union_staff) THEN
    -- Still a refusal in every respect the caller relies on: `scope` is absent,
    -- so club money renders "-" and never 0.00. Only the public jackpot rides
    -- along.
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_a_member',
                              'bbj', v_bbj);
  END IF;

  v_scope := CASE WHEN v_is_union_staff THEN 'union'
                  WHEN v_is_club_staff  THEN 'club' ELSE 'member' END;

  v_out := jsonb_build_object(
    'authorized', true, 'scope', v_scope, 'club_id', p_club_id, 'club_name', v_club.name,
    'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
    'club_treasury', round(v_club.chip_treasury, 2), 'club_pool', round(v_club.chip_pool, 2),
    /* THE CLUB'S PROMO WALLET (Dan, 2026-09-02): "NONE OF THE CHIPS FROM THE
       BBJ RAKE ARE GOING INTO THE PROMO WALLET." They were. Every hand's BBJ
       drop splits 50/25/25 main/backup/promo (bbj_record_contribution), and
       fn_sweep_bbj_promo moves the promo slice out of the pool into
       clubs.promo_balance for a standalone club - 1,220.19 of it in Deep
       Stack Society alone. This panel never returned that column, so no
       surface could show it and the club's Promo Wallet row fell back to the
       VIEWER'S OWN agents.promo_wallet_balance, which reads 0.00 for an owner
       who is not an agent. Club money, at exactly the sensitivity of
       club_treasury beside it, and club-scoped: a club inside a union banks
       its promo slice in the UNION wallet, so this is honestly 0 there and
       'union_promo' below carries the union's figure for union staff. */
    'club_promo_wallet', round(COALESCE(v_club.promo_balance, 0), 2),
    'bbj', v_bbj,
    'week_start', v_week_start, 'next_close_at', v_week_start + interval '7 days');

  IF v_union_id IS NULL THEN
    IF v_is_club_staff THEN
      -- The hand path keeps its share per table (club_table_rake_totals,
      -- 2026-10-02); the wallet column carries tournament rake and history.
      SELECT round(COALESCE(w.period_rake_collected, 0)
                 + COALESCE((SELECT sum(t.rake_collected)
                               FROM public.club_table_rake_totals t
                              WHERE t.club_id = p_club_id), 0), 2) INTO v_club_rake
        FROM club_wallets w WHERE w.club_id = p_club_id;
      IF FOUND THEN
        v_out := v_out || jsonb_build_object('club_rake_treasury', v_club_rake);
      END IF;
    END IF;
    RETURN v_out;
  END IF;

  IF v_is_club_staff OR v_is_union_staff THEN
    SELECT COALESCE(
             (SELECT w.rake_total FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.club_id = p_club_id
                 AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.club_id = p_club_id
                 AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
                 AND t.created_at >= v_week_start),
             0) INTO v_club_rake;
    SELECT COALESCE(uc.club_commission_rate, 0.90) INTO v_rate
      FROM union_clubs uc WHERE uc.union_id = v_union_id AND uc.club_id = p_club_id;
    v_out := v_out || jsonb_build_object(
      'club_rake_this_week', round(v_club_rake, 2),
      'club_rakeback_rate', COALESCE(v_rate, 0.90),
      'club_projected_rakeback', trunc(v_club_rake * COALESCE(v_rate, 0.90) * 100) / 100);
  END IF;

  IF v_is_union_staff THEN
    SELECT round(COALESCE(chip_balance,0),2) chip_balance,
           round(COALESCE(rake_wallet,0),2) rake_wallet,
           round(COALESCE(promo_wallet,0),2) promo_wallet,
           round(COALESCE(spin_reserve_wallet,0),2) spin_reserve_wallet
      INTO v_w FROM union_wallets WHERE union_id = v_union_id;

    SELECT COALESCE(SUM(COALESCE(c.chip_treasury,0)), 0) INTO v_clubs_wallet
      FROM clubs c WHERE c.union_id = v_union_id AND c.id <> v_union_id;

    SELECT COALESCE(
             (SELECT SUM(w.rake_total) FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.wallet = 'rake_wallet'
                 AND t.direction = 'credit' AND t.tx_type = 'rake' AND t.created_at >= v_week_start),
             0) INTO v_union_week;

    v_spin_idle := COALESCE(v_w.spin_reserve_wallet, 0);
    SELECT COALESCE(SUM(COALESCE(sp.balance, 0)), 0) INTO v_spin_deployed
      FROM spin_bonus_pools sp
     WHERE sp.is_active
       AND (sp.club_id = v_union_id
            OR sp.club_id IN (SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = v_union_id));

    v_out := v_out || jsonb_build_object(
      'union_bank', COALESCE(v_w.chip_balance, 0),
      'rake_treasury', COALESCE(v_w.rake_wallet, 0),
      'union_promo', COALESCE(v_w.promo_wallet, 0),
      'union_spin_treasury', round(v_spin_idle + v_spin_deployed, 2),
      'union_spin_idle', round(v_spin_idle, 2),
      'union_spin_deployed', round(v_spin_deployed, 2),
      'clubs_wallet', round(v_clubs_wallet, 2),
      'union_rake_this_week', round(v_union_week, 2),
      'projected_clubs_share', trunc(v_union_week * 0.90 * 100) / 100,
      'projected_union_share', round(v_union_week - trunc(v_union_week * 0.90 * 100) / 100, 2));
  END IF;

  RETURN v_out;
END
$$;

-- Component: accounting-component/hand-stats-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_fold_hand_winnings' AND md5(p.prosrc)='743b74f6f7740500a46cf95d51f9ebbf')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_fold_hand_winnings'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_fold_hand_winnings() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE v_club uuid; v_bb numeric;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  IF NEW.tournament_id IS NOT NULL OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players)<>'array' OR jsonb_array_length(NEW.players)=0 THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  IF NOT public.fn_ca_launch_accounting_accepts(v_club,NEW.created_at) THEN RETURN NEW; END IF;
  v_bb := greatest(coalesce(NEW.big_blind,0),0);
  WITH seated AS (
    SELECT DISTINCT (pl->>'userId') AS uid
      FROM jsonb_array_elements(NEW.players) pl
     WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), won AS (
    SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.winners)='array'
        THEN NEW.winners ELSE '[]'::jsonb END) w
     WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce((w->>'amount')::numeric,0)>0
     GROUP BY 1
  )
  INSERT INTO public.player_stats
    (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
  SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
    FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
   WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
  ON CONFLICT (user_id,club_id) DO UPDATE SET
    hands_dealt=player_stats.hands_dealt+EXCLUDED.hands_dealt,
    sum_big_blind=player_stats.sum_big_blind+EXCLUDED.sum_big_blind,
    total_winnings=player_stats.total_winnings+EXCLUDED.total_winnings,
    updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_hand_history_club_member_stats' AND md5(p.prosrc)='dcf951bb3ba1e0a42f7069ad473e9f59')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_hand_history_club_member_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE v_club uuid; v_date date; v_tourney boolean;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  SELECT t.club_id,(t.tournament_id IS NOT NULL)
    INTO v_club,v_tourney FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  IF NOT public.fn_ca_launch_accounting_accepts(v_club,NEW.created_at) THEN RETURN NEW; END IF;
  v_tourney := coalesce(v_tourney,false) OR (NEW.tournament_id IS NOT NULL);
  v_date := (NEW.created_at AT TIME ZONE 'UTC')::date;
  WITH pl AS (
    SELECT DISTINCT ON (p->>'userId') (p->>'userId')::uuid AS uid,
           (p->>'stack')::numeric AS stack
      FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
  ), wn AS (
    SELECT (w->>'userId')::uuid AS uid,sum((w->>'amount')::numeric) AS won
      FROM jsonb_array_elements(coalesce(NEW.winners,'[]'::jsonb)) w
     WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     GROUP BY 1
  ), base AS (
    SELECT pl.uid,pl.stack,coalesce(wn.won,0) AS won,st.last_stack,
      (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
       AND NEW.hand_number IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.hand_history h2 WHERE h2.table_id=NEW.table_id
          AND h2.hand_number>st.last_hand_number AND h2.hand_number<NEW.hand_number)) AS adjacent
      FROM pl LEFT JOIN wn ON wn.uid=pl.uid
      LEFT JOIN public.club_member_table_state st
        ON st.table_id=NEW.table_id AND st.user_id=pl.uid
  ), agg AS (
    SELECT count(*) AS seated,count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
           coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
      FROM base
  ), calc AS (
    SELECT b.uid,b.won,
      CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
      CASE WHEN a.seated=a.with_prior
        THEN abs(a.dsum+coalesce(NEW.rake_amount,0)+coalesce(NEW.bbj_amount,0))<0.005
        ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable
      FROM base b CROSS JOIN agg a
  )
  INSERT INTO public.club_member_daily_stats AS s(
    club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
    total_won,profit,biggest_pot_won,biggest_pot,topup_total)
  SELECT v_club,NEW.table_id,calc.uid,v_date,1,
    CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN 1 ELSE 0 END,
    CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
    CASE WHEN v_tourney THEN 0 ELSE calc.won END,
    CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,
    CASE WHEN v_tourney THEN 0 ELSE calc.won END,
    CASE WHEN v_tourney THEN 0 ELSE coalesce(NEW.pot_size,0) END,
    CASE WHEN v_tourney THEN 0 WHEN NOT calc.attributable AND calc.delta>calc.won
      THEN calc.delta-calc.won ELSE 0 END
    FROM calc
  ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
    hands_played=s.hands_played+1,
    hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
    hands_won=s.hands_won+EXCLUDED.hands_won,
    total_won=s.total_won+EXCLUDED.total_won,
    profit=s.profit+EXCLUDED.profit,
    biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
    biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
    topup_total=s.topup_total+EXCLUDED.topup_total,
    updated_at=now();
  INSERT INTO public.club_member_table_state AS st(
    table_id,user_id,last_stack,last_hand_number)
  SELECT DISTINCT ON (p->>'userId') NEW.table_id,(p->>'userId')::uuid,
         (p->>'stack')::numeric,NEW.hand_number
    FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) p
   WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id,user_id) DO UPDATE SET
    last_stack=EXCLUDED.last_stack,last_hand_number=EXCLUDED.last_hand_number,
    updated_at=now();
  INSERT INTO public.club_hand_daily_shard AS d(
    club_id,stat_date,shard,hands,rake,bbj,pot_total)
  VALUES (v_club,v_date,(pg_backend_pid()%16)::smallint,1,
    coalesce(NEW.rake_amount,0),coalesce(NEW.bbj_amount,0),coalesce(NEW.pot_size,0))
  ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
    hands=d.hands+1,rake=d.rake+EXCLUDED.rake,bbj=d.bbj+EXCLUDED.bbj,
    pot_total=d.pot_total+EXCLUDED.pot_total,updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %',SQLERRM;
  RETURN NEW;
END;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_tournament_completed_stats' AND md5(p.prosrc)='b07b73daa38b87d50f082b579be0368d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_tournament_completed_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_tournament_completed_stats() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status <> 'COMPLETED' OR COALESCE(OLD.status,'') = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_ca_launch_accounting_accepts(NEW.club_id,NEW.started_at) THEN RETURN NEW; END IF;

  INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
  SELECT tp.user_id,
         NEW.club_id,
         1,
         CASE WHEN tp.position = 1 OR tp.status = 'winner' THEN 1 ELSE 0 END,
         now()
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.user_id IS NOT NULL
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET tournaments_played = COALESCE(player_stats.tournaments_played,0)
                            + EXCLUDED.tournaments_played,
         tournaments_won    = COALESCE(player_stats.tournaments_won,0)
                            + EXCLUDED.tournaments_won,
         updated_at = now();
  RETURN NEW;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='apply_rakeback_player_stats' AND md5(p.prosrc)='92c5fa0e39ba4ffcaa1befee86623b8c')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: apply_rakeback_player_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.apply_rakeback_player_stats(p_rake_record_id uuid, p_user_id uuid, p_club_id uuid, p_hands integer, p_rake numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.fn_ca_launch_accounting_cutoff('club',p_club_id) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.id=p_rake_record_id AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at) AND ((r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL) OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=r.id AND f.player_id=p_user_id AND f.club_id=p_club_id AND public.fn_ca_launch_accounting_accepts(p_club_id,f.charged_at)))) THEN RETURN false; END IF;

  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ca_rebuild_club_member_stats_table' AND md5(p.prosrc)='484f0c43891e407c05d8af02e140fcf7')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: ca_rebuild_club_member_stats_table'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats_table(p_table_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '170s'
    AS $_$
DECLARE
  v_club uuid;
  v_rows integer;
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM club_member_daily_stats WHERE table_id = p_table_id;
  DELETE FROM public.club_member_table_state WHERE table_id=p_table_id;

  WITH hseq AS (
    SELECT hh.id AS hand_id, hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
           coalesce(hh.rake_amount, 0) + coalesce(hh.bbj_amount, 0) AS rake_bbj,
           hh.players, hh.winners,
           row_number() OVER (ORDER BY hh.hand_number, hh.created_at) AS rn
    FROM hand_history hh
    WHERE hh.table_id = p_table_id AND public.fn_ca_launch_accounting_accepts(v_club,hh.created_at)
  ),
  seats AS (
    SELECT
      h.rn, h.created_at, h.pot_size, h.rake_bbj,
      (p->>'userId')::uuid   AS uid,
      (p->>'stack')::numeric AS stack,
      coalesce((SELECT sum((w->>'amount')::numeric)
                FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w
                WHERE w->>'userId' = p->>'userId'), 0) AS won,
      (SELECT CASE WHEN jsonb_typeof(hac.post_commit_payload->'promo_playthrough') = 'array'
                   THEN CASE WHEN hac.post_commit_payload->'promo_playthrough' <> '[]'::jsonb
                             THEN COALESCE((SELECT sum((x->>'wagered')::numeric)
                                              FROM jsonb_array_elements(hac.post_commit_payload->'promo_playthrough') x
                                             WHERE lower(x->>'user_id') = lower(p->>'userId')), 0)
                        END
              END
         FROM hand_atomic_commits hac
        WHERE hac.hand_id = h.hand_id) AS wagered
    FROM hseq h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) p
    WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  d AS (
    SELECT s.*,
           lag(stack) OVER (PARTITION BY uid ORDER BY rn) AS prev_stack,
           lag(rn)    OVER (PARTITION BY uid ORDER BY rn) AS prev_rn
    FROM seats s
  ),
  marked AS (
    SELECT d.*,
           (prev_rn = rn - 1) AS adjacent,
           CASE WHEN prev_stack IS NOT NULL THEN stack - prev_stack ELSE 0 END AS delta
    FROM d
  ),
  per_hand AS (
    SELECT rn,
           count(*) AS seated,
           count(*) FILTER (WHERE prev_stack IS NOT NULL) AS with_prior,
           coalesce(sum(delta) FILTER (WHERE prev_stack IS NOT NULL), 0) AS dsum,
           max(rake_bbj) AS rake_bbj
    FROM marked GROUP BY rn
  ),
  calc AS (
    SELECT
      m.uid,
      (m.created_at AT TIME ZONE 'UTC')::date AS stat_date,
      m.won, m.pot_size, m.delta,
      m.won - m.wagered AS exact_net,
      CASE
        WHEN ph.seated = ph.with_prior THEN abs(ph.dsum + ph.rake_bbj) < 0.005
        ELSE m.adjacent AND m.delta <= m.won + 0.001
      END AS attributable
    FROM marked m JOIN per_hand ph ON ph.rn = m.rn
  )
  INSERT INTO club_member_daily_stats
    (club_id, table_id, user_id, stat_date, hands_played, hands_attributed, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, p_table_id, uid, stat_date,
    count(*),
    count(*) FILTER (WHERE exact_net IS NOT NULL OR attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(CASE WHEN exact_net IS NOT NULL THEN exact_net
                      WHEN attributable THEN delta ELSE 0 END), 0),
    max(won), max(pot_size),
    coalesce(sum(delta - won) FILTER (WHERE NOT attributable AND delta > won), 0)
  FROM calc
  GROUP BY uid, stat_date
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played     = EXCLUDED.hands_played,
    hands_attributed = EXCLUDED.hands_attributed,
    hands_won        = EXCLUDED.hands_won,
    total_won        = EXCLUDED.total_won,
    profit           = EXCLUDED.profit,
    biggest_pot_won  = EXCLUDED.biggest_pot_won,
    biggest_pot      = EXCLUDED.biggest_pot,
    topup_total      = EXCLUDED.topup_total,
    updated_at       = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  WITH last_hand AS (
    SELECT hh.players, hh.hand_number
    FROM hand_history hh
    WHERE hh.table_id = p_table_id AND public.fn_ca_launch_accounting_accepts(v_club,hh.created_at)
    ORDER BY hh.hand_number DESC
    LIMIT 1
  )
  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         p_table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, lh.hand_number
  FROM last_hand lh
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(lh.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, rows_written)
  VALUES (p_table_id, now(), v_rows)
  ON CONFLICT (table_id) DO UPDATE SET rebuilt_at = now(), rows_written = EXCLUDED.rows_written;

  RETURN v_rows;
END;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_project_hand_side_effects_after_post_commit_20260908' AND md5(p.prosrc)='0398216bd62d064c3f3fba9c13bd0472')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_project_hand_side_effects_after_post_commit_20260908'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_h public.hand_history%ROWTYPE;
  v_club uuid;
  v_date date;
  v_tourney boolean;
  v_bb numeric;
  v_diamond boolean;
  v_promo jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects is engine/service only';
  END IF;

  -- The durable outbox row is also the claim.  Locking it keeps the additive
  -- projections and its DELETE in one transaction: a crash rolls both back;
  -- a concurrent worker waits, then finds no row and cannot run them twice.
  SELECT h.* INTO v_h
    FROM public.hand_projection_outbox o
    JOIN public.hand_history h ON h.id=o.hand_id
   WHERE o.hand_id=p_hand_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_pending','hand_id',p_hand_id);
  END IF;

  -- One table's club-member projection carries prior-stack state.  Serialise
  -- it and refuse to leapfrog an earlier durable hand from that table.
  PERFORM pg_advisory_xact_lock(hashtextextended('hand-projection:'||v_h.table_id::text,0));
  IF EXISTS (
    SELECT 1 FROM public.hand_projection_outbox earlier
     WHERE earlier.table_id=v_h.table_id
       AND earlier.hand_number<v_h.hand_number
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','predecessor_pending');
  END IF;

  SELECT t.club_id, (t.tournament_id IS NOT NULL), c.asset='diamonds'
    INTO v_club, v_tourney, v_diamond
    FROM public.tables t JOIN public.clubs c ON c.id=t.club_id WHERE t.id=v_h.table_id;
  v_tourney := COALESCE(v_tourney,false) OR (v_h.tournament_id IS NOT NULL);
  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;

  -- A seat's result for THIS hand is what it won minus what it put in. The
  -- accepted-hand envelope lists every contributor's chips in, written in the
  -- same transaction as the hand. No envelope list, no exact figure.
  SELECT c.post_commit_payload->'promo_playthrough' INTO v_promo
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = v_h.id;
  IF jsonb_typeof(v_promo) IS DISTINCT FROM 'array' THEN
    v_promo := NULL;
  ELSIF v_promo = '[]'::jsonb THEN
    v_promo := NULL;
  END IF;

  -- Projection 1: club member/table/day state.  This is the current live
  -- trigger body, with NEW replaced by the immutable hand row selected above.
  IF v_club IS NOT NULL AND NOT COALESCE(v_diamond,false)
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at) THEN
    WITH pl AS (
      SELECT DISTINCT ON (p->>'userId')
             (p->>'userId')::uuid AS uid, (p->>'stack')::numeric AS stack
        FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
       WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND (p->>'stack') IS NOT NULL
    ), wn AS (
      SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
        FROM jsonb_array_elements(coalesce(v_h.winners,'[]'::jsonb)) w
       WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ), base AS (
      SELECT pl.uid, pl.stack, coalesce(wn.won,0) AS won, st.last_stack,
             (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
              AND v_h.hand_number IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.hand_history h2
                 WHERE h2.table_id=v_h.table_id
                   AND h2.hand_number>st.last_hand_number
                   AND h2.hand_number<v_h.hand_number)) AS adjacent
        FROM pl
        LEFT JOIN wn ON wn.uid=pl.uid
        LEFT JOIN public.club_member_table_state st
          ON st.table_id=v_h.table_id AND st.user_id=pl.uid
    ), agg AS (
      SELECT count(*) AS seated,
             count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
             coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
        FROM base
    ), calc AS (
      SELECT b.uid,b.won,
             CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
             CASE WHEN a.seated=a.with_prior
                  THEN abs(a.dsum+coalesce(v_h.rake_amount,0)+coalesce(v_h.bbj_amount,0))<0.005
                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable,
             CASE WHEN v_promo IS NOT NULL
                  THEN b.won - COALESCE((SELECT sum((x->>'wagered')::numeric)
                                           FROM jsonb_array_elements(v_promo) x
                                          WHERE lower(x->>'user_id') = b.uid::text), 0)
             END AS exact_net
        FROM base b CROSS JOIN agg a
    )
    INSERT INTO public.club_member_daily_stats AS s
      (club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
       total_won,profit,biggest_pot_won,biggest_pot,topup_total)
    SELECT v_club,v_h.table_id,calc.uid,v_date,1,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL OR calc.attributable THEN 1 ELSE 0 END,
           CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL THEN calc.exact_net
                WHEN calc.attributable THEN calc.delta ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 ELSE coalesce(v_h.pot_size,0) END,
           CASE WHEN v_tourney THEN 0
                WHEN NOT calc.attributable AND calc.delta>calc.won THEN calc.delta-calc.won
                ELSE 0 END
      FROM calc
    ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
      hands_played=s.hands_played+1,
      hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
      hands_won=s.hands_won+EXCLUDED.hands_won,
      total_won=s.total_won+EXCLUDED.total_won,
      profit=s.profit+EXCLUDED.profit,
      biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
      biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
      topup_total=s.topup_total+EXCLUDED.topup_total,
      updated_at=now();

    INSERT INTO public.club_member_table_state AS st
      (table_id,user_id,last_stack,last_hand_number)
    SELECT DISTINCT ON (p->>'userId')
           v_h.table_id,(p->>'userId')::uuid,(p->>'stack')::numeric,v_h.hand_number
      FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
    ON CONFLICT (table_id,user_id) DO UPDATE SET
      last_stack=EXCLUDED.last_stack,
      last_hand_number=EXCLUDED.last_hand_number,
      updated_at=now();

    INSERT INTO public.club_hand_daily_shard AS d
      (club_id,stat_date,shard,hands,rake,bbj,pot_total)
    VALUES (
      v_club,v_date,(pg_backend_pid()%16)::smallint,1,
      coalesce(v_h.rake_amount,0),coalesce(v_h.bbj_amount,0),coalesce(v_h.pot_size,0))
    ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
      hands=d.hands+1,
      rake=d.rake+EXCLUDED.rake,
      bbj=d.bbj+EXCLUDED.bbj,
      pot_total=d.pot_total+EXCLUDED.pot_total,
      updated_at=now();
  END IF;

  -- Projection 2: legacy player_stats fold/winnings totals (cash only).
  IF NOT COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL
     AND v_club IS NOT NULL
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at)
     AND jsonb_typeof(v_h.players)='array'
     AND jsonb_array_length(v_h.players)>0 THEN
    v_bb := greatest(coalesce(v_h.big_blind,0),0);
    WITH seated AS (
      SELECT DISTINCT (pl->>'userId') AS uid
        FROM jsonb_array_elements(v_h.players) pl
       WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ), won AS (
      SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_h.winners)='array' THEN v_h.winners ELSE '[]'::jsonb END) w
       WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND coalesce((w->>'amount')::numeric,0)>0
       GROUP BY 1
    )
    INSERT INTO public.player_stats AS ps
      (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
    SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
      FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
     WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
     ORDER BY s.uid::uuid
    ON CONFLICT (user_id,club_id) DO UPDATE SET
      hands_dealt=ps.hands_dealt+EXCLUDED.hands_dealt,
      sum_big_blind=ps.sum_big_blind+EXCLUDED.sum_big_blind,
      total_winnings=ps.total_winnings+EXCLUDED.total_winnings,
      updated_at=now();
  END IF;

  -- Projection 3: positional aggregates.
  -- Positional profit has no asset dimension. Keep Diamond amounts out of
  -- that legacy aggregate; exact per-hand facts below retain its history.
  IF NOT COALESCE(v_diamond,false) THEN
    PERFORM public.fn_process_hand_position_stats(v_h.players,v_h.actions,v_h.winners);
  END IF;

  -- Projection 3b: immutable private Stats facts.
  PERFORM public.ca_project_hand_stats_facts(v_h.id);

  -- Projection 4: exact per-hand stats materialisation and player index.
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,v_h.created_at,v_h.id
    FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ORDER BY 1, 3
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_hand_player_stat AS hs (
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT
    f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f
  ORDER BY f.user_id, f.hand_id
  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Projection 4b: the Diamond leaderboard's running totals (migration
  -- 20260930043000). The stat rows keep a player's newest 1,000 hands of an
  -- asset, so a window cannot be read back from them; this keeps what
  -- Projection 2 keeps for chips (cash hands, seats with a profile): hands,
  -- won, put in and the big blind, per player per UTC day, from this hand's
  -- Diamond stat rows whichever writer wrote them. Player order, as every
  -- stat writer. A chip hand never enters this branch.
  IF COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL AND v_club IS NOT NULL THEN
    INSERT INTO public.ca_diamond_player_day AS dd
      (user_id,stat_date,hands_dealt,total_winnings,total_losses,sum_big_blind,updated_at)
    SELECT s.user_id,v_date,1,s.won_amt,s.invested_actions+s.my_blind,
           greatest(coalesce(v_h.big_blind,0),0),now()
      FROM public.ca_hand_player_stat s
     WHERE s.hand_id=v_h.id AND s.asset='diamonds' AND s.is_cash
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.user_id)
     ORDER BY s.user_id
    ON CONFLICT (user_id,stat_date) DO UPDATE SET
      hands_dealt=dd.hands_dealt+EXCLUDED.hands_dealt,
      total_winnings=dd.total_winnings+EXCLUDED.total_winnings,
      total_losses=dd.total_losses+EXCLUDED.total_losses,
      sum_big_blind=dd.sum_big_blind+EXCLUDED.sum_big_blind,
      updated_at=now();
  END IF;

  -- Daily Mission booking has its own durable outbox. The hand-history
  -- trigger above only inserts those rows; it never takes a player/profile
  -- lock, and this stats projector must not become a second synchronous
  -- consumer. fn_drain_daily_challenge_event_outbox owns booking exactly once.

  DELETE FROM public.hand_projection_outbox o WHERE o.hand_id=v_h.id;

  RETURN jsonb_build_object('ok',true,'hand_id',v_h.id,'hand_number',v_h.hand_number);
END;
$_$;

-- Component: accounting-component/commission-assertion-wiring.sql
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_assert_cash_commission_period' AND md5(p.prosrc)='526bd0e2919315f0b26f2d4a30e06dec')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_assert_cash_commission_period'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
   AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
   AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
     OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
      OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
   AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
  AND (b.status IS DISTINCT FROM 'accrued'))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_settle_accounting_commission_stage' AND md5(p.prosrc)='c7aa8c375a127824bf6b4601b02efdba')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_settle_accounting_commission_stage'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;v4_ok boolean:=true;v_comb jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 -- WEEKLY CLOSE SCALE (20260928): one read of the week's sources keeps only
 -- what this stage uses (tiers, the contract's club and each row's own md5),
 -- instead of copying every full contract into a temp table. The fingerprint
 -- is the same md5 over the same per-row md5s in the same order. Anything
 -- this path cannot read exactly as the original did is answered by the
 -- original, byte-for-byte, as public.fn_settle_accounting_commission_stage_v3.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan below
 -- is combined from the week's proved two-hour windows
 -- (fn_settle_accounting_commission_window, fn_settle_accounting_commission_combine),
 -- exactly as these reads build it; outside one, or with any window missing,
 -- the week is read here as before.
 v_comb:=CASE WHEN COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  THEN public.fn_settle_accounting_commission_combine(p_scope_kind,p_scope_id,p_period_start,p_period_end) END;
 IF v_comb IS NOT NULL THEN
  IF (v_comb->>'read_failed')::boolean THEN
   RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  fingerprint:=v_comb->>'fingerprint'; source_count:=(v_comb->>'sources')::int;
  SELECT * INTO previous FROM public.accounting_routed_settlement_runs
   WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
  IF FOUND THEN
   IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
   RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'unclassified')::bigint>0 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
  -- A contract only the original v3 path can read is not paid from windows,
  -- and v3 is never run here in one long transaction: nothing is paid.
  IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'hierarchy_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
  IF (v_comb->>'entitlement_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 ELSE
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._routed_sources_v4;
  INSERT INTO pg_temp._routed_sources_v4 SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type||'',source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 -- Any source matching (type,id,club,earned_at=created_at) of a commission row
 -- of these clubs created this week is itself one of these clubs' sources
 -- earned this week, so one hashed read of that slice answers every row. The
 -- tests are counted, not EXISTS: an EXISTS is planned for its first row and
 -- a clean book has none, so it would be a nested loop over the whole week.
 IF (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(scope.club_ids) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
  SELECT count(*) FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,p_period_start) AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL))>0
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 -- One set insert of every tier. A contract the original loop would refuse,
 -- or a tier value it would fail to read, is answered by the original.
 IF EXISTS(SELECT 1 FROM pg_temp._routed_sources_v4 s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text) THEN
  RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 END IF;
 BEGIN
  INSERT INTO pg_temp._routed_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM pg_temp._routed_sources_v4 s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 ANALYZE pg_temp._routed_tiers;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 -- Every commission row of every source, read once by its (source_id,
 -- source_type) index in source order, whatever its club or time; the three
 -- original tests are then answered from that set.
 CREATE TEMP TABLE IF NOT EXISTS _routed_ac_v4(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_ac_v4;
 INSERT INTO pg_temp._routed_ac_v4 SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._routed_sources_v4 s ORDER BY s.source_id,s.source_type) s
  CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
   WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
 ANALYZE pg_temp._routed_ac_v4;
 IF (SELECT count(*) FROM pg_temp._routed_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_ac_v4 ac
    WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
     AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL))>0
  OR (SELECT count(*) FROM pg_temp._routed_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._routed_ac_v4 ac GROUP BY 1,2,3) c
    ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
   WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)>0
  OR (SELECT count(*) FROM pg_temp._routed_ac_v4 ac
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))>0
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 -- The same per-tier running sum (depth is unique within a source).
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum(t.upto),min(t.role)
 FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
  FROM pg_temp._routed_tiers t) t
 LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum(t.upto)>0;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT club_id FROM pg_temp._routed_sources_v4;
 END IF;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing club member wallet and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $$;

-- Component: reset-undo-component/bbj-reporting.sql
-- Scope-local launch statistics from retained immutable BBJ testimony.
-- Monetary reconciliation and cumulative allocation carry are unchanged.


DO $qualified_originals$
DECLARE signature text; expected text; observed text;
BEGIN
 FOR signature,expected IN SELECT * FROM (VALUES
 ('public.fn_bbj_analytics(uuid)','d5675ff99b3b6d17ab73f0c6178156b0'),
 ('public.fn_bbj_mini_for_club(uuid)','47fb3991b934a1d22f35b50df71520e9')) x(signature,expected) LOOP
  SELECT md5(pg_get_functiondef(signature::regprocedure)) INTO observed;
  IF observed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'LAUNCH_BBJ_REPORTER_ORIGINAL_CHANGED: %',signature; END IF;
 END LOOP;
END $qualified_originals$;
CREATE FUNCTION public.fn_ca_launch_bbj_reporting_start(p_pool uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(max(o.captured_at),'-infinity'::timestamptz)
 FROM public.ca_launch_reset_operations o
 JOIN public.ca_launch_reset_rows r ON r.operation_id=o.operation_id
 WHERE o.state='executed' AND r.relation_name='bbj_pools'
 AND r.row_key=jsonb_build_object('id',p_pool);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_bbj_reporting_start(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE VIEW public.ca_launch_bbj_reporting_contributions WITH(security_invoker=true) AS
 SELECT c.* FROM public.bbj_contributions c WHERE c.created_at>=public.fn_ca_launch_bbj_reporting_start(c.pool_id);
CREATE VIEW public.ca_launch_bbj_reporting_winners WITH(security_invoker=true) AS
 SELECT w.* FROM public.bbj_winners w WHERE w.awarded_at>=public.fn_ca_launch_bbj_reporting_start(w.pool_id);
REVOKE ALL ON public.ca_launch_bbj_reporting_contributions,public.ca_launch_bbj_reporting_winners FROM PUBLIC,anon,authenticated,service_role;
DO $reporters$
DECLARE old_def text; new_def text; original_window text; scoped_window text;
BEGIN
 SELECT pg_get_functiondef('public.fn_bbj_analytics(uuid)'::regprocedure) INTO old_def;
 IF (length(old_def)-length(replace(old_def,'public.bbj_contributions','')))/length('public.bbj_contributions')<>1
 OR (length(old_def)-length(replace(old_def,'public.bbj_winners','')))/length('public.bbj_winners')<>3 THEN RAISE EXCEPTION 'LAUNCH_BBJ_ANALYTICS_SHAPE_CHANGED'; END IF;
 new_def:=replace(replace(old_def,'public.bbj_contributions','public.ca_launch_bbj_reporting_contributions'),'public.bbj_winners','public.ca_launch_bbj_reporting_winners');
 EXECUTE new_def;
 SELECT pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure) INTO old_def;
 IF (length(old_def)-length(replace(old_def,'public.bbj_contributions','')))/length('public.bbj_contributions')<>1
 OR (length(old_def)-length(replace(old_def,'public.bbj_winners','')))/length('public.bbj_winners')<>4 THEN RAISE EXCEPTION 'LAUNCH_BBJ_MINI_REPORTER_SHAPE_CHANGED'; END IF;
 new_def:=replace(replace(old_def,'public.bbj_contributions','public.ca_launch_bbj_reporting_contributions'),'public.bbj_winners','public.ca_launch_bbj_reporting_winners');
 -- The legacy outside-scope window remains precisely unchanged. For this
 -- launch it measures the new reporting age, bounded by the same .5..7 days.
 original_window:=substring(new_def from strpos(new_def,E'  win AS (') for strpos(new_def,E'  flow AS (')-strpos(new_def,E'  win AS ('));
 scoped_window:=E'  win AS (\n    SELECT CASE WHEN public.fn_ca_launch_bbj_reporting_start(pool.pool_id)>''-infinity''::timestamptz THEN\n      GREATEST(0.5,LEAST(7.0,extract(epoch FROM(now()-public.fn_ca_launch_bbj_reporting_start(pool.pool_id)))/86400.0))\n      ELSE GREATEST(0.5,LEAST(7.0,COALESCE(extract(epoch FROM(now()-(SELECT min(w.awarded_at) FROM public.bbj_winners w WHERE w.kind=''mini'')))/86400.0,7.0))) END AS days FROM pool\n  ),\n';
 IF original_window IS NULL OR length(original_window)<40 THEN RAISE EXCEPTION 'LAUNCH_BBJ_MINI_WINDOW_SHAPE_CHANGED'; END IF;
 new_def:=replace(new_def,original_window,scoped_window);
 EXECUTE new_def;
END $reporters$;

-- Component: floor-component/scoped-floor.sql
-- Scope the existing operator and original dealers to the authorized four clubs.
-- No new engine, publisher, dealer, watcher or refund path is introduced.


DO $guard$ BEGIN
IF md5(pg_get_functiondef('public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)'::regprocedure)) IS DISTINCT FROM '40c186edc95844d580834f047e252ce4' THEN RAISE EXCEPTION 'launch_operator_original_changed: fn_ca_engine_operator_command(uuid,uuid,text,text,text)'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_operator_floor_entry_guard()'::regprocedure)) IS DISTINCT FROM 'dde0cb0fb86c41b94ce8b531355759bb' THEN RAISE EXCEPTION 'launch_operator_original_changed: fn_ca_operator_floor_entry_guard()'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_operator_floor_state(uuid)'::regprocedure)) IS DISTINCT FROM 'e46680dd673ed1ca03c26f6d0ce201ce' THEN RAISE EXCEPTION 'launch_operator_original_changed: fn_ca_operator_floor_state(uuid)'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '367488e3f6ef4714b6c2bca3e8068065' THEN RAISE EXCEPTION 'launch_operator_original_changed: fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'; END IF;
END $guard$;
CREATE TABLE public.ca_launch_operator_scopes(operation_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.ca_launch_operator_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_operator_scopes FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_operator_scope_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'launch_operator_scope_immutable'; END $$;
CREATE TRIGGER launch_operator_scope_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_operator_scopes FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_operator_scope_immutable();
REVOKE ALL ON FUNCTION public.fn_ca_launch_operator_scope_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.ca_launch_floor_resume_receipts(table_id uuid NOT NULL,close_operation_id uuid NOT NULL,park_operation_id uuid NOT NULL,resume_operation_id uuid NOT NULL,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(table_id,close_operation_id));
ALTER TABLE public.ca_launch_floor_resume_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_floor_resume_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_floor_resume_receipt_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_floor_resume_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_operator_scope_immutable();
CREATE FUNCTION public.fn_ca_launch_cash_close_resumed(p_table uuid,p_close uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ca_launch_floor_resume_receipts r
 JOIN public.ca_operator_table_closes c ON c.table_id=r.table_id AND c.operation_id=r.close_operation_id AND c.actor_id=r.actor_id AND c.status='closed'
 JOIN public.ca_engine_operator_commands done ON done.id=r.resume_operation_id AND done.actor_id=r.actor_id AND done.domain='floor' AND done.action='resume'
 JOIN public.ca_launch_operator_scopes park ON park.operation_id=r.park_operation_id AND park.actor_id=r.actor_id
 JOIN public.ca_launch_operator_scopes resume ON resume.operation_id=r.resume_operation_id AND resume.actor_id=r.actor_id AND resume.club_ids=park.club_ids
 JOIN public.tables t ON t.id=r.table_id AND t.tournament_id IS NULL AND (t.club_id=ANY(park.club_ids) OR t.union_id=ANY(park.club_ids))
 WHERE r.table_id=p_table AND r.close_operation_id=p_close);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cash_close_resumed(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_engine_operator_command(p_actor_id uuid, p_operation_id uuid, p_domain text, p_action text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb; v_close_targets uuid[];
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 v_permissions := public.fn_ca_operator_permissions(p_actor_id)->'permissions';
 IF jsonb_typeof(v_permissions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'engine_operator_authority_unknown' USING ERRCODE='58000'; END IF;
 IF NOT coalesce(v_permissions ? CASE WHEN p_domain='floor' THEN 'clubs.write' ELSE 'settings.write' END,false) THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 OR p_domain NOT IN ('floor','maintenance') THEN RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT * INTO v FROM public.ca_engine_operator_commands WHERE id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF v.actor_id<>p_actor_id OR v.domain<>p_domain THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  v_before:=to_jsonb(v);
  IF p_action IN ('cancel','end') AND p_domain='maintenance' THEN
   IF p_action='cancel' AND v.status='queued' AND clock_timestamp()<v.announced_at THEN
    UPDATE public.ca_engine_operator_commands SET status='cancelled',updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.cancel','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':cancel');
   ELSIF p_action='cancel' AND v.status<>'cancelled' THEN RAISE EXCEPTION 'maintenance_already_applied';
   ELSIF p_action='end' AND v.status NOT IN ('applying','active','completed') THEN RAISE EXCEPTION 'maintenance_request_not_applied';
   ELSIF p_action='end' AND clock_timestamp()<v.announced_at+interval '7 minutes' THEN RAISE EXCEPTION 'maintenance_deadline_not_reached';
   ELSIF p_action='end' AND v.end_requested_at IS NULL THEN
    UPDATE public.ca_engine_operator_commands SET end_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.end','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':end');
   END IF;
  ELSIF v.action<>p_action OR v.reason<>p_reason THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  RETURN to_jsonb(v);
 END IF;
 IF p_domain='maintenance' AND p_action='start' THEN
  v_announcement:=date_trunc('hour',clock_timestamp())+interval '53 minutes';
  IF v_announcement<=clock_timestamp() THEN v_announcement:=v_announcement+interval '1 hour'; END IF;
  IF EXISTS(SELECT 1 FROM public.ca_engine_operator_commands WHERE domain='maintenance' AND status='queued') THEN RAISE EXCEPTION 'maintenance_request_already_queued'; END IF;
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status,announced_at,result,created_at,updated_at) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'queued',v_announcement,NULL,clock_timestamp(),clock_timestamp()) RETURNING * INTO v;
 ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  IF p_action='close_cash' THEN
   -- Capture and lock the original full target set; never silently omit custody.
   SELECT coalesce(array_agg(t.id ORDER BY t.id),ARRAY[]::uuid[]) INTO v_close_targets
   FROM (SELECT id FROM public.tables st WHERE tournament_id IS NULL AND status IN ('running','active','waiting') AND (NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_operation_id AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids)))) ORDER BY id FOR UPDATE) t;
   IF EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_close_targets) AND
      (is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash')) THEN
    RAISE EXCEPTION 'cash_floor_close_target_not_executable' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'accepted') RETURNING * INTO v;
  IF p_action='resume' THEN DELETE FROM public.ca_operator_floor_hold WHERE id=true;
  ELSIF p_action IN ('pause','park') THEN
   INSERT INTO public.ca_operator_floor_hold VALUES(true,p_operation_id,p_action,p_reason) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,mode=excluded.mode,reason=excluded.reason;
  ELSE
   IF EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE status='pending') THEN RAISE EXCEPTION 'cash_floor_close_in_progress'; END IF;
   INSERT INTO public.ca_operator_table_closes(table_id,operation_id,actor_id,reason)
    SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE id=ANY(v_close_targets)
    ON CONFLICT(table_id) DO UPDATE SET operation_id=excluded.operation_id,actor_id=excluded.actor_id,reason=excluded.reason,status='pending' WHERE public.ca_operator_table_closes.status='closed';
   UPDATE public.ca_engine_operator_commands SET status=CASE WHEN EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id) THEN 'accepted' ELSE 'completed' END,result=jsonb_build_object('targetedTables',(SELECT count(*) FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id),'scope','cash_tables_only') WHERE id=p_operation_id RETURNING * INTO v;
  END IF;
 ELSE RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.'||p_domain||'.'||p_action,'engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason,'operation_id',v.id),NULL,to_jsonb(v),NULL,NULL,v.id::text||':'||p_action);
 RETURN to_jsonb(v);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_entry_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 -- Seat admission and floor commands share the original transaction edge.
 PERFORM pg_advisory_xact_lock_shared(530093);
 IF NEW.left_at IS NULL AND (TG_OP='INSERT' OR OLD.left_at IS NOT NULL OR NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id) AND
 (EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h WHERE h.mode='park' AND (NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m JOIN public.tables st ON st.id=NEW.table_id WHERE m.operation_id=h.operation_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))) OR EXISTS(SELECT 1 FROM public.ca_operator_table_closes c WHERE c.table_id=NEW.table_id AND public.fn_ca_launch_cash_close_resumed(c.table_id,c.operation_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED' USING ERRCODE='55006';
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('hold',(SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h WHERE NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id AND EXISTS(SELECT 1 FROM public.tables st WHERE st.id=p_table_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530093);
  IF EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id JOIN public.tournaments t ON t.id=COALESCE(p_tournament_id,(SELECT tournament_id FROM public.tables WHERE id=p_table_id)) WHERE h.mode='park' AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids)) AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  -- DIAMOND PHASE 11: every seat's player takes the table-cap lock before the
  -- Daily Missions lock, which locks the player's profile row. Every cash seat
  -- door, chip and Diamond, takes table_cap first; for a Diamond player the
  -- profile row is the wallet, and one player's chip entry, Diamond entry and
  -- Diamond cash seat meet on these two locks, so the order is one for every
  -- event whatever its asset. The roster trigger's own table_cap is re-entrant.
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$
;
CREATE FUNCTION public.fn_ca_launch_operator_command(p_actor uuid,p_operation uuid,p_action text,p_reason text,p_owned_park uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing public.ca_launch_operator_scopes; current_hold public.ca_operator_floor_hold;
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' OR p_operation IS NULL OR p_actor IS NULL OR p_action NOT IN('park','close_cash','resume') THEN RAISE EXCEPTION 'launch_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT * INTO existing FROM public.ca_launch_operator_scopes WHERE operation_id=p_operation;
 IF FOUND AND existing.actor_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'launch_operator_identity_conflict'; END IF;
 IF p_action='resume' AND EXISTS(SELECT 1 FROM public.ca_engine_operator_commands c WHERE c.id=p_operation AND c.actor_id=p_actor AND c.domain='floor' AND c.action='resume') THEN RETURN public.fn_ca_engine_operator_command(p_actor,p_operation,'floor',p_action,p_reason); END IF;
 SELECT * INTO current_hold FROM public.ca_operator_floor_hold;
 IF p_action='park' AND current_hold.operation_id IS NOT NULL AND current_hold.operation_id IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'launch_operator_other_hold_active'; END IF;
 IF p_action IN('close_cash','resume') AND (p_owned_park IS NULL OR current_hold.operation_id IS DISTINCT FROM p_owned_park OR NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_owned_park AND m.actor_id=p_actor)) THEN RAISE EXCEPTION 'launch_operator_own_park_required'; END IF;
 INSERT INTO public.ca_launch_operator_scopes(operation_id,actor_id,club_ids) VALUES(p_operation,p_actor,ARRAY['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']::uuid[]) ON CONFLICT(operation_id) DO NOTHING;
 IF p_action='resume' THEN
  IF EXISTS(SELECT 1 FROM public.ca_operator_table_closes c JOIN public.ca_launch_operator_scopes m ON m.operation_id=c.operation_id JOIN public.ca_engine_operator_commands cmd ON cmd.id=c.operation_id JOIN public.ca_engine_operator_commands parkcmd ON parkcmd.id=p_owned_park WHERE m.actor_id=p_actor AND c.actor_id=p_actor AND cmd.created_at>=parkcmd.created_at AND c.status='pending') THEN RAISE EXCEPTION 'launch_operator_pending_closes'; END IF;
  INSERT INTO public.ca_launch_floor_resume_receipts(table_id,close_operation_id,park_operation_id,resume_operation_id,actor_id)
  SELECT c.table_id,c.operation_id,p_owned_park,p_operation,p_actor FROM public.ca_operator_table_closes c
  JOIN public.ca_launch_operator_scopes m ON m.operation_id=c.operation_id AND m.actor_id=p_actor
  JOIN public.ca_engine_operator_commands cmd ON cmd.id=c.operation_id AND cmd.actor_id=p_actor AND cmd.domain='floor' AND cmd.action='close_cash' AND cmd.status='completed'
  JOIN public.ca_engine_operator_commands parkcmd ON parkcmd.id=p_owned_park
  JOIN public.tables t ON t.id=c.table_id AND t.tournament_id IS NULL AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids))
  WHERE c.actor_id=p_actor AND c.status='closed' AND cmd.created_at>=parkcmd.created_at
  ON CONFLICT(table_id,close_operation_id) DO NOTHING;
 END IF;
 RETURN public.fn_ca_engine_operator_command(p_actor,p_operation,'floor',p_action,p_reason);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_operator_command(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_operator_command(uuid,uuid,text,text,uuid) TO service_role;

-- Component: accounting-component/floor-original-acl.sql
-- Preserve the original floor readers' absence of pre-login execution.

REVOKE EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid),public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) FROM PUBLIC,anon;

-- Component: accounting-component/floor-admission-component.sql
-- Finish the same scoped park at the actual tournament creation/launch write edges.
-- Existing started/played events keep original completion, seats and rebuy authorities.
CREATE FUNCTION public.fn_ca_launch_tournament_held(p_club uuid,p_union uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Original global admission lane precedes the operator floor on direct and nested routes.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM pg_advisory_xact_lock_shared(530093);
 -- VOLATILE: read a fresh snapshot after a competing exclusive park committed.
 RETURN EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id
  WHERE h.mode='park' AND (p_club=ANY(m.club_ids) OR p_union=ANY(m.club_ids)));
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_held(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_tournament_has_started(p_tournament uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament
  AND (t.started_at IS NOT NULL OR upper(COALESCE(t.status,'')) IN('RUNNING','BREAK','COMPLETING','COMPLETED') OR COALESCE(t.spin_multiplier,0)>0))
  OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts r WHERE r.tournament_id=p_tournament AND r.completed_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r WHERE r.tournament_id=p_tournament)
  OR EXISTS(SELECT 1 FROM public.spin_reserve_ledger r WHERE r.tournament_id=p_tournament AND r.kind='jackpot_draw')
  OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.tournament_id=p_tournament)
  OR EXISTS(SELECT 1 FROM public.tables t JOIN public.hand_history h ON h.table_id=t.id WHERE t.tournament_id=p_tournament);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_has_started(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_tournament_start_refused(p_tournament uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t record;
BEGIN
 -- Original global admission lane precedes the operator floor on direct and nested routes.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM pg_advisory_xact_lock_shared(530093);
 SELECT club_id,union_id INTO t FROM public.tournaments WHERE id=p_tournament;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN public.fn_ca_launch_tournament_held(t.club_id,t.union_id)
  AND public.fn_ca_launch_tournament_has_started(p_tournament) IS NOT TRUE;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_start_refused(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_tournament_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.fn_ca_launch_tournament_held(NEW.club_id,NEW.union_id) THEN RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament creation' USING ERRCODE='55006'; END IF;
 ELSIF (NEW.club_id,NEW.union_id) IS DISTINCT FROM (OLD.club_id,OLD.union_id)
  AND public.fn_ca_launch_tournament_held(NEW.club_id,NEW.union_id) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament scope admission' USING ERRCODE='55006';
 ELSIF ((OLD.started_at IS NULL AND NEW.started_at IS NOT NULL)
  OR (upper(COALESCE(NEW.status,'')) IN('RUNNING','BREAK','COMPLETING','COMPLETED') AND upper(COALESCE(OLD.status,'')) NOT IN('RUNNING','BREAK','COMPLETING','COMPLETED'))
  OR (COALESCE(OLD.spin_multiplier,0)<=0 AND COALESCE(NEW.spin_multiplier,0)>0))
  AND public.fn_ca_launch_tournament_start_refused(OLD.id) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament start' USING ERRCODE='55006';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_admission_guard() FROM PUBLIC,anon,authenticated,service_role;
-- Run after original union ownership/format stamping; do not alter any original guard.
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES('tournaments','zzzzzzzz_launch_tournament_admission','Owner scoped launch hold: refuse new tournament creation and first start after original ownership stamping; already played games retain original finish and payout authorities');
CREATE TRIGGER zzzzzzzz_launch_tournament_admission BEFORE INSERT OR UPDATE OF club_id,union_id,status,started_at,spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_tournament_admission_guard();

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_begin_tournament_launch_before_lease_generation' AND md5(p.prosrc)='6cc03b69671fc2a1aa6c998717d513af')<>1 THEN RAISE EXCEPTION 'launch_admission_source_changed: fn_begin_tournament_launch_before_lease_generation'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_before_lease_generation(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    SET statement_timeout TO '30s'
    AS $$
DECLARE
  v_existing public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_tournament_started_at timestamptz;
  v_requested_started_at timestamptz := COALESCE(p_started_at, transaction_timestamp());
BEGIN
  IF public.fn_ca_launch_tournament_start_refused(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_tournament_id IS NULL OR p_launch_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT * INTO v_existing
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF p_started_at IS NOT NULL
       AND v_existing.launch_id = p_launch_id
       AND v_existing.started_at IS DISTINCT FROM p_started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_request_mismatch');
    END IF;
    SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR (v_existing.completed_at IS NULL AND v_status <> 'REGISTERING')
       OR (v_existing.completed_at IS NOT NULL
           AND (v_status <> 'RUNNING'
                OR v_tournament_started_at IS DISTINCT FROM v_existing.started_at)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', true,
      'launch_id', v_existing.launch_id,
      'replay', true,
      'started_at', v_existing.started_at,
      'completed', v_existing.completed_at IS NOT NULL,
      'status', v_status
    );
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_status <> 'REGISTERING' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_status_changed',
      'status', v_status
    );
  END IF;
  IF v_tournament_started_at IS NOT NULL
     AND v_tournament_started_at IS DISTINCT FROM v_requested_started_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_started_at_mismatch');
  END IF;

  INSERT INTO public.tournament_launch_receipts (
    tournament_id, launch_id, started_at
  ) VALUES (
    p_tournament_id, p_launch_id, v_requested_started_at
  );

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'launch_id', p_launch_id,
    'replay', false,
    'started_at', v_requested_started_at,
    'completed', false
  );
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_spin_draw_and_settle_atomic' AND md5(p.prosrc)='ca8efa14ebf6652efb417bb7cc549986')<>1 THEN RAISE EXCEPTION 'launch_admission_source_changed: fn_spin_draw_and_settle_atomic'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_rule_manifest jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    SET statement_timeout TO '30s'
    AS $$
DECLARE
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_launch public.tournament_launch_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_player record;
  v_entrants jsonb;
  v_paid numeric;
  v_entitled numeric;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_gross numeric;
  v_manifest jsonb;
  v_hash text;
  v_tier jsonb;
  v_draw jsonb;
  v_settle jsonb;
  v_entry jsonb;
  v_receipt jsonb;
  v_multiplier numeric;
  v_prize numeric;
  v_count bigint;
  v_covered numeric;
  v_provenance text := 'at_draw';
  v_blinds jsonb;
  v_payouts jsonb;
  v_locked jsonb;
  v_freq numeric;
  v_weight numeric;
  v_played_recovery boolean := false;
  v_recovery jsonb;
  v_stamped integer;                                                  -- D2
BEGIN
  IF public.fn_ca_launch_tournament_start_refused(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  SELECT * INTO v_lease FROM public.engine_tournament_leases
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_lease.protocol_version IS DISTINCT FROM 2
     OR v_lease.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_lease.heartbeat_at IS NULL
     OR v_lease.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  -- Same receipt -> parent order as registration, launch and cancellation.
  PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(ARRAY[p_tournament_id]);
  SELECT * INTO v_launch FROM public.tournament_launch_receipts
   WHERE tournament_id = p_tournament_id;
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF v_launch.launch_id IS DISTINCT FROM p_launch_id
     OR v_launch.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_launch.completed_at IS NOT NULL
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_purchases_frozen');
  END IF;
  -- DIAMOND PHASE 9: A DIAMOND SPIN IS DRAWN BY ITS OWN ARM OF THIS ONE
  -- AUTHORITY. The lease, the launch receipt and the freeze above are this
  -- authority's and are proved for both assets. Past this line the chip
  -- proofs read wallet rows, an owner's reserve pool and the engine's
  -- manifest, none of which a Diamond Spin has: its arm proves three whole
  -- entries in custody, draws from the table its creation pinned, moves the
  -- reserve legs against the authorized source in whole Diamonds and writes
  -- the same immutable receipt and stamp, in this transaction.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_spin_draw(p_tournament_id, p_launch_id, p_lease_generation);
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR v_t.max_players IS DISTINCT FROM 3
     OR COALESCE(v_t.buy_in_amount, 0) <= 0
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;

  SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
           'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_entrants
    FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  -- A dealt Spin may have one proven busted/vacated original seat. This does
  -- not lower the fresh-launch field: the proof requires the original three
  -- paid identities, immutable money journals, a persisted hand, two exact
  -- live seats and conservation of all three bought starting stacks.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
               'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id
         AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;

  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND (p.status IN ('registered', 'playing')
            OR (v_played_recovery AND p.status = 'eliminated'))) <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- Spin admission proves net paid entries directly. The generic refund
  -- planner compares advertised entry fees with escrow.fee_entries_in, but
  -- Spin escrow records its embedded 8% rake there despite buy_in_fee=0.
  -- A payout/refund policy comparison cannot stand in for this payment proof.
  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  SELECT COALESCE(sum(w.amount), 0) INTO v_wallet_gross
    FROM public.wallet_transactions w WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit' AND lower(w.category) = 'tournament_buyin';
  IF v_escrow.tournament_id IS NULL OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;
  FOR v_player IN SELECT p.user_id FROM public.tournament_players p
    WHERE p.tournament_id = p_tournament_id
      AND (p.status IN ('registered', 'playing')
           OR (v_played_recovery AND p.status = 'eliminated'))
    ORDER BY p.user_id LOOP
    -- The wallet receipt proves what this player still paid, including any
    -- prior refund. Immutable entitlements independently prove the original
    -- debit's exact wallet -> tournament double-entry leg and its consumption.
    SELECT COALESCE(sum(CASE
      WHEN w.type='debit' AND lower(w.category)='tournament_buyin' THEN w.amount
      WHEN w.type='credit' AND lower(w.category) IN ('refund','tournament_refund') THEN -w.amount
      ELSE 0 END), 0) INTO v_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_player.user_id;
    SELECT COALESCE(sum(e.gross), 0) INTO v_entitled
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
       AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross
       AND l.tournament_id=e.tournament_id AND l.from_type='player_wallet'
       AND l.from_entity_id=e.user_id AND l.to_type='prize_liability'
       AND l.to_entity_id=e.tournament_id AND lower(l.category)=e.charge_category
     WHERE e.tournament_id=p_tournament_id AND e.user_id=v_player.user_id
       AND e.entitlement_kind='wallet_charge' AND e.charge_category='tournament_buyin'
       AND e.refund_fee=0 AND e.refund_bounty=0
       AND NOT EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=e.id);
    IF v_paid IS DISTINCT FROM v_t.buy_in_amount OR v_entitled IS DISTINCT FROM v_paid THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;

  SELECT * INTO v_saved FROM public.spin_draw_receipts WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id
       OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    -- A new owner or newer rules cannot reroll or rewrite a committed result.
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  SELECT count(*), min(l.multiplier), min(-l.amount)
    INTO v_count, v_multiplier, v_covered FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw';
  IF v_count > 0 THEN
    -- Cutover recovery uses the already projected rules. It does not pretend
    -- that a historical probability snapshot exists or replace it with today's.
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    IF v_count <> 1 OR v_multiplier IS DISTINCT FROM v_t.spin_multiplier
       OR v_covered IS DISTINCT FROM v_prize OR COALESCE(v_multiplier, 0) <= 0
       OR jsonb_typeof(v_t.blind_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.blind_structure::jsonb) = 0
       OR jsonb_typeof(v_t.payout_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.payout_structure::jsonb) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_spin_rules_unproven');
    END IF;
    v_provenance := 'legacy_projection';
    v_blinds := v_t.blind_structure::jsonb;
    v_payouts := v_t.payout_structure::jsonb;
    v_locked := COALESCE(v_t.spin_locked_tiers::jsonb, '[]'::jsonb);
    v_manifest := jsonb_build_object('version', 1, 'probability_snapshot', NULL,
      'buy_in', v_t.buy_in_amount, 'seats', 3, 'starting_chips', v_t.starting_chips,
      'multiplier', v_multiplier, 'blind_structure', v_blinds, 'payout_structure', v_payouts);
    v_settle := jsonb_build_object('pool_covered', v_covered, 'operator_shortfall', 0);
  ELSE
    -- D1 (C-stuck-spins): tournaments.spin_multiplier has DEFAULT 0 and the
    -- seat-first creator omits the column, so 0 is "undrawn" exactly as NULL
    -- is. Every other reader on the platform already uses COALESCE(...,0).
    -- A drawn multiplier is never 0 (all tiers >= 2; fn_spin_settle_game
    -- rejects <= 0). Only a POSITIVE projection without a funded draw is the
    -- case this refusal exists for.
    IF COALESCE(v_t.spin_multiplier, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'projected_spin_draw_has_no_funding_proof');
    END IF;
    v_manifest := p_rule_manifest;
    IF v_manifest IS NULL OR (v_manifest->>'version')::int IS DISTINCT FROM 1
       OR (v_manifest->>'buy_in')::numeric IS DISTINCT FROM v_t.buy_in_amount
       OR (v_manifest->>'seats')::int IS DISTINCT FROM 3
       OR (v_manifest->>'starting_chips')::int IS DISTINCT FROM v_t.starting_chips
       OR (v_manifest->>'rake_rate')::numeric IS DISTINCT FROM public.fn_spin_rake_rate(v_t.buy_in_amount)
       OR jsonb_typeof(v_manifest->'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_manifest->'tiers') = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;
    v_manifest := v_manifest || jsonb_build_object('draw_function_md5',
      md5(pg_get_functiondef('public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)'::regprocedure)));
    v_freq := 0; v_weight := 0;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_manifest->'tiers') LOOP
      IF jsonb_typeof(v_tier->'freq') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_tier->'multiplier') IS DISTINCT FROM 'number'
         OR COALESCE((v_tier->>'freq')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'multiplier')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'reserveThresholdX')::numeric, -1) < 0
         OR jsonb_typeof(v_tier->'blind_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'blind_structure') <> 12
         OR (v_tier#>>'{blind_structure,11,spinContinuation,version}')::int IS DISTINCT FROM 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorLevel}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorBigBlind}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,growth}')::numeric, 0) <= 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,roundBigTo}')::numeric, 0) <= 0
         OR jsonb_typeof(v_tier->'payout_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'payout_structure') NOT BETWEEN 1 AND 3
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'blind_structure') WITH ORDINALITY b(value, ordinal)
            WHERE (b.value->>'level')::numeric IS DISTINCT FROM b.ordinal::numeric
               OR COALESCE((b.value->>'smallBlind')::numeric, 0) <= 0
               OR COALESCE((b.value->>'bigBlind')::numeric, 0) < (b.value->>'smallBlind')::numeric
               OR COALESCE((b.value->>'duration')::numeric, 0) <= 0
               OR (b.value->>'ante')::numeric IS DISTINCT FROM 0::numeric)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'payout_structure') WITH ORDINALITY p(value, ordinal)
            WHERE (p.value->>'place')::numeric IS DISTINCT FROM p.ordinal::numeric
               OR COALESCE((p.value->>'percentage')::numeric, 0) <= 0)
         OR (SELECT sum((x->>'percentage')::numeric)
               FROM jsonb_array_elements(v_tier->'payout_structure') x) IS DISTINCT FROM 100::numeric THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
      END IF;
      v_freq := v_freq + (v_tier->>'freq')::numeric;
      v_weight := v_weight + (v_tier->>'freq')::numeric * (v_tier->>'multiplier')::numeric;
    END LOOP;
    IF v_weight <> v_freq * 3 * (1 - (v_manifest->>'rake_rate')::numeric)
       OR (SELECT count(DISTINCT x->>'multiplier') FROM jsonb_array_elements(v_manifest->'tiers') x)
           <> jsonb_array_length(v_manifest->'tiers') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;

    -- Entry owns escrow -> entry advisory -> reserve locks. Its committed net
    -- contribution must be present before the affordability gate is evaluated.
    v_entry := public.fn_spin_book_entry(p_tournament_id);
    IF NOT COALESCE((v_entry->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin entry booking failed: %', v_entry USING ERRCODE = 'P0404';
    END IF;
    IF (SELECT count(*) FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution'
           AND l.club_id=public.fn_spin_reserve_pool(v_t.club_id)
           AND l.seats=3 AND l.buy_in=v_t.buy_in_amount
           AND l.house_rake=round(3*v_t.buy_in_amount*(v_manifest->>'rake_rate')::numeric, 2)
           AND l.amount=round(3*v_t.buy_in_amount, 2)-l.house_rake) THEN
      RAISE EXCEPTION 'Spin contribution does not prove the three funded entries' USING ERRCODE = 'P0404';
    END IF;
    -- Zero hypothetical seats: all three paid entries are already in balance.
    -- The draw's pool row lock remains held through settlement and the receipt.
    v_draw := public.fn_spin_draw_multiplier(v_t.club_id, v_t.buy_in_amount,
      v_manifest->'tiers', (v_manifest->>'rake_rate')::numeric, 0);
    IF NOT COALESCE((v_draw->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin funded draw unavailable: %', v_draw USING ERRCODE = 'P0404';
    END IF;
    v_multiplier := (v_draw->>'multiplier')::numeric;
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    SELECT value INTO STRICT v_tier FROM jsonb_array_elements(v_manifest->'tiers')
     WHERE (value->>'multiplier')::numeric = v_multiplier;
    v_blinds := v_tier->'blind_structure';
    v_payouts := v_tier->'payout_structure';
    v_locked := COALESCE(v_draw->'locked', '[]'::jsonb);
    v_settle := public.fn_spin_settle_game(p_tournament_id, v_t.club_id,
      v_t.buy_in_amount, 3, v_multiplier, (v_manifest->>'rake_rate')::numeric);
    IF NOT COALESCE((v_settle->>'ok')::boolean, false)
       OR (v_settle->>'pool_covered')::numeric IS DISTINCT FROM v_prize
       OR COALESCE((v_settle->>'operator_shortfall')::numeric, 0) <> 0
       OR v_settle->>'reason' = 'already_settled' THEN
      -- Raising rolls back entry, draw and any transitive escrow write too.
      RAISE EXCEPTION 'Spin settlement does not prove the selected funded prize: %', v_settle
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := v_settle || jsonb_build_object('ok', true, 'replay', false,
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_multiplier, 'prize_pool', v_prize, 'buy_in', v_t.buy_in_amount,
    'starting_chips', v_t.starting_chips, 'blind_structure', v_blinds,
    'payout_structure', v_payouts, 'locked', v_locked, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', v_provenance,
    'draw_inputs', v_draw);
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);

  -- D2 (C-stuck-spins): the tournament row is the contract the engine, the
  -- ladder trigger and proveTournamentLaunchSetup read back. The retired
  -- fn_spin_draw_and_settle stamped it; the atomic authority must too, in the
  -- same transaction as the draw. spin_tournament_contract_is_draw proves the
  -- stamp equals the one jackpot_draw; zzz_spin_ladder_is_the_drawn_one proves
  -- it equals the receipt just written. A legacy_projection row is already
  -- stamped (the branch required equality), so this is a no-op there.
  IF v_provenance = 'at_draw' THEN
    UPDATE public.tournaments
       SET spin_multiplier   = v_multiplier,
           prize_pool        = v_prize,
           total_rake        = round((v_settle->>'house_rake')::numeric, 2),
           spin_locked_tiers = v_locked,
           blind_structure   = v_blinds::text,
           payout_structure  = v_payouts::text
     WHERE id = p_tournament_id;
    -- NOT is_premium_spin: fn_satellite_target_contract_is_immutable freezes it
    -- once entry_contract_locked (true on every funded Spin). The engine's own
    -- presentation patch sets it for a 100x draw (TournamentManagerBase.ts:3445)
    -- and would be refused there - a separate, rare (0.01%) defect, out of scope.
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
    IF v_stamped <> 1 OR NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id = p_tournament_id
            AND t.spin_multiplier IS NOT DISTINCT FROM v_multiplier
            AND t.prize_pool IS NOT DISTINCT FROM v_prize
            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked
            AND t.total_rake IS NOT DISTINCT FROM round((v_settle->>'house_rake')::numeric, 2)) THEN
      RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN v_receipt;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_spin_settle_game' AND md5(p.prosrc)='315c263180073980a2132404ef006514')<>1 THEN RAISE EXCEPTION 'launch_admission_source_changed: fn_spin_settle_game'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(p_tournament_id uuid, p_club_id uuid, p_buy_in numeric, p_seats integer, p_multiplier numeric, p_rake_rate numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    SET statement_timeout TO '30s'
    AS $$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
  v_entry_booked boolean;
  v_rake_booked boolean;
BEGIN
  IF public.fn_ca_launch_tournament_start_refused(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  -- DIAMOND PHASE 9: a Diamond Spin is settled by its own arm of
  -- fn_spin_draw_and_settle_atomic against its authorized source; never
  -- through a chip reserve pool.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_spin_is_drawn_by_its_own_authority' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- THE PRIZE IS WHAT THIS FUNCTION OWNS. A contribution row on its own means
  -- the entry was booked when the last seat was paid and the prize still is
  -- not; only a jackpot_draw row means settled.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind = 'jackpot_draw') THEN
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_entry_booked := EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                             WHERE tournament_id = p_tournament_id AND kind = 'contribution');
  v_rake_booked  := EXISTS (SELECT 1 FROM public.rake_records
                             WHERE tournament_id = p_tournament_id
                               AND source IN ('fn_spin_book_entry','fn_spin_settle_game'));

  IF NOT v_entry_booked THEN
    -- ZERO-DRIFT phase 2: reserve intake = spin_entry vs the tournament.
    PERFORM set_config('app.ledger_category', 'spin_entry', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.spin_bonus_pools
       SET balance = balance + v_reserve_in,
           total_deposited = total_deposited + v_reserve_in,
           spin_count = spin_count + 1,
           highest_stake = GREATEST(highest_stake, p_buy_in),
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
            p_multiplier, p_buy_in, p_seats, v_rake,
            CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
                 ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);
  ELSE
    -- Already funded at entry. Read where the pool actually stands.
    SELECT balance INTO v_available
      FROM public.spin_bonus_pools WHERE club_id = v_owner;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;
  END IF;

  -- A claimed operator shortfall has no funding debit. Reject it before
  -- writing a draw or escrow credit. The atomic launch caller excludes such
  -- tiers while holding this same pool lock; this also fences older callers.
  IF v_prize > v_available THEN
    RAISE EXCEPTION 'Spin prize % exceeds funded reserve % for tournament %',
      v_prize, v_available, p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_drawn := v_prize;

  -- ZERO-DRIFT phase 2: the draw funds the tournament's prize pool.
  -- CHIP STANDARD 1.3 (2026-09-02): ... and names the tournament it funds. With only
  -- the category set, this leg landed spin_reserve -> settlement_suspense (3,303 rows
  -- / 185,189.00 a day, R9). service_role-only, so the primitive is used.
  PERFORM public.fn_ca_declare_ledger('spin_prize', 'prize_liability', p_tournament_id);

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL AND NOT v_rake_booked THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    PERFORM set_config('app.ledger_category', 'treasury_transfer', true);
    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_label',
      CASE WHEN v_kind = 'union' THEN 'union_wallets.' || v_wallet ELSE '' END, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_owner::text, true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'entry_booked_at_seat', v_entry_booked,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$$;

-- Component: accounting-component/original-reader-acl.sql
-- Exact original browser ACL preservation, verified against production catalog.

REVOKE EXECUTE ON FUNCTION public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups_base(date,date) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_accounting_document_immutable() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_agent_downline_rake(uuid,uuid,timestamp with time zone,timestamp with time zone,text,integer) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid,uuid) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamp with time zone,timestamp with time zone,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_user_apply(uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(uuid,date,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_operator_floor_entry_guard() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_cash_rakeback_period_basis(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_member_play_totals_delete() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_member_play_totals_insert() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_member_play_totals_update() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_money_panel(uuid) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid,date) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_table_daily_refresh_day(date) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_fold_hand_winnings() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_process_cash_accounting_source(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rakeback_split_counts(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_player_stats(timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sync_profile_total_hands() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_governance_check() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_settle_player_pnl(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_treasury_selftest() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_player_stats() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_ca_reporting_rake_insert() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_ca_reporting_wallet_insert() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_hand_history_club_member_stats() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_tournament_completed_stats() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_union_rake_weekly() FROM PUBLIC,anon,authenticated;

-- Component: guard-definition-component/guard-declaration.sql
-- The original guard watcher must recognize this one deliberate definition
-- change in the same installation transaction. No other baseline is advanced.
DO $declare_velocity_guard$
DECLARE actual_hash text; actual_text text; returned_hash text; other_before jsonb; other_after jsonb;
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_declare_guard_redefinition(text,text)'::regprocedure))
   IS DISTINCT FROM '3a3746dc6e0a5b7a1db97805588c0eb8'
  OR md5(pg_get_functiondef('public.fn_ca_guard_watchlist()'::regprocedure))
   IS DISTINCT FROM 'ab4f9d0e402186fff9b4af288e443609' THEN
  RAISE EXCEPTION 'LAUNCH_GUARD_DECLARATION_ORIGINAL_CHANGED';
 END IF;
 IF NOT ('fn_ca_mint_velocity_watch'=ANY(public.fn_ca_guard_watchlist()))
  OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_ca_mint_velocity_watch')<>1 THEN
  RAISE EXCEPTION 'LAUNCH_VELOCITY_GUARD_IDENTITY_CHANGED';
 END IF;
 IF encode(extensions.digest(convert_to(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure),'UTF8'),'sha256'),'hex')
   IS DISTINCT FROM '206eec0d1ca7108655e39e008f83aa4b8a6d5f8275d9a0b1e6134450df0eccbd' THEN
  RAISE EXCEPTION 'LAUNCH_VELOCITY_GUARD_POSTIMAGE_CHANGED';
 END IF;
 IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname='fn_ca_mint_velocity_watch')
   IS DISTINCT FROM 'c22bbee2e281142c032212d4220a0a17' THEN
  RAISE EXCEPTION 'LAUNCH_VELOCITY_GUARD_PREIMAGE_CHANGED';
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY proname),'[]'::jsonb) INTO other_before
  FROM public.ca_guard_defs d WHERE proname<>'fn_ca_mint_velocity_watch';
 SELECT md5(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure)),
  pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure) INTO actual_hash,actual_text;
 returned_hash:=public.fn_ca_declare_guard_redefinition('fn_ca_mint_velocity_watch',
  '20261012181905_scoped_club_launch_reset_and_guarded_recovery');
 IF returned_hash IS DISTINCT FROM actual_hash OR NOT EXISTS(
  SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_ca_mint_velocity_watch'
   AND def_hash=actual_hash AND declared_ref='20261012181905_scoped_club_launch_reset_and_guarded_recovery'
   AND declared_at=transaction_timestamp()) OR NOT EXISTS(
  SELECT 1 FROM public.ca_guard_def_history WHERE proname='fn_ca_mint_velocity_watch'
   AND def_hash=actual_hash AND def_text=actual_text) THEN
  RAISE EXCEPTION 'LAUNCH_VELOCITY_GUARD_DECLARATION_NOT_EXACT';
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY proname),'[]'::jsonb) INTO other_after
  FROM public.ca_guard_defs d WHERE proname<>'fn_ca_mint_velocity_watch';
 IF other_before IS DISTINCT FROM other_after THEN RAISE EXCEPTION 'LAUNCH_GUARD_DECLARATION_CHANGED_OTHER_BASELINE'; END IF;
END $declare_velocity_guard$;

COMMIT;
