-- An explicitly stopped, already-started event has its own abort authority.
-- Ordinary pre-start cancellation and winner/deal completion stay unchanged.
-- Stop first, finish the already accepted hand and its awaited manager writes,
-- certify the exact serving generation at a physical boundary, then refund only
-- immutable original charges, including fees. Existing awards remain paid.
-- No scheduler, expiry, global floor hold, hot-table FK or replacement payer.
-- @live-proof: (SELECT bool_and(coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=expected,false)) FROM (VALUES ('public.fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)','7f0baf610a409fb665a9a773db60d9bd'),('public.fn_ca_capture_tournament_charge_entitlement()','d18629d96b3f5e3b5d6826c2bf309ac4'),('public.fn_ca_escrow_on_rake_record()','9de5e8a697fc40eeda65807a2d426151'),('public.fn_ca_operator_floor_state(uuid)','af46361b46157eb951c485ea11696512'),('public.fn_ca_request_tournament_abort(uuid,uuid[],text)','b901916e3c9c0ca23540ab66a146880d'),('public.fn_ca_settle_tournament_abort(uuid,uuid,text)','4fc62beaf628ed3531b4de8c48165d57'),('public.fn_ca_tournament_abort_stop_state(uuid,uuid)','7ea88407cc10cbb625fcae9d16c70c30'),('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)','796fe848452599c36751f22996ee761b'),('public.fn_ca_tournament_entry_gate()','2c170f0e4bf943b5f4feb903b6611ece'),('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)','71f94455a73180259ac0543a25dd45ae'),('public.fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)','28b7b2e3d6db218c7cf527278b7ceb8c'),('smarter_private.assert_tournament_abort_quiesced(uuid,uuid)','cd958a8d0c527752b0301be577efb952'),('smarter_private.chip_tournament_abort_refunds(uuid,uuid)','54062faac639e01c22285e5a1a6de70d'),('smarter_private.diamond_tournament_abort_receipt_immutable()','c1bcd4e1ef75c381cf3d6627611f3aac'),('smarter_private.diamond_tournament_abort_refunds(uuid,uuid)','0372548f0b4ee674635bb3818e2919ae'),('smarter_private.tournament_abort_ingress(uuid)','c84b394b07220ef06c7221114773d338'),('smarter_private.tournament_abort_money_snapshot(uuid)','21775a1ccd966ba741eb4b8f687435c1'),('smarter_private.tournament_abort_pending(uuid)','57b7e46c04d323a1cfcb770635def66d'),('smarter_private.tournament_abort_receipt(uuid,uuid)','87fa58b93bd871cd87ec2e391cda77b1'),('smarter_private.tournament_abort_terminal_snapshot(uuid)','4ee9cd88051ffd626f0481eee82b9cc3')) v(signature,expected)) AND (SELECT count(*)=4 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='smarter_private' AND c.relname IN('tournament_abort_operations','tournament_abort_targets','tournament_abort_boundaries','diamond_tournament_abort_receipts') AND c.relrowsecurity)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

CREATE TABLE smarter_private.tournament_abort_operations (
 operation_id uuid PRIMARY KEY,
 tournament_ids uuid[] NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 cohort_hash text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.tournament_abort_targets (
 operation_id uuid NOT NULL,
 tournament_id uuid PRIMARY KEY,
 state text NOT NULL CHECK(state IN('stop_requested','quiesced','settled')),
 asset text NOT NULL CHECK(asset IN('chips','diamonds')),
 requested_generation uuid NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 quiescence jsonb,
 money_snapshot jsonb,
 receipt jsonb,
 settled_at timestamptz
);
CREATE TABLE smarter_private.tournament_abort_boundaries (
 operation_id uuid NOT NULL,
 tournament_id uuid NOT NULL,
 table_id uuid PRIMARY KEY,
 lifecycle bigint NOT NULL,
 required boolean NOT NULL,
 request_generation uuid NOT NULL,
 existing_permits jsonb NOT NULL,
 acknowledged_generation uuid,
 acknowledgement jsonb,
 acknowledged_at timestamptz
);
ALTER TABLE smarter_private.tournament_abort_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.tournament_abort_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.tournament_abort_boundaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.tournament_abort_operations,smarter_private.tournament_abort_targets,smarter_private.tournament_abort_boundaries FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.tournament_abort_ingress(p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=p_tournament_id) THEN
  RAISE EXCEPTION 'TOURNAMENT_OPERATOR_ABORT: new entry, rebuy or add-on is stopped' USING ERRCODE='55000';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_ingress(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_request_tournament_abort(p_operation_id uuid,p_tournament_ids uuid[],p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE ids uuid[]; t public.tournaments; generation uuid; prior smarter_private.tournament_abort_operations;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 IF p_operation_id IS NULL OR p_tournament_ids IS NULL OR cardinality(p_tournament_ids) NOT BETWEEN 1 AND 1000
 OR array_position(p_tournament_ids,NULL) IS NOT NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
  RAISE EXCEPTION 'operator_abort_identity_invalid' USING ERRCODE='22023';END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT DISTINCT unnest(p_tournament_ids) id)x;
 IF cardinality(ids)<>cardinality(p_tournament_ids) THEN RAISE EXCEPTION 'operator_abort_duplicate_target' USING ERRCODE='22023';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('ca:tournament-abort:'||p_operation_id::text,0)) THEN
  RAISE EXCEPTION 'OPERATOR_ABORT_BUSY' USING ERRCODE='55P03';END IF;
 SELECT * INTO prior FROM smarter_private.tournament_abort_operations WHERE operation_id=p_operation_id;
 IF FOUND THEN
  IF prior.tournament_ids IS DISTINCT FROM ids OR prior.reason IS DISTINCT FROM btrim(p_reason) THEN
   RAISE EXCEPTION 'operator_abort_operation_reused' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'tournament_ids',ids,'stop_requested',true,'replayed',true);
 END IF;
 -- This existing try-admission takes G and the settlement barrier before any
 -- parent/child row. It never queues an exclusive global request behind play.
 PERFORM smarter_private.cancellation_lane(ids[1]);
 PERFORM 1 FROM public.tournaments WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.tournaments WHERE id=ANY(ids))<>cardinality(ids) THEN
  RAISE EXCEPTION 'operator_abort_target_missing' USING ERRCODE='P0002';END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets WHERE tournament_id=ANY(ids)) THEN
  RAISE EXCEPTION 'operator_abort_target_owned' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments WHERE id=ANY(ids) AND (started_at IS NULL OR upper(status) NOT IN('RUNNING','BREAK','LATE_REG'))) THEN
  RAISE EXCEPTION 'operator_abort_requires_started_unsettled_event' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.tournament_abort_operations(operation_id,tournament_ids,reason,cohort_hash)
 VALUES(p_operation_id,ids,btrim(p_reason),md5(ids::text));
 FOR t IN SELECT * FROM public.tournaments WHERE id=ANY(ids) ORDER BY id LOOP
  SELECT lease_generation INTO generation FROM public.engine_tournament_leases WHERE tournament_id=t.id AND protocol_version=2 FOR KEY SHARE;
  IF generation IS NULL THEN RAISE EXCEPTION 'operator_abort_manager_identity_missing:%',t.id USING ERRCODE='55000';END IF;
  INSERT INTO smarter_private.tournament_abort_targets(operation_id,tournament_id,state,asset,requested_generation)
  VALUES(p_operation_id,t.id,'stop_requested',CASE WHEN public.fn_poker_diamond_tournament(t.id) THEN 'diamonds' ELSE 'chips' END,generation);
  INSERT INTO smarter_private.tournament_abort_boundaries(operation_id,tournament_id,table_id,lifecycle,required,request_generation,existing_permits)
  SELECT p_operation_id,t.id,tb.id,tb.f06_lifecycle,lower(tb.status)<>'closed' AND NOT coalesce(tb.is_deleted,false),generation,
   coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.permit_id) FROM smarter_private.f06_hand_permits h WHERE h.table_id=tb.id AND h.state='reserved'),'[]'::jsonb)
  FROM public.tables tb WHERE tb.tournament_id=t.id ORDER BY tb.id;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'tournament_ids',ids,'stop_requested',true,'replayed',false);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_request_tournament_abort(uuid,uuid[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_request_tournament_abort(uuid,uuid[],text) TO service_role;

DO $rake_owner$
DECLARE source text;needle text:=E'  IF v_fee < 0 AND NEW.source IN (';
BEGIN
 source:=pg_get_functiondef('public.fn_ca_escrow_on_rake_record()'::regprocedure);
 IF md5(source) IS DISTINCT FROM '0dc096bb5615758ed945365a45997c8c' OR position(needle IN source)=0 THEN RAISE EXCEPTION 'operator_abort_rake_owner_changed';END IF;
 EXECUTE replace(source,needle,E'  IF NEW.source=''operator_abort_tournament'' THEN\n    IF v_fee>=0 OR NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=NEW.tournament_id AND a.state=''quiesced'' AND a.operation_id::text=NEW.metadata->>''operation_id'') OR jsonb_typeof(NEW.metadata->''original_rake_record_ids'') IS DISTINCT FROM ''array'' OR (SELECT sum(r.rake_amount) FROM jsonb_array_elements_text(NEW.metadata->''original_rake_record_ids'') z JOIN public.rake_records r ON r.id=z.value::uuid WHERE r.tournament_id=NEW.tournament_id AND r.club_id=NEW.club_id AND r.metadata->>''user_id''=NEW.metadata->>''user_id'') IS DISTINCT FROM -v_fee THEN RAISE EXCEPTION ''operator_abort_fee_attribution_not_exact'' USING ERRCODE=''P0404'';END IF;\n    RETURN NULL; -- Its exact refund already returned this fee.\n  END IF;\n'||needle);
END $rake_owner$;

-- Further source-bound admission, explicit owner-bound boundary acknowledgement,
-- immutable monetary review, original-charge refunds and terminal receipt follow.

-- Change only the original new-work doors, after exact replay checks. The
-- event/global settlement locks at request admission make these source checks
-- serial with the stop commit. No new trigger is installed on a hot table.
DO $doors$
DECLARE source text; needle text; replacement text; row record;
BEGIN
 FOR row IN SELECT * FROM (VALUES
 ('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)',
  'fb338521b04173262828517e71741d73',
  ' INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)',
  E' IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=p_tournament_id) THEN\n  RETURN jsonb_build_object(''ok'',false,''reason'',''operator_abort_stopped'');\n END IF;\n INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)'),
 ('public.fn_ca_tournament_entry_gate()',
  '63799ff529efacd917879e944ce2e165',
  '  -- Maintenance escape for deliberate service operations.',
  E'  PERFORM smarter_private.tournament_abort_ingress(NEW.tournament_id);\n  -- Maintenance escape for deliberate service operations.'),
 ('public.fn_ca_capture_tournament_charge_entitlement()',
  '9ec1394628e0c6291963d5f76801a3d1',
  '  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN',
  E'  PERFORM smarter_private.tournament_abort_ingress(NEW.tournament_id);\n  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN'),
 ('public.fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)',
  '76d337b6b86734fb44db277d442afeb9',
  '  v_request := uuid_in(md5(''poker-tournament-charge:''||p_idempotency_key)::cstring);',
  E'  PERFORM smarter_private.tournament_abort_ingress(p_tournament_id);\n  v_request := uuid_in(md5(''poker-tournament-charge:''||p_idempotency_key)::cstring);')
 ) x(signature,preimage,needle,replacement)
 LOOP
  source:=pg_get_functiondef(to_regprocedure(row.signature));
  IF source IS NULL OR md5(source) IS DISTINCT FROM row.preimage THEN
   RAISE EXCEPTION 'operator_abort_owner_changed:%',row.signature;END IF;
  IF (length(source)-length(replace(source,row.needle,'')))/length(row.needle)<>1 THEN
   RAISE EXCEPTION 'operator_abort_owner_seam_changed:%',row.signature;END IF;
  EXECUTE replace(source,row.needle,row.replacement);
 END LOOP;
END $doors$;

DO $floor_preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_operator_floor_state(uuid)'::regprocedure)) IS DISTINCT FROM 'a81be7a4e38052d2324f1c8f950b8d81' THEN
  RAISE EXCEPTION 'operator_abort_floor_state_owner_changed';END IF;
END $floor_preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object(
 'hold',coalesce(
  (SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h WHERE NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id AND EXISTS(SELECT 1 FROM public.tables st WHERE st.id=p_table_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))),
  (SELECT jsonb_build_object('operation_id',a.operation_id,'mode','park','reason',op.reason,'tournament_abort',true,'tournament_id',a.tournament_id)
   FROM smarter_private.tournament_abort_targets a JOIN public.tables t ON t.tournament_id=a.tournament_id
   JOIN smarter_private.tournament_abort_operations op ON op.operation_id=a.operation_id
   WHERE t.id=p_table_id
    -- Startup asks before it restores an original hand. An unfinished original
    -- is allowed through this READ so its existing permit can finish; the new
    -- permit door above is already stopped. Never mistake this read for ACK.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=t.id AND h.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete))),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$fn$;

CREATE FUNCTION smarter_private.tournament_abort_money_snapshot(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT jsonb_build_object(
 'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id),
 'diamond_custody',coalesce((SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text) FROM public.poker_diamond_custody c WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry'),'empty'),
 'fee_attribution',coalesce((SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) FROM public.rake_records r WHERE r.tournament_id=p_tournament_id),'empty'),
 'roster',coalesce((SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id),'empty'),
 'chip_charges',coalesce((SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY e.id)::text) FROM public.tournament_refund_entitlements e WHERE e.tournament_id=p_tournament_id),'empty'),
 'chip_refunds',coalesce((SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY e.wallet_transaction_id)::text) FROM public.tournament_refund_tranches e WHERE e.tournament_id=p_tournament_id),'empty'),
 'diamond_ledger',coalesce((SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY e.id)::text) FROM public.poker_diamond_tournament_ledger e WHERE e.tournament_id=p_tournament_id),'empty'),
 'awards',coalesce((SELECT md5(jsonb_agg(to_jsonb(o)-'terminal_closed_at' ORDER BY o.id)::text) FROM public.tournament_obligations o WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund'),'empty'),
 'bounty_awards',coalesce((SELECT md5(jsonb_agg(to_jsonb(o)-'terminal_closed_at' ORDER BY o.id)::text) FROM public.tournament_bounty_obligations o WHERE o.tournament_id=p_tournament_id),'empty'),
 'satellite_awards',coalesce((SELECT md5(jsonb_agg(to_jsonb(o)-'terminal_closed_at' ORDER BY o.place,o.user_id)::text) FROM public.tournament_satellite_awards o WHERE o.tournament_id=p_tournament_id),'empty'));
$fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_money_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.tournament_abort_pending(p_tournament_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT smarter_private.f06_lease_has_pending_custody(p_tournament_id,NULL)
 OR EXISTS(SELECT 1 FROM public.tables t JOIN public.hand_state_snapshots s ON s.table_id=t.id WHERE t.tournament_id=p_tournament_id AND NOT s.is_complete)
 OR EXISTS(SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund' AND o.amount_paid IS DISTINCT FROM o.amount_owed)
 OR EXISTS(SELECT 1 FROM public.tournament_bounty_obligations o WHERE o.tournament_id=p_tournament_id AND o.state IS DISTINCT FROM 'settled');
$fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_pending(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_tournament_abort_stop_state(p_operation_id uuid,p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE a smarter_private.tournament_abort_targets; g uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_target_not_owned' USING ERRCODE='55000';END IF;
 SELECT lease_generation INTO g FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 RETURN jsonb_build_object('ok',true,'operation_id',a.operation_id,'tournament_id',a.tournament_id,'state',a.state,
  'requested_generation',a.requested_generation,'current_generation',g,'quiescence_generation',a.quiescence->>'generation',
  'current_boundary_valid',(a.state='quiesced' AND g IS NOT NULL AND a.quiescence->>'generation'=g::text AND a.money_snapshot=smarter_private.tournament_abort_money_snapshot(p_tournament_id) AND a.quiescence->>'money_hash'=md5(a.money_snapshot::text) AND NOT smarter_private.tournament_abort_pending(p_tournament_id) AND NOT EXISTS(SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id AND lower(tb.status)<>'closed' AND NOT coalesce(tb.is_deleted,false) AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=tb.id AND b.lifecycle=tb.f06_lifecycle AND b.acknowledged_generation=g AND b.acknowledged_at IS NOT NULL))),'receipt',a.receipt,'tournament_status',(SELECT status FROM public.tournaments WHERE id=p_tournament_id),'money_snapshot',a.money_snapshot,'money_hash',a.quiescence->>'money_hash','pending',smarter_private.tournament_abort_pending(p_tournament_id),
  'tables',coalesce((SELECT jsonb_agg(jsonb_build_object('table_id',t.id,'lifecycle',t.f06_lifecycle::text,'required',lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false),'requested_generation',a.requested_generation,'current_generation',g) ORDER BY t.id) FROM public.tables t WHERE t.tournament_id=p_tournament_id),'[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_abort_stop_state(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_abort_stop_state(uuid,uuid) TO service_role;

CREATE FUNCTION public.fn_ca_ack_tournament_abort_boundary(p_operation_id uuid,p_tournament_id uuid,p_table_id uuid,p_lease_generation uuid,p_hand_number bigint,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE a smarter_private.tournament_abort_targets; t public.tables; snapshot jsonb;
BEGIN
 -- The only producer is the explicit engine abort request, after its own
 -- physical park, all bank/private writers, and manager callback tails JOIN.
 -- floor_state remains a read and can never manufacture this certificate.
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR a.state='settled' THEN RAISE EXCEPTION 'operator_abort_target_not_acknowledgeable' USING ERRCODE='55000';END IF;
 SELECT * INTO t FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR p_hand_number IS NULL OR p_hand_number<0 OR p_evidence IS NULL
 OR p_evidence->>'kind' IS DISTINCT FROM 'tournament_abort_boundary_v1'
 OR p_evidence->>'certificate_version' IS DISTINCT FROM '1'
 OR p_evidence->>'physical_stopped' IS DISTINCT FROM 'true'
 OR p_evidence->>'parked_before_retirement' IS DISTINCT FROM 'true'
 OR p_evidence->>'drained' IS DISTINCT FROM 'true'
 OR p_evidence->>'manager_tail_joined' IS DISTINCT FROM 'true'
 OR p_evidence->>'pending_writers' IS DISTINCT FROM '0'
 OR p_evidence->>'bank_state_write_pending' IS DISTINCT FROM 'false'
 OR (p_evidence->>'lifecycle')::bigint IS DISTINCT FROM t.f06_lifecycle
 OR (p_evidence->>'hand_number')::bigint IS DISTINCT FROM p_hand_number THEN
  RAISE EXCEPTION 'operator_abort_physical_boundary_unverified' USING ERRCODE='P0404';END IF;
 IF jsonb_typeof(p_evidence->'source_table_ids') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM public.tables x WHERE x.tournament_id=p_tournament_id AND lower(x.status)<>'closed' AND NOT coalesce(x.is_deleted,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_evidence->'source_table_ids') z WHERE z.value::uuid=x.id))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_evidence->'source_table_ids') z WHERE NOT EXISTS(SELECT 1 FROM public.tables x WHERE x.id=z.value::uuid AND x.tournament_id=p_tournament_id)) THEN
  RAISE EXCEPTION 'operator_abort_physical_roster_incomplete' USING ERRCODE='P0404';END IF;
 IF smarter_private.tournament_abort_pending(p_tournament_id) THEN
  RAISE EXCEPTION 'operator_abort_accepted_hand_or_award_pending' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.tournament_abort_boundaries(operation_id,tournament_id,table_id,lifecycle,required,request_generation,existing_permits,acknowledged_generation,acknowledgement,acknowledged_at)
 VALUES(p_operation_id,p_tournament_id,p_table_id,t.f06_lifecycle,lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false),a.requested_generation,'[]'::jsonb,p_lease_generation,p_evidence,clock_timestamp())
 ON CONFLICT(table_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle,required=EXCLUDED.required,
 acknowledged_generation=EXCLUDED.acknowledged_generation,acknowledgement=EXCLUDED.acknowledgement,acknowledged_at=EXCLUDED.acknowledged_at
 WHERE smarter_private.tournament_abort_boundaries.operation_id=p_operation_id AND smarter_private.tournament_abort_boundaries.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_boundary_owned' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id AND lower(tb.status)<>'closed' AND NOT coalesce(tb.is_deleted,false)
  AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=tb.id
    AND b.lifecycle=tb.f06_lifecycle AND b.acknowledged_generation=p_lease_generation AND b.acknowledged_at IS NOT NULL)) THEN
  snapshot:=smarter_private.tournament_abort_money_snapshot(p_tournament_id);
  UPDATE smarter_private.tournament_abort_targets SET state='quiesced',money_snapshot=snapshot,
   quiescence=jsonb_build_object('generation',p_lease_generation,'money_hash',md5(snapshot::text),'certified_at',clock_timestamp())
  WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'tournament_id',p_tournament_id,'table_id',p_table_id,
 'generation',p_lease_generation,'state',(SELECT state FROM smarter_private.tournament_abort_targets WHERE tournament_id=p_tournament_id));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb) TO service_role;

CREATE FUNCTION smarter_private.assert_tournament_abort_quiesced(p_operation_id uuid,p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE a smarter_private.tournament_abort_targets; g uuid;
BEGIN
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR a.state IS DISTINCT FROM 'quiesced' THEN RAISE EXCEPTION 'operator_abort_not_quiesced' USING ERRCODE='55000';END IF;
 SELECT lease_generation INTO g FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 IF g IS NULL OR a.quiescence->>'generation' IS DISTINCT FROM g::text
 OR smarter_private.tournament_abort_pending(p_tournament_id)
 OR EXISTS(SELECT 1 FROM public.tables t WHERE t.tournament_id=p_tournament_id AND lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false)
  AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=t.id
   AND b.lifecycle=t.f06_lifecycle AND b.acknowledged_generation=g AND b.acknowledged_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'operator_abort_current_owner_or_boundary_changed' USING ERRCODE='55000';END IF;
 IF a.money_snapshot IS DISTINCT FROM smarter_private.tournament_abort_money_snapshot(p_tournament_id) THEN
  RAISE EXCEPTION 'operator_abort_money_review_changed' USING ERRCODE='55000';END IF;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.assert_tournament_abort_quiesced(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.ca_settle_sources(source,note) VALUES('operator_abort_tournament','Explicit drained started-event abort; immutable original charges only') ON CONFLICT(source) DO NOTHING;

CREATE FUNCTION smarter_private.chip_tournament_abort_refunds(p_operation_id uuid,p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE p record;e public.tournament_refund_entitlements; s jsonb; owed numeric; refunds jsonb:='[]'; total numeric:=0;
 esc public.tournament_escrow; bank record; sources integer; funded numeric; returned numeric; excess numeric; before_balance numeric; after_balance numeric; lid uuid; legs jsonb;
BEGIN
 PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
 IF public.fn_poker_diamond_tournament(p_tournament_id) THEN RAISE EXCEPTION 'operator_abort_wrong_asset';END IF;
 FOR p IN SELECT DISTINCT user_id FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id IS NOT NULL ORDER BY user_id LOOP
  PERFORM 1 FROM public.fn_ca_tournament_refund_plan(p_tournament_id,p.user_id);
  LOOP
   SELECT x.* INTO e FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id AND x.user_id=p.user_id
    AND NOT EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=x.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=x.id)
    ORDER BY x.entitlement_kind,x.id LIMIT 1 FOR UPDATE;
   EXIT WHEN NOT FOUND;
   IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' THEN RAISE EXCEPTION 'operator_abort_nonwallet_charge_requires_its_existing_disposition:%',e.id USING ERRCODE='P0404';END IF;
   SELECT coalesce(amount_paid,0)+e.gross INTO owed FROM public.tournament_obligations WHERE tournament_id=p_tournament_id AND kind='refund' AND place IS NULL AND user_id=p.user_id FOR UPDATE;
   IF NOT FOUND THEN owed:=e.gross;END IF;
   s:=public.fn_settle_tournament_refund_exact(p_tournament_id,p.user_id,e.refund_wallet_club_id,owed,e.refund_prize,e.refund_bounty,e.refund_fee,'operator_abort_tournament','Operator stopped event: full original entry, rebuy and add-on refund');
   IF s->>'fully_settled' IS DISTINCT FROM 'true' OR (s->>'remaining')::numeric IS DISTINCT FROM 0::numeric
    OR (s->>'entitlement_id')::uuid IS DISTINCT FROM e.id OR (s->>'paid')::numeric IS DISTINCT FROM e.gross THEN
    RAISE EXCEPTION 'operator_abort_exact_refund_failed:%:%',e.id,s USING ERRCODE='P0404';END IF;
   refunds:=refunds||jsonb_build_array(s||jsonb_build_object('user_id',p.user_id,'registration_id',coalesce(e.registration_id,(SELECT id FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=p.user_id ORDER BY id LIMIT 1)),'source_charge_ledger_id',e.source_ledger_id));
   total:=total+e.gross;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.tournament_refund_entitlements ent WHERE ent.tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=ent.id)) THEN
  RAISE EXCEPTION 'operator_abort_unpaid_original_charge' USING ERRCODE='P0404';END IF;
 SELECT * INTO esc FROM public.tournament_escrow WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF esc.tournament_id IS NULL OR NOT esc.enforced OR esc.bounty_balance<>0 OR esc.fee_balance<>0 OR esc.prize_balance<0 THEN
  RAISE EXCEPTION 'operator_abort_component_bank_not_closed' USING ERRCODE='P0404';END IF;
 excess:=esc.prize_balance;
 IF excess>0 THEN
  SELECT count(DISTINCT (l.from_type,l.from_entity_id)),sum(l.amount),jsonb_agg(l.id ORDER BY l.id) INTO sources,funded,legs
   FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id AND l.category='overlay' AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
   AND l.from_type IN('union_bank','club_treasury') AND coalesce(l.description,'') NOT LIKE 'auto-ledgered%';
  SELECT coalesce(sum(amount),0) INTO returned FROM public.chip_ledger WHERE tournament_id=p_tournament_id AND category='reversal'
   AND from_type='prize_liability' AND from_entity_id=p_tournament_id AND metadata->>'kind'='reviewed_void_overlay_return';
  IF sources IS DISTINCT FROM 1 OR excess>coalesce(funded,0)-returned THEN RAISE EXCEPTION 'operator_abort_overlay_source_not_exact' USING ERRCODE='P0404';END IF;
  SELECT from_type,from_entity_id,club_id INTO bank FROM public.chip_ledger WHERE id=(legs->>0)::uuid;
  IF bank.from_type='union_bank' THEN
   SELECT chip_balance INTO before_balance FROM public.union_wallets WHERE union_id=bank.from_entity_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_overlay_bank_missing';END IF;
   PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
   UPDATE public.union_wallets SET chip_balance=chip_balance+excess,updated_at=now() WHERE union_id=bank.from_entity_id RETURNING chip_balance INTO after_balance;
   PERFORM set_config('app.ledger_autoskip_union_wallets','0',true);
  ELSE
   SELECT chip_treasury INTO before_balance FROM public.clubs WHERE id=bank.from_entity_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_overlay_bank_missing';END IF;
   PERFORM set_config('app.ledger_autoskip_clubs','1',true);
   UPDATE public.clubs SET chip_treasury=chip_treasury+excess,updated_at=now() WHERE id=bank.from_entity_id RETURNING chip_treasury INTO after_balance;
   PERFORM set_config('app.ledger_autoskip_clubs','0',true);
  END IF;
  IF after_balance IS DISTINCT FROM before_balance+excess THEN RAISE EXCEPTION 'operator_abort_overlay_credit_not_exact';END IF;
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,description,idempotency_key,metadata)
  VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','prize_liability',p_tournament_id,bank.from_type,bank.from_entity_id,excess,'reversal',bank.club_id,p_tournament_id,
   'Unused operator-aborted tournament overlay returned to its original source','tourney:'||p_tournament_id||':operator-abort:'||p_operation_id||':overlay',
   jsonb_build_object('kind','reviewed_void_overlay_return','operation_id',p_operation_id,'original_overlay_ledger_ids',legs,'source_balance_before',before_balance,'source_balance_after',after_balance)) RETURNING id INTO lid;
  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'operator abort unused original overlay',p_overlay_in=>-excess);
 END IF;
 RETURN jsonb_build_object('ok',true,'fully_settled',true,'asset','chips','total_refunded',total,'refunds',refunds,'unused_overlay_returned',excess,'overlay_return_ledger_id',lid);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.chip_tournament_abort_refunds(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A final proof hashes only durable event history and terminal dispositions.
-- It retains original rankings, eliminations, paid awards and all original hands.
CREATE FUNCTION smarter_private.tournament_abort_terminal_snapshot(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT jsonb_build_object('money',smarter_private.tournament_abort_money_snapshot(p_tournament_id),
 'tables',coalesce((SELECT md5(jsonb_agg(jsonb_build_object('id',t.id,'status',t.status,'lifecycle',t.lifecycle,'f06_lifecycle',t.f06_lifecycle,'players',t.current_players,'closed',t.terminal_closed_at) ORDER BY t.id)::text) FROM public.tables t WHERE t.tournament_id=p_tournament_id),'empty'),
 'seats',coalesce((SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY s.id)::text) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=p_tournament_id),'empty'),
 'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id),
 'refund_tranches',coalesce((SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.wallet_transaction_id)::text) FROM public.tournament_refund_tranches r WHERE r.tournament_id=p_tournament_id),'empty'),
 'rake',coalesce((SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) FROM public.rake_records r WHERE r.tournament_id=p_tournament_id),'empty'));
$fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_terminal_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.tournament_abort_receipt(p_tournament_id uuid,p_observed_actor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE h public.tournament_cancellation_receipts;t public.tournaments;a smarter_private.tournament_abort_targets;
BEGIN
 SELECT * INTO h FROM public.tournament_cancellation_receipts WHERE tournament_id=p_tournament_id;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE tournament_id=p_tournament_id;
 IF h.receipt_version IS DISTINCT FROM 3 OR h.receipt->>'mode' IS DISTINCT FROM 'started_operator_abort'
 OR a.state IS DISTINCT FROM 'settled' OR h.receipt IS DISTINCT FROM a.receipt OR h.receipt->>'operation_id' IS DISTINCT FROM a.operation_id::text
 OR h.receipt->>'fully_settled' IS DISTINCT FROM 'true' OR t.started_at IS NULL OR t.status IS DISTINCT FROM 'CANCELLED'
 OR t.started_at IS DISTINCT FROM (h.receipt->>'original_started_at')::timestamptz OR t.ended_at IS DISTINCT FROM h.settled_at OR t.current_players IS DISTINCT FROM 0 OR t.prize_pool IS DISTINCT FROM 0::numeric
 OR t.bounty_pool IS DISTINCT FROM 0::numeric OR t.total_rake IS DISTINCT FROM 0::numeric OR t.on_break IS DISTINCT FROM false
 OR t.break_started_at IS NOT NULL OR t.break_ends_at IS NOT NULL
 OR (p_observed_actor_id IS NOT NULL AND h.actor_id IS DISTINCT FROM p_observed_actor_id)
 OR h.receipt->'terminal_snapshot' IS DISTINCT FROM smarter_private.tournament_abort_terminal_snapshot(p_tournament_id) THEN
  RAISE EXCEPTION 'operator_abort_terminal_receipt_evidence_changed' USING ERRCODE='P0404';END IF;
 RETURN h.receipt;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- The original immutable cancellation header activates the existing mutation
-- guards. Only its separately certified v3 mode uses the started abort proof.
DO $reader$
DECLARE source text;needle text:=E'  -- DIAMOND PHASE 8: a Diamond event''s receipt is proved against custody,';
BEGIN
 source:=pg_get_functiondef('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)'::regprocedure);
 IF md5(source) IS DISTINCT FROM '34fe30f983f774bd159d73c3d692109e' OR position(needle IN source)=0 THEN RAISE EXCEPTION 'operator_abort_receipt_reader_owner_changed';END IF;
 EXECUTE replace(source,needle,E'  IF v_h.receipt_version=3 AND v_h.receipt->>''mode''=''started_operator_abort'' THEN\n    RETURN smarter_private.tournament_abort_receipt(p_tournament_id,p_observed_actor_id);\n  END IF;\n'||needle);
END $reader$;

-- Only this immutable header table takes a short schema lock. Existing v2
-- constraints and proof remain intact; v3 is an explicit different authority.
DO $version$
BEGIN
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.tournament_cancellation_receipts'::regclass AND conname='tournament_cancellation_receipts_receipt_version_check') IS DISTINCT FROM 'CHECK ((receipt_version = 2))' THEN RAISE EXCEPTION 'operator_abort_receipt_version_owner_changed';END IF;
END $version$;
ALTER TABLE public.tournament_cancellation_receipts DROP CONSTRAINT tournament_cancellation_receipts_receipt_version_check;
ALTER TABLE public.tournament_cancellation_receipts ADD CONSTRAINT tournament_cancellation_receipts_receipt_version_check CHECK(receipt_version=2 OR (receipt_version=3 AND receipt->>'mode'='started_operator_abort' AND receipt->>'operation_id' IS NOT NULL));

-- Component for the finite, explicitly requested started-tournament abort.
-- Integrator supplies tournament_abort_targets and assert_tournament_abort_quiesced.
-- This file is NOT an independently installable migration and is never sent live.
-- No ordinary unregister, pay, refund, guarantee or purchase-lot guard changes.
CREATE TABLE smarter_private.diamond_tournament_abort_receipts (
  operation_id uuid NOT NULL,
  tournament_id uuid NOT NULL UNIQUE,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id,tournament_id),
  CHECK (coalesce(receipt->>'asset'='diamonds'
    AND receipt->>'operation_id'=operation_id::text
    AND receipt->>'tournament_id'=tournament_id::text
    AND receipt->>'fully_settled'='true',false))
);
ALTER TABLE smarter_private.diamond_tournament_abort_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.diamond_tournament_abort_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.diamond_tournament_abort_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'diamond_abort_receipt_is_immutable' USING ERRCODE='55000';
END; $body$;
REVOKE ALL ON FUNCTION smarter_private.diamond_tournament_abort_receipt_immutable()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER diamond_abort_receipt_immutable
BEFORE UPDATE OR DELETE ON smarter_private.diamond_tournament_abort_receipts
FOR EACH ROW EXECUTE FUNCTION smarter_private.diamond_tournament_abort_receipt_immutable();
CREATE TRIGGER diamond_abort_receipt_no_truncate
BEFORE TRUNCATE ON smarter_private.diamond_tournament_abort_receipts
FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.diamond_tournament_abort_receipt_immutable();

CREATE FUNCTION smarter_private.diamond_tournament_abort_refunds(
  p_operation_id uuid,p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private
AS $body$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_target record; v_t record; v_e record; v_c record; v_charge record; v_line record;
  v_prior record; v_parts record; v_paid record; v_receipt jsonb;
  v_charges_hash text; v_awards_hash text; v_awards jsonb;
  v_gross numeric; v_prize numeric; v_bounty numeric; v_fee numeric;
  v_old_refund numeric; v_old_refund_prize numeric; v_old_refund_bounty numeric; v_old_refund_fee numeric;
  v_expected numeric; v_expected_prize numeric; v_expected_bounty numeric; v_expected_fee numeric;
  v_refunded numeric := 0; v_refund_prize numeric := 0;
  v_refund_bounty numeric := 0; v_refund_fee numeric := 0;
  v_unused_overlay numeric; v_house_funding numeric;
  v_house_before numeric; v_house_after numeric; v_supply numeric;
  v_holder_wallet bigint; v_holder_label text; v_take bigint; v_n bigint;
  v_share bigint; v_rest bigint; v_index bigint := 0; v_register text; v_request uuid;
  v_key text; v_credit jsonb; v_drained jsonb; v_ob uuid; v_ledger bigint;
  v_refunds jsonb := '[]'::jsonb; v_zero_users jsonb; v_closed jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'diamond_abort_identity_required' USING ERRCODE='22023';
  END IF;
  -- The parent's canonical financial lane and tournament/target row lock
  -- serialize this entire event. A retry may read an already sealed receipt,
  -- including after the target has advanced from quiesced to settled.
  SELECT * INTO v_target FROM smarter_private.tournament_abort_targets
   WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_target.asset IS DISTINCT FROM 'diamonds' THEN
    RAISE EXCEPTION 'diamond_abort_target_not_owned' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_prior FROM smarter_private.diamond_tournament_abort_receipts
   WHERE tournament_id=p_tournament_id;
  IF FOUND AND v_prior.operation_id IS DISTINCT FROM p_operation_id THEN
    RAISE EXCEPTION 'diamond_abort_operation_reused' USING ERRCODE='22023';
  END IF;

  SELECT md5(coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb)::text)
    INTO v_charges_hash FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id=p_tournament_id AND l.kind IN('entry','rebuy','reentry','addon');
  SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]'::jsonb)
    INTO v_awards FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund';
  v_awards_hash:=md5(v_awards::text);
  IF v_prior.operation_id IS NOT NULL THEN
    v_receipt:=v_prior.receipt;
    IF v_receipt->>'charges_hash' IS DISTINCT FROM v_charges_hash
       OR v_receipt->>'prior_awards_hash' IS DISTINCT FROM v_awards_hash
       OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger l
            WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
              AND l.request->>'abort_operation_id'=p_operation_id::text)
          IS DISTINCT FROM jsonb_array_length(v_receipt->'refunds')::bigint
       OR (SELECT coalesce(sum(l.amount),0) FROM public.poker_diamond_tournament_ledger l
            WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
              AND l.request->>'abort_operation_id'=p_operation_id::text)
          IS DISTINCT FROM (v_receipt->>'total_refunded')::numeric
       OR (SELECT coalesce(sum(l.amount),0) FROM public.poker_diamond_tournament_ledger l
            WHERE l.tournament_id=p_tournament_id AND l.kind IN('entry','rebuy','reentry','addon'))
          IS DISTINCT FROM (v_receipt->>'total_refunded')::numeric
                         +(v_receipt->>'prior_refunds_preserved')::numeric THEN
      RAISE EXCEPTION 'diamond_abort_replay_source_changed' USING ERRCODE='P0404';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_to_recordset(v_receipt->'refunds')
      AS x(user_id uuid,amount numeric,ledger_id bigint,obligation_id uuid,
           journal_id uuid,charge_ledger_ids jsonb)
    LOOP
      IF jsonb_array_length(v_line.charge_ledger_ids) IS DISTINCT FROM 1
         OR NOT EXISTS(
           SELECT 1 FROM public.poker_diamond_tournament_ledger r
           JOIN public.diamond_transactions d ON d.id=r.wallet_journal_id
           JOIN public.tournament_obligations o ON o.id=r.obligation_id
           JOIN public.poker_diamond_tournament_ledger c
             ON c.id=(v_line.charge_ledger_ids->>0)::bigint
          WHERE r.id=v_line.ledger_id AND r.kind='refund'
            AND r.tournament_id=p_tournament_id AND c.tournament_id=p_tournament_id
            AND c.kind IN('entry','rebuy','reentry','addon')
            AND r.user_id=v_line.user_id AND c.user_id=v_line.user_id
            AND r.amount=v_line.amount AND c.amount=v_line.amount
            AND r.prize_part=c.prize_part AND r.bounty_part=c.bounty_part AND r.fee_part=c.fee_part
            AND r.obligation_id=v_line.obligation_id AND r.wallet_journal_id=v_line.journal_id
            AND r.request->>'abort_operation_id'=p_operation_id::text
            AND r.request->>'charge_ledger_id'=c.id::text
            AND d.user_id=v_line.user_id AND d.amount=v_line.amount AND d.type='arena_withdraw'
            AND o.tournament_id=p_tournament_id AND o.user_id=v_line.user_id
            AND o.kind='refund' AND o.place IS NULL AND o.amount_paid=o.amount_owed
            AND o.amount_paid>=v_line.amount
         ) THEN
        RAISE EXCEPTION 'diamond_abort_replay_receipt_changed' USING ERRCODE='P0404';
      END IF;
    END LOOP;
    IF public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM 0
       OR EXISTS(SELECT 1 FROM public.poker_diamond_custody c
                  WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id
                    AND c.state<>'released') THEN
      RAISE EXCEPTION 'diamond_abort_replay_custody_changed' USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
    IF v_e.prize_balance IS DISTINCT FROM 0::numeric
       OR v_e.bounty_balance IS DISTINCT FROM 0::numeric OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
      RAISE EXCEPTION 'diamond_abort_replay_banks_changed' USING ERRCODE='P0404';
    END IF;
    RETURN v_receipt;
  END IF;

  PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
  IF v_target.state IS DISTINCT FROM 'quiesced' THEN
    RAISE EXCEPTION 'diamond_abort_not_quiesced' USING ERRCODE='55000';
  END IF;
  SELECT t.id,t.club_id,t.name,t.status,t.started_at INTO v_t
    FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id)
     OR v_t.started_at IS NULL OR upper(v_t.status) IN('COMPLETED','CANCELLED','COMPLETING') THEN
    RAISE EXCEPTION 'diamond_abort_started_target_changed' USING ERRCODE='55000';
  END IF;
  -- Take every wallet before any custody, matching the existing Diamond
  -- release/settlement lock order. No personal identity is impersonated.
  PERFORM p.id FROM public.profiles p WHERE p.id IN (
    SELECT c.user_id FROM public.poker_diamond_custody c
     WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry'
    UNION SELECT l.user_id FROM public.poker_diamond_tournament_ledger l
     WHERE l.tournament_id=p_tournament_id AND l.user_id IS NOT NULL
  ) ORDER BY p.id FOR NO KEY UPDATE;
  PERFORM c.id FROM public.poker_diamond_custody c
   WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry'
   ORDER BY c.created_at,c.id FOR UPDATE;
  PERFORM o.id FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id ORDER BY o.id FOR UPDATE;

  -- This finite contract covers the seven original Diamond events, whose
  -- paid awards are prize-only and whose purchase-lot reservation inventory
  -- is empty. Do not change purchase-refund eligibility or Spin/bounty/fee
  -- semantics to expand this incident's scope.
  IF EXISTS(SELECT 1 FROM public.poker_diamond_lot_reservations r
             JOIN public.poker_diamond_custody c ON c.id=r.custody_id
            WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry') THEN
    RAISE EXCEPTION 'diamond_abort_purchase_lot_contract_unsupported' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l
             WHERE l.tournament_id=p_tournament_id
               AND l.kind IN('spin_underwrite','spin_surplus','bounty','fee')) THEN
    RAISE EXCEPTION 'diamond_abort_paid_bank_contract_unsupported' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_obligations o
             WHERE o.tournament_id=p_tournament_id
               AND o.amount_paid<o.amount_owed) THEN
    RAISE EXCEPTION 'diamond_abort_unpaid_award' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l
             LEFT JOIN public.diamond_transactions d ON d.id=l.wallet_journal_id
            WHERE l.tournament_id=p_tournament_id
              AND l.kind IN('entry','rebuy','reentry','addon','prize')
              AND (d.id IS NULL OR d.user_id IS DISTINCT FROM l.user_id
                OR d.amount IS DISTINCT FROM CASE WHEN l.kind='prize' THEN l.amount ELSE -l.amount END
                OR d.type IS DISTINCT FROM CASE WHEN l.kind='prize' THEN 'arena_withdraw' ELSE 'arena_deposit' END)) THEN
    RAISE EXCEPTION 'diamond_abort_original_journal_missing' USING ERRCODE='P0404';
  END IF;
  IF EXISTS(
    SELECT u FROM (
      SELECT l.user_id AS u,sum(l.amount) AS paid FROM public.poker_diamond_tournament_ledger l
       WHERE l.tournament_id=p_tournament_id AND l.kind='prize' GROUP BY l.user_id
    )l FULL JOIN (
      SELECT o.user_id AS u,sum(o.amount_paid) AS paid FROM public.tournament_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.kind='place' GROUP BY o.user_id
    )o USING(u) WHERE coalesce(l.paid,0) IS DISTINCT FROM coalesce(o.paid,0)
  ) THEN
    RAISE EXCEPTION 'diamond_abort_prior_award_receipt_mismatch' USING ERRCODE='P0404';
  END IF;
  -- A previous ordinary full-custody refund is subtracted only when its
  -- original charge parts, released custody, wallet journal and movement all
  -- agree exactly. An unexplained partial refund refuses the whole event.
  FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
    WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry'
      AND EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger r
        WHERE r.custody_id=c.id AND r.tournament_id=p_tournament_id AND r.kind='refund')
  LOOP
    SELECT coalesce(sum(amount),0) AS gross,coalesce(sum(prize_part),0) AS prize,
           coalesce(sum(bounty_part),0) AS bounty,coalesce(sum(fee_part),0) AS fee
      INTO v_parts FROM public.poker_diamond_tournament_ledger
     WHERE custody_id=v_c.id AND kind IN('entry','rebuy','reentry','addon');
    SELECT coalesce(sum(amount),0) AS gross,coalesce(sum(prize_part),0) AS prize,
           coalesce(sum(bounty_part),0) AS bounty,coalesce(sum(fee_part),0) AS fee
      INTO v_paid FROM public.poker_diamond_tournament_ledger
     WHERE custody_id=v_c.id AND kind='refund';
    IF v_c.state IS DISTINCT FROM 'released' OR v_c.balance IS DISTINCT FROM 0::bigint
       OR v_parts.gross IS DISTINCT FROM v_paid.gross OR v_parts.prize IS DISTINCT FROM v_paid.prize
       OR v_parts.bounty IS DISTINCT FROM v_paid.bounty OR v_parts.fee IS DISTINCT FROM v_paid.fee THEN
      RAISE EXCEPTION 'diamond_abort_prior_refund_not_exact' USING ERRCODE='P0404';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger r
       WHERE r.tournament_id=p_tournament_id AND r.kind='refund'
         AND (r.custody_id IS NULL OR r.request->>'kind' IS NULL
           OR r.request->>'kind' NOT IN('unregister','cancel')
           OR NOT EXISTS(SELECT 1 FROM public.diamond_transactions d
              JOIN public.poker_diamond_movements m ON m.wallet_journal_id=d.id
             WHERE d.id=r.wallet_journal_id AND d.user_id=r.user_id AND d.amount=r.amount
               AND d.type='arena_withdraw' AND m.custody_id=r.custody_id
               AND m.user_id=r.user_id AND m.action='release' AND m.amount=r.amount)
           OR NOT EXISTS(SELECT 1 FROM public.tournament_obligations o
             WHERE o.id=r.obligation_id AND o.tournament_id=p_tournament_id AND o.user_id=r.user_id
               AND o.kind='refund' AND o.place IS NULL AND o.amount_paid=o.amount_owed
               AND o.amount_paid>=r.amount))) THEN
    RAISE EXCEPTION 'diamond_abort_prior_refund_receipt_missing' USING ERRCODE='P0404';
  END IF;

  SELECT coalesce(sum(amount),0),coalesce(sum(prize_part),0),
         coalesce(sum(bounty_part),0),coalesce(sum(fee_part),0)
    INTO v_gross,v_prize,v_bounty,v_fee FROM public.poker_diamond_tournament_ledger
   WHERE tournament_id=p_tournament_id AND kind IN('entry','rebuy','reentry','addon');
  SELECT coalesce(sum(amount),0),coalesce(sum(prize_part),0),
         coalesce(sum(bounty_part),0),coalesce(sum(fee_part),0)
    INTO v_old_refund,v_old_refund_prize,v_old_refund_bounty,v_old_refund_fee
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tournament_id AND kind='refund';
  v_expected:=v_gross-v_old_refund;
  v_expected_prize:=v_prize-v_old_refund_prize;
  v_expected_bounty:=v_bounty-v_old_refund_bounty;
  v_expected_fee:=v_fee-v_old_refund_fee;
  IF least(v_expected,v_expected_prize,v_expected_bounty,v_expected_fee)<0
     OR v_expected IS DISTINCT FROM v_expected_prize+v_expected_bounty+v_expected_fee THEN
    RAISE EXCEPTION 'diamond_abort_original_charges_disagree' USING ERRCODE='P0404';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',c.user_id,'custody_id',c.id)
                  ORDER BY c.created_at,c.id),'[]'::jsonb) INTO v_zero_users
    FROM public.poker_diamond_custody c
   WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry' AND c.state<>'released'
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l
                      WHERE l.custody_id=c.id AND l.kind IN('entry','rebuy','reentry','addon'));
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_unused_overlay:=v_e.overlay_in;
  IF v_unused_overlay<0 THEN
    RAISE EXCEPTION 'diamond_abort_negative_overlay' USING ERRCODE='P0404';
  END IF;
  IF v_e.prize_balance<v_unused_overlay THEN
    RAISE EXCEPTION 'diamond_abort_spent_overlay_contract_unsupported' USING ERRCODE='55000';
  END IF;
  -- Return only the original unused house overlay BEFORE adding compensation
  -- for awards the owner expressly required the house to absorb. The existing
  -- guarantee return writes its own custody burns and receipted house mint.
  IF v_unused_overlay>0 THEN
    IF public.fn_poker_diamond_tournament_settle_overlay(
      p_tournament_id,'finalize',v_expected_prize) IS DISTINCT FROM -v_unused_overlay::bigint THEN
      RAISE EXCEPTION 'diamond_abort_overlay_return_changed' USING ERRCODE='P0404';
    END IF;
  END IF;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_house_funding:=v_expected_prize-v_e.prize_balance;
  IF v_house_funding IS DISTINCT FROM v_e.prize_out OR v_house_funding<0
     OR v_e.bounty_balance IS DISTINCT FROM v_expected_bounty
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'diamond_abort_bank_shortfall_not_prior_prizes' USING ERRCODE='P0404';
  END IF;
  IF v_house_funding>0 THEN
    -- This is a source-derived incident cost, not a new advertised guarantee,
    -- arbitrary caller amount, or promotional issuance. Preserve every open
    -- house earmark. These exact register/custody legs are the installed
    -- guarantee-overlay funding pattern, with a distinct abort identity.
    SELECT balance INTO v_house_before FROM public.ca_diamond_house WHERE id=1 FOR UPDATE;
    IF NOT FOUND OR public.fn_ca_diamond_house_available()<v_house_funding THEN
      RAISE EXCEPTION 'diamond_abort_house_unencumbered_funds_short' USING ERRCODE='P0404';
    END IF;
    SELECT count(*) INTO v_n FROM public.poker_diamond_custody
     WHERE target_id=p_tournament_id AND purpose='tournament_entry' AND state='active';
    IF v_n<1 OR v_house_funding<>trunc(v_house_funding) OR v_house_funding>2147483647 THEN
      RAISE EXCEPTION 'diamond_abort_compensation_custody_missing' USING ERRCODE='P0404';
    END IF;
    v_key:='poker-tournament-abort-house:'||p_operation_id||':'||p_tournament_id;
    SELECT coalesce(sum(CASE WHEN action='mint' THEN amount ELSE -amount END),0)
      INTO v_supply FROM public.ca_mint_ledger WHERE asset='diamonds';
    UPDATE public.ca_diamond_house SET balance=balance-v_house_funding,updated_at=now()
     WHERE id=1 RETURNING balance INTO v_house_after;
    INSERT INTO public.ca_mint_ledger
      (op_id,action,asset,holder_type,holder_id,holder_label,amount,
       balance_before,balance_after,supply_after,reason)
    VALUES(v_key,'burn','diamonds','house',c_house,'the house',v_house_funding,
      v_house_before,v_house_after,v_supply-v_house_funding,
      'Owner-requested stopped-event refund: house absorbs the original paid prizes; operation '||p_operation_id);
    v_supply:=v_supply-v_house_funding;
    v_share:=v_house_funding::bigint/v_n; v_rest:=v_house_funding::bigint%v_n;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
      WHERE c.target_id=p_tournament_id AND c.purpose='tournament_entry' AND c.state='active'
      ORDER BY c.created_at,c.id FOR UPDATE
    LOOP
      v_index:=v_index+1;
      v_take:=v_share+CASE WHEN v_index<=v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take=0;
      SELECT coalesce(diamonds,0),coalesce(nullif(btrim(username),''),full_name,id::text)
        INTO v_holder_wallet,v_holder_label FROM public.profiles WHERE id=v_c.user_id;
      v_register:=v_key||':'||v_c.id;
      v_supply:=v_supply+v_take;
      INSERT INTO public.ca_mint_ledger
        (op_id,action,asset,holder_type,holder_id,holder_label,amount,
         balance_before,balance_after,supply_after,reason)
      VALUES(v_register,'mint','diamonds','player',v_c.user_id,v_holder_label,v_take,
        v_holder_wallet,v_holder_wallet,v_supply,
        'House-funded stopped-event refund cost held in original event custody; operation '||p_operation_id);
      v_request:=uuid_in(md5(v_register)::cstring);
      INSERT INTO public.poker_diamond_movements
        (request_id,custody_id,user_id,action,amount,source_account,destination_account,
         wallet_journal_id,request,receipt)
      VALUES(v_request,v_c.id,v_c.user_id,'reserve',v_take,'house:'||c_house,'arena_custody:'||v_c.id,NULL,
        jsonb_build_object('action','guarantee_overlay','bank','prize',
          'purpose','owner_requested_abort_preserves_original_prizes',
          'operation_id',p_operation_id,'tournament_id',p_tournament_id,'amount',v_take),
        jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,
          'custody_balance',v_c.balance+v_take,'journal_id',NULL,'register_op_id',v_register));
      UPDATE public.poker_diamond_custody SET balance=balance+v_take WHERE id=v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger
        (tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
         idempotency_key,wallet_journal_id,request)
      VALUES(p_tournament_id,v_t.club_id,v_c.user_id,v_c.id,'overlay',v_take,v_take,0,0,
        v_register,NULL,jsonb_build_object('kind','overlay','source','house',
          'purpose','owner_requested_abort_preserves_original_prizes',
          'abort_operation_id',p_operation_id,'request_id',v_request,'register_op_id',v_register));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'owner-requested abort compensation',
      p_overlay_in=>v_house_funding);
  END IF;
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);

  FOR v_charge IN SELECT l.* FROM public.poker_diamond_tournament_ledger l
    WHERE l.tournament_id=p_tournament_id AND l.kind IN('entry','rebuy','reentry','addon')
      AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger r
        WHERE r.custody_id=l.custody_id AND r.kind='refund'
          AND coalesce(r.request->>'abort_operation_id','')<>p_operation_id::text)
    ORDER BY l.user_id,l.id
  LOOP
    v_key:='poker-tournament-abort-refund:'||p_tournament_id||':charge:'||v_charge.id;
    INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
      VALUES(v_key,v_charge.user_id,v_charge.amount) ON CONFLICT(key) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'diamond_abort_unsealed_refund_key' USING ERRCODE='P0404';
    END IF;
    v_credit:=public.add_diamonds_to_balance(v_charge.user_id,v_charge.amount::integer,
      'arena_withdraw','Owner-requested stopped tournament refund: '||coalesce(v_t.name,'tournament'),v_key);
    IF v_credit->>'success' IS DISTINCT FROM 'true'
       OR nullif(v_credit->>'transaction_id','') IS NULL
       OR (v_credit->>'amount')::numeric IS DISTINCT FROM v_charge.amount::numeric THEN
      RAISE EXCEPTION 'diamond_abort_wallet_credit_failed' USING ERRCODE='P0404';
    END IF;
    v_drained:='[]'::jsonb;
    IF v_charge.prize_part>0 THEN
      v_drained:=v_drained||public.fn_poker_diamond_tournament_drain(p_tournament_id,'prize',
        v_charge.prize_part,v_key||':prize','player:'||v_charge.user_id,
        (v_credit->>'transaction_id')::uuid);
    END IF;
    IF v_charge.bounty_part>0 THEN
      v_drained:=v_drained||public.fn_poker_diamond_tournament_drain(p_tournament_id,'bounty',
        v_charge.bounty_part,v_key||':bounty','player:'||v_charge.user_id,
        (v_credit->>'transaction_id')::uuid);
    END IF;
    IF v_charge.fee_part>0 THEN
      v_drained:=v_drained||public.fn_poker_diamond_tournament_drain(p_tournament_id,'fee',
        v_charge.fee_part,v_key||':fee','player:'||v_charge.user_id,
        (v_credit->>'transaction_id')::uuid);
    END IF;
    IF (SELECT coalesce(sum((d->>'amount')::numeric),0) FROM jsonb_array_elements(v_drained)d)
        IS DISTINCT FROM v_charge.amount::numeric THEN
      RAISE EXCEPTION 'diamond_abort_refund_custody_drain_mismatch' USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_obligations
      (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
    VALUES(p_tournament_id,'refund',NULL,v_charge.user_id,v_charge.amount,v_charge.amount,
      'owner_requested_started_tournament_abort',now())
    ON CONFLICT(tournament_id,kind,user_id) WHERE place IS NULL DO UPDATE
      SET amount_owed=public.tournament_obligations.amount_owed+EXCLUDED.amount_owed,
          amount_paid=public.tournament_obligations.amount_paid+EXCLUDED.amount_paid,
          updated_at=now(),settled_at=now()
    RETURNING id INTO v_ob;
    INSERT INTO public.poker_diamond_tournament_ledger
      (tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
       idempotency_key,wallet_journal_id,obligation_id,request)
    VALUES(p_tournament_id,v_t.club_id,v_charge.user_id,NULL,'refund',v_charge.amount,
      v_charge.prize_part,v_charge.bounty_part,v_charge.fee_part,v_key,
      (v_credit->>'transaction_id')::uuid,v_ob,
      jsonb_build_object('kind','owner_requested_started_abort','abort_operation_id',p_operation_id,
        'charge_ledger_id',v_charge.id,'original_custody_id',v_charge.custody_id,
        'original_charge_journal_id',v_charge.wallet_journal_id,'drained',v_drained))
    RETURNING id INTO v_ledger;
    PERFORM public.fn_ca_escrow_apply_exact_refund(p_tournament_id,'started Diamond abort',
      v_charge.prize_part,v_charge.bounty_part,v_charge.fee_part);
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
    v_refunds:=v_refunds||jsonb_build_object('user_id',v_charge.user_id,'amount',v_charge.amount,
      'refund_prize',v_charge.prize_part,'refund_bounty',v_charge.bounty_part,'refund_fee',v_charge.fee_part,
      'ledger_id',v_ledger,'obligation_id',v_ob,'journal_id',v_credit->>'transaction_id',
      'charge_ledger_ids',jsonb_build_array(v_charge.id),'debt_settled',v_credit->'debt_settled');
    v_refunded:=v_refunded+v_charge.amount;
    v_refund_prize:=v_refund_prize+v_charge.prize_part;
    v_refund_bounty:=v_refund_bounty+v_charge.bounty_part;
    v_refund_fee:=v_refund_fee+v_charge.fee_part;
  END LOOP;
  IF (v_refunded,v_refund_prize,v_refund_bounty,v_refund_fee)
      IS DISTINCT FROM (v_expected,v_expected_prize,v_expected_bounty,v_expected_fee) THEN
    RAISE EXCEPTION 'diamond_abort_original_charge_refunds_incomplete' USING ERRCODE='P0404';
  END IF;
  v_closed:=public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
  IF v_closed->>'ok' IS DISTINCT FROM 'true'
     OR (v_closed->>'still_held')::numeric IS DISTINCT FROM 0::numeric
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM 0
     OR EXISTS(SELECT 1 FROM public.poker_diamond_custody c WHERE c.target_id=p_tournament_id
       AND c.purpose='tournament_entry' AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_abort_custody_not_closed' USING ERRCODE='P0404';
  END IF;
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  IF md5(coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.tournament_obligations o WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund'),
      '[]'::jsonb)::text) IS DISTINCT FROM v_awards_hash THEN
    RAISE EXCEPTION 'diamond_abort_prior_awards_changed' USING ERRCODE='P0404';
  END IF;
  v_receipt:=jsonb_build_object('ok',true,'fully_settled',true,'asset','diamonds',
    'tournament_id',p_tournament_id,'operation_id',p_operation_id,
    'total_refunded',v_refunded,'refund_prize',v_refund_prize,'refund_bounty',v_refund_bounty,
    'refund_fee',v_refund_fee,'refunds',v_refunds,'zero_refund_users',v_zero_users,
    'prior_refunds_preserved',v_old_refund,'unused_overlay_returned',v_unused_overlay,
    'house_absorbed_prior_prizes',v_house_funding,'prior_awards_preserved',v_awards,
    'prior_awards_hash',v_awards_hash,'charges_hash',v_charges_hash,'remaining_custody',0);
  INSERT INTO smarter_private.diamond_tournament_abort_receipts(operation_id,tournament_id,receipt)
    VALUES(p_operation_id,p_tournament_id,v_receipt);
  RETURN v_receipt;
END; $body$;
ALTER FUNCTION smarter_private.diamond_tournament_abort_refunds(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.diamond_tournament_abort_refunds(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;


CREATE FUNCTION public.fn_ca_settle_tournament_abort(p_operation_id uuid,p_tournament_id uuid,p_expected_money_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE a smarter_private.tournament_abort_targets;t public.tournaments; financial jsonb; v_receipt jsonb; pre_roster jsonb; pre_seats jsonb; before_history jsonb; after_history jsonb;
 player_ids uuid[];refunded_ids uuid[];zero_ids uuid[];table_ids uuid[];seat_ids uuid[];released_ids uuid[];fee_ids uuid[]:='{}';
 fee record;fee_id uuid; rake_before numeric;rake_after numeric;fees_reversed numeric:=0; settled timestamptz:=clock_timestamp();
 actor constant uuid:='2d1cd6c3-5700-4af9-a271-d4863fdab20d'; v_close_note constant text:='Explicit operator started-event abort after generation-bound physical and manager drain';
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_target_not_owned';END IF;
 IF a.state='settled' THEN RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);END IF;
 PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
 IF p_expected_money_hash IS NULL OR p_expected_money_hash IS DISTINCT FROM a.quiescence->>'money_hash' THEN RAISE EXCEPTION 'operator_abort_review_hash_mismatch' USING ERRCODE='55000';END IF;
 IF t.started_at IS NULL OR upper(t.status) NOT IN('RUNNING','BREAK','LATE_REG') THEN RAISE EXCEPTION 'operator_abort_parent_not_running';END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id ORDER BY s.id FOR UPDATE OF s;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'),coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO player_ids,pre_roster FROM public.tournament_players p WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO table_ids FROM public.tables WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO seat_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'table_id',s.table_id,'user_id',s.user_id,'seat_number',s.seat_number,'stack',s.stack,'status',s.status,'left_at',s.left_at,'occupancy_id',to_jsonb(s)->'occupancy_id') ORDER BY s.id),'[]'::jsonb) INTO pre_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO released_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id AND s.left_at IS NULL;
 before_history:=jsonb_build_object('awards',a.money_snapshot->'awards','bounty_awards',a.money_snapshot->'bounty_awards','satellite_awards',a.money_snapshot->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF a.asset='diamonds' THEN financial:=smarter_private.diamond_tournament_abort_refunds(p_operation_id,p_tournament_id);
 ELSE financial:=smarter_private.chip_tournament_abort_refunds(p_operation_id,p_tournament_id);END IF;
 IF financial->>'fully_settled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'operator_abort_financial_receipt_incomplete';END IF;
 SELECT coalesce(sum(rake_amount),0) INTO rake_before FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_before<0 OR rake_before::text IN('NaN','Infinity','-Infinity') OR round(coalesce(t.total_rake,0),2) IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_cache_mismatch';END IF;
 FOR fee IN SELECT club_id,metadata->>'user_id' user_id,sum(rake_amount) amount,jsonb_agg(id ORDER BY id) source_ids FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament GROUP BY club_id,metadata->>'user_id' HAVING sum(rake_amount)>0 ORDER BY club_id,metadata->>'user_id' LOOP
  IF fee.club_id IS NULL OR fee.user_id IS NULL THEN RAISE EXCEPTION 'operator_abort_unattributed_rake_source';END IF;
  INSERT INTO public.rake_records(club_id,rake_amount,pot_size,num_players,bbj_contribution,is_tournament,tournament_id,source,metadata)
  VALUES(fee.club_id,-fee.amount,fee.amount,1,0,true,p_tournament_id,'operator_abort_tournament',jsonb_build_object('kind','tournament_fee_refund','operation_id',p_operation_id,'user_id',fee.user_id,'original_rake_record_ids',fee.source_ids)) RETURNING id INTO fee_id;
  fee_ids:=array_append(fee_ids,fee_id);fees_reversed:=fees_reversed+fee.amount;
 END LOOP;
 SELECT coalesce(sum(rake_amount),0) INTO rake_after FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_after<>0 OR fees_reversed IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_not_exactly_closed';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=p_tournament_id AND enforced AND closed_at IS NULL AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) THEN RAISE EXCEPTION 'operator_abort_escrow_not_exact_zero';END IF;
 UPDATE public.tournament_escrow SET closed_at=settled,close_note=v_close_note,updated_at=now() WHERE tournament_id=p_tournament_id;
 -- Keep original eliminated_at, elimination sequence, finish position and prize.
 -- Active remaining virtual stacks are administrative retirements, not results.
 UPDATE public.tournament_players SET status='eliminated',chips=0,current_bounty=0 WHERE tournament_id=p_tournament_id AND status::text<>'eliminated';
 UPDATE public.table_seats s SET left_at=coalesce(s.left_at,settled),status='left',stack=0,leave_pending=false,is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
  FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id;
 UPDATE public.tournaments SET status='CANCELLED',ended_at=settled,updated_at=now(),prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,on_break=false,break_started_at=NULL,break_ends_at=NULL WHERE id=p_tournament_id;
 UPDATE public.tables SET status='closed',lifecycle='closed',current_players=0,terminal_closed_at=settled,updated_at=now() WHERE tournament_id=p_tournament_id;
 after_history:=jsonb_build_object('awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'awards','bounty_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'bounty_awards','satellite_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF before_history IS DISTINCT FROM after_history THEN RAISE EXCEPTION 'operator_abort_earned_results_or_original_hands_changed:%:%:%:%',before_history,after_history,financial->'prior_awards_preserved',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id=p_tournament_id AND kind<>'refund');END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refunded_ids FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(financial->'refunds') r WHERE (r->>'user_id')::uuid=p.user_id);
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO zero_ids FROM unnest(player_ids) id WHERE NOT id=ANY(refunded_ids);
 v_receipt:=jsonb_build_object('ok',true,'success',true,'fully_settled',true,'receipt_version',3,'mode','started_operator_abort','operation_id',p_operation_id,'tournament_id',p_tournament_id,'actor_id',actor,'status','CANCELLED',
 'source_player_count',cardinality(player_ids),'refunded_count',cardinality(refunded_ids),'refund_line_count',jsonb_array_length(financial->'refunds'),'ticket_return_count',0,'ticket_returns','[]'::jsonb,'total_ticket_returned',0,
 'total_refunded',(financial->>'total_refunded')::numeric,'fees_reversed',fees_reversed,'closed_table_count',cardinality(table_ids),'source_seat_count',cardinality(seat_ids),'released_seat_count',cardinality(released_ids),'refunds',financial->'refunds','settled_at',settled,
 'original_started_at',t.started_at,'financial',financial,'pre_abort_roster',pre_roster,'pre_abort_seats',pre_seats,'preserved_history',before_history,'quiescence',a.quiescence,'terminal_snapshot',smarter_private.tournament_abort_terminal_snapshot(p_tournament_id));
 UPDATE smarter_private.tournament_abort_targets SET state='settled',receipt=v_receipt,settled_at=settled WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id;
 INSERT INTO public.tournament_cancellation_receipts(tournament_id,actor_id,receipt_version,source_player_count,source_player_ids,refunded_count,refunded_registration_ids,refund_line_count,ticket_return_count,ticket_return_ids,total_ticket_returned,zero_refund_count,zero_refund_registration_ids,total_refunded,fees_reversed,total_rake_before,total_rake_after,closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,released_seat_count,released_seat_ids,fee_reversal_ids,escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,receipt,settled_at)
 VALUES(p_tournament_id,actor,3,cardinality(player_ids),player_ids,cardinality(refunded_ids),refunded_ids,jsonb_array_length(financial->'refunds'),0,'{}',0,cardinality(zero_ids),zero_ids,(financial->>'total_refunded')::numeric,fees_reversed,rake_before,rake_after,cardinality(table_ids),table_ids,cardinality(seat_ids),seat_ids,cardinality(released_ids),released_ids,fee_ids,settled,v_close_note,NULL,v_receipt,settled);
 IF a.asset='chips' THEN PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);END IF;
 RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_settle_tournament_abort(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_tournament_abort(uuid,uuid,text) TO service_role;

COMMIT;
