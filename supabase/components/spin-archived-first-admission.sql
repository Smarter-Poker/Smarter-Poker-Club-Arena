-- FIRST-CASE CANDIDATE ONLY. Not a migration; full connected native financial
-- qualification remains required before any installation. No scheduled caller.
-- Requires the compiled first witness and exact current provider functions.
BEGIN;
CREATE TABLE smarter_private.spin_archived_first_admission (
 tournament_id uuid PRIMARY KEY CHECK(tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 operation_id uuid NOT NULL UNIQUE,
 lease_generation uuid NOT NULL,
 owner_instance text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256='8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'),
 original_fee_proof jsonb NOT NULL,
 admitted_xid bigint NOT NULL DEFAULT txid_current(),
 admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE smarter_private.spin_archived_first_admission OWNER TO postgres;
ALTER TABLE smarter_private.spin_archived_first_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.spin_archived_first_admission FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'ARCHIVED_SPIN_ADMISSION_IMMUTABLE' USING ERRCODE='55000'; END $fn$;
CREATE TRIGGER spin_archived_first_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.spin_archived_first_admission FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
CREATE TRIGGER spin_archived_first_no_truncate BEFORE TRUNCATE
 ON smarter_private.spin_archived_first_admission FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_launch_witness(p_tournament uuid,p_started_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE admitted smarter_private.spin_archived_first_admission%ROWTYPE; witness jsonb;
BEGIN
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF admitted.admitted_xid IS DISTINCT FROM txid_current()
 OR NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases
   WHERE tournament_id=p_tournament AND protocol_version=2
   AND lease_generation=admitted.lease_generation AND instance_id=admitted.owner_instance
   AND heartbeat_at>=clock_timestamp()-interval '30 seconds') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_AUTHORITY_CHANGED' USING ERRCODE='40001'; END IF;
 witness:=smarter_private.spin_archived_first_preimage();
 IF p_started_at IS DISTINCT FROM (witness->'first_history'->>'created_at')::timestamptz THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_FIRST_HAND_IDENTITY' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('ok',true,'evidence_kind','archived_database_projection',
  'source_sha256',admitted.source_sha256,'operation_id',admitted.operation_id,
  'first_hand_at',p_started_at,'playing',1,'eliminated',2,'dealt_field',3,
  'required_players',3,'original_atomic_commit',NULL);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_launch_witness(uuid,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_standings(p_tournament uuid,p_winner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE admitted smarter_private.spin_archived_first_admission%ROWTYPE;
 original jsonb; original_player jsonb; actual_player jsonb; terminal_time timestamptz;
 original_busts jsonb; expected_prize numeric; player_count integer;
BEGIN
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 original:=smarter_private.spin_archived_first_manifest();
 IF p_winner IS DISTINCT FROM 'aef849b8-2906-4dc0-b108-251710e76d3c'::uuid
 OR admitted.source_sha256 IS DISTINCT FROM original->>'source_sha256'
 OR (admitted.admitted_xid<>txid_current() AND NOT EXISTS(
  SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament)) THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_STANDINGS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT completed_at INTO terminal_time FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament;
 SELECT count(*) INTO player_count FROM public.tournament_players WHERE tournament_id=p_tournament;
 IF player_count<>3 THEN RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CHANGED' USING ERRCODE='40001'; END IF;
 expected_prize:=(original->'captured_preimage'->'tournaments'->0->>'prize_pool')::numeric;
 FOR original_player IN SELECT value FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') LOOP
  SELECT to_jsonb(p)-'username' INTO actual_player FROM public.tournament_players p
   WHERE p.tournament_id=p_tournament AND p.id=(original_player->>'id')::uuid;
  IF actual_player IS NULL OR (actual_player->>'terminal_closed_at')::timestamptz IS DISTINCT FROM terminal_time THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CLOSURE_CHANGED' USING ERRCODE='40001'; END IF;
  IF original_player->>'user_id'=p_winner::text THEN
   IF (actual_player-ARRAY['status','position','prize','terminal_closed_at'])
       IS DISTINCT FROM (original_player-ARRAY['status','position','prize','terminal_closed_at'])
    OR actual_player->>'status' IS DISTINCT FROM 'winner'
    OR actual_player->'position' IS DISTINCT FROM '1'::jsonb
    OR actual_player->>'prize' IS NULL
    OR (actual_player->>'prize')::numeric NOT IN(0,expected_prize) THEN
    RAISE EXCEPTION 'ARCHIVED_SPIN_WINNER_CHANGED' USING ERRCODE='40001'; END IF;
  ELSIF actual_player-'terminal_closed_at' IS DISTINCT FROM original_player-'terminal_closed_at' THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_RECORDED_PLACE_CHANGED' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'id') INTO original_busts
 FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') WHERE value->>'user_id'<>p_winner::text;
 RETURN jsonb_build_object('evidence_kind','archived_database_projection','operation_id',admitted.operation_id,
  'source_sha256',admitted.source_sha256,'tournament_id',p_tournament,'winner_id',p_winner,
  'original_ranks',original_busts,'original_outcome','recorded_standings',
  'original_first_history',original->'original_first_history',
  'original_last_history',original->'original_last_history','original_atomic_commit',NULL,
  'admitted_at',admitted.admitted_at);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_standings(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_requires_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE cash jsonb;
BEGIN
 SELECT cash_receipt INTO cash FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF cash IS NULL OR cash->'original_standings' IS DISTINCT FROM smarter_private.spin_archived_first_standings(
  NEW.tournament_id,'aef849b8-2906-4dc0-b108-251710e76d3c')
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_ATOMIC_TERMINAL_REQUIRED' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER spin_archived_first_requires_terminal AFTER INSERT
 ON smarter_private.spin_archived_first_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_archived_first_requires_terminal();
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_requires_terminal() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_complete_first_archived_spin(p_operation_id uuid,p_expected_source_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC'
SET statement_timeout='30s' SET lock_timeout='3s' AS $fn$
DECLARE t uuid:='2aa4cba1-506f-426b-a1ba-d8e22e018533';
 winner uuid:='aef849b8-2906-4dc0-b108-251710e76d3c';
 tab uuid:='6eaddeaf-1511-4265-bb38-37811ae82ad9';
 owner_name text; admitted smarter_private.spin_archived_first_admission%ROWTYPE;
 claimed record; witness jsonb; funding jsonb; result jsonb;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true THEN RAISE EXCEPTION 'service authority required' USING ERRCODE='28000'; END IF;
 IF p_operation_id IS NULL OR p_expected_source_sha256 IS DISTINCT FROM
  smarter_private.spin_archived_first_manifest()->>'source_sha256' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_SOURCE_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Serialize this finite entry point before reading its immutable admission.
 -- No ordinary manager consumes this operation lock. A committed replay never
 -- renews a lease or reacquires the financial writer lane.
 PERFORM pg_advisory_xact_lock(hashtextextended('archived-spin-first-operation:'||t::text,0));
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=t;
 IF FOUND THEN
  IF admitted.operation_id IS DISTINCT FROM p_operation_id OR admitted.source_sha256 IS DISTINCT FROM p_expected_source_sha256 THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  result:=public.fn_ca_tournament_terminal_receipt(t,winner);
  IF (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
   IS DISTINCT FROM smarter_private.spin_archived_first_standings(t,winner) THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN result;
 END IF;
 -- Match canonical launch admission before taking any event lease/lane/row.
 -- Maintenance/ABI writers must not wait behind an event lock held by a
 -- recovery transaction that is itself waiting for their admission authority.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM public.fn_ca_lock_mtt_admission_contract();
 owner_name:='service:archived-spin-first:'||p_operation_id::text;
 SELECT * INTO claimed FROM public.claim_tournament_lease_v2(t,owner_name,'archived-database-projection-v1',p_operation_id,30);
 IF claimed.granted IS DISTINCT FROM true OR claimed.holder IS DISTINCT FROM owner_name
  OR claimed.lease_generation IS DISTINCT FROM p_operation_id THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_COMPETING_OWNER' USING ERRCODE='40001'; END IF;
 -- The actual PostgREST manager prehook holds its lease before a financial
 -- endpoint takes the settlement lane. Taking that lane before our exclusive
 -- lease claim would invert that order and can deadlock a real manager.
 PERFORM public.fn_ca_lock_settlement_lane_for_finish(t);
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 -- The real lease claim precedes the parent row lock, including when the lease
 -- row is absent. Locking an absent row alone cannot fence a concurrent insert.
 -- Public launch ownership takes this same lease -> tournament order.
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 -- Recheck after blocking lease/lane/parent acquisition. The dedicated finite
 -- operation lock serializes ordinary same-operation calls; this also refuses
 -- unexpected privileged admission drift instead of attempting a second write.
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=t;
 IF FOUND THEN
  IF admitted.operation_id IS DISTINCT FROM p_operation_id OR admitted.source_sha256 IS DISTINCT FROM p_expected_source_sha256 THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  result:=public.fn_ca_tournament_terminal_receipt(t,winner);
  IF (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
   IS DISTINCT FROM smarter_private.spin_archived_first_standings(t,winner) THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN result;
 END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tournament_obligations WHERE tournament_id=t ORDER BY kind,place,id FOR UPDATE;
 PERFORM 1 FROM public.tournament_escrow WHERE tournament_id=t FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id WHERE b.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 PERFORM 1 FROM public.chip_ledger WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.tournament_refund_entitlements WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.spin_reserve_ledger WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.managed_game_contract_versions WHERE game_id=t ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.hand_history WHERE tournament_id=t OR table_id=tab)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.engine_table_leases WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=tab AND is_complete IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency
   WHERE key>='tourney:'||t::text||':' AND key<'tourney:'||t::text||';') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_LATER_AUTHORITY' USING ERRCODE='40001'; END IF;
 witness:=smarter_private.spin_archived_first_preimage();
 PERFORM 1 FROM public.rake_records WHERE tournament_id=t ORDER BY id FOR SHARE;
 funding:=public.fn_ca_legacy_spin_original_fee_proof(t);
 IF funding IS DISTINCT FROM smarter_private.spin_archived_first_manifest()->'reviewed_fee_proof' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_ORIGINAL_FUNDING_CHANGED' USING ERRCODE='P0404'; END IF;
 INSERT INTO smarter_private.spin_archived_first_admission(tournament_id,operation_id,lease_generation,owner_instance,source_sha256,original_fee_proof)
 VALUES(t,p_operation_id,p_operation_id,owner_name,p_expected_source_sha256,funding);
 result:=public.fn_begin_tournament_launch_atomic(t,p_operation_id,(witness->'first_history'->>'created_at')::timestamptz,p_operation_id);
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_BEGIN_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 result:=public.fn_complete_tournament_launch_atomic(t,p_operation_id,p_operation_id);
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_COMPLETE_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 result:=public.fn_complete_tournament_terminal(t,winner,'places');
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 RETURN result;
END $fn$;
ALTER FUNCTION public.fn_complete_first_archived_spin(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_first_archived_spin(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_first_archived_spin(uuid,text) TO service_role;
ALTER FUNCTION smarter_private.spin_archived_first_immutable() OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_launch_witness(uuid,timestamptz) OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_standings(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_requires_terminal() OWNER TO postgres;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_complete_first_archived_spin','approved',
  'Finite first archived Spin: real service lease, original source/funding, atomic canonical terminal')
 ON CONFLICT(proname) DO NOTHING;
DO $registry$
BEGIN
 IF (SELECT status FROM public.ca_money_rpc_registry
  WHERE proname='fn_complete_first_archived_spin') IS DISTINCT FROM 'approved' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_REGISTRY_AUTHORITY_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT has_function_privilege('service_role','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE')
  OR has_function_privilege('anon','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_CALLER_ACL_CHANGED' USING ERRCODE='55000';
 END IF;
END $registry$;
COMMIT;
