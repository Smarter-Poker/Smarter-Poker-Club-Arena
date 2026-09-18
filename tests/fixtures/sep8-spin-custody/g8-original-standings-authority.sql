-- Only a recorded original three-player outcome may cross this explicit door.
-- The public terminal transaction remains the sole payer and physical closer.
CREATE TABLE smarter_private.spin_original_standings (
 tournament_id uuid PRIMARY KEY CHECK(tournament_id IN(
 'b60c7add-6b38-4549-b091-601f64d118a0','199a71a9-f364-4e90-a3ba-3cdcfb7755bc',
 'f3f050f1-569e-4fb6-859f-86b6092e682e','808ef798-0942-4ce0-9ae1-eeefaaf4b0a9',
 'e3f4e2ab-8397-43e8-8643-6cec3fff3a63')),
 operation_id uuid NOT NULL UNIQUE,
 winner_id uuid NOT NULL,
 expected jsonb NOT NULL,
 expected_hash text NOT NULL CHECK(expected_hash=md5(expected::text)),
 admitted_xid bigint NOT NULL DEFAULT txid_current(),
 admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE smarter_private.spin_original_standings OWNER TO postgres;
ALTER TABLE smarter_private.spin_original_standings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.spin_original_standings FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_original_standings_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_IMMUTABLE' USING ERRCODE='55000'; END $fn$;
CREATE TRIGGER spin_original_standings_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.spin_original_standings FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_original_standings_immutable();
CREATE TRIGGER spin_original_standings_no_truncate BEFORE TRUNCATE
 ON smarter_private.spin_original_standings FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.spin_original_standings_immutable();
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_original_current_case(p_tournament uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE result jsonb; rowset jsonb; item record; boundary bigint;
BEGIN
 SELECT max(hand_number) INTO boundary FROM public.tournament_knockout_candidates WHERE tournament_id=p_tournament;
 SELECT jsonb_build_object('tournament',to_jsonb(t)-ARRAY['updated_at','current_level']) INTO result
 FROM public.tournaments t WHERE id=p_tournament;
 FOR item IN SELECT * FROM (VALUES
 ('roster','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.tournament_players r WHERE tournament_id=$1'),
 ('candidates','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.tournament_knockout_candidates r WHERE tournament_id=$1'),
 ('escrow','SELECT to_jsonb(r) FROM public.tournament_escrow r WHERE tournament_id=$1'),
 ('entry_close','SELECT to_jsonb(r) FROM public.tournament_entry_close_receipts r WHERE tournament_id=$1'),
 ('payouts','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.tournament_payouts r WHERE tournament_id=$1'),
 ('obligations','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.tournament_obligations r WHERE tournament_id=$1'),
 ('wallet_keys','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY key),''[]'') FROM public.wallet_credit_idempotency r WHERE key LIKE ''tourney:''||$1::text||'':%'''),
 ('rake_records','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.rake_records r WHERE tournament_id=$1'),
 ('rake_settlement','SELECT to_jsonb(r) FROM public.tournament_rake_settlements r WHERE tournament_id=$1'),
 ('terminal','SELECT to_jsonb(r) FROM public.tournament_terminal_settlements r WHERE tournament_id=$1'),
 ('tables','SELECT coalesce(jsonb_agg(to_jsonb(r)-''updated_at'' ORDER BY id),''[]'') FROM public.tables r WHERE tournament_id=$1'),
 ('seats','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.table_seats r JOIN public.tables b ON b.id=r.table_id WHERE b.tournament_id=$1'),
 ('atomic','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.hand_id),''[]'') FROM public.hand_atomic_commits r JOIN public.tables b ON b.id=r.table_id WHERE b.tournament_id=$1 AND r.hand_number >= $2'),
 ('history','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.hand_history r WHERE (r.tournament_id=$1 OR r.table_id IN(SELECT id FROM public.tables WHERE tournament_id=$1)) AND r.hand_number >= $2'),
 ('settlement_keys','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.hand_id),''[]'') FROM public.settlement_idempotency_keys r JOIN public.tables b ON b.id=r.table_id WHERE b.tournament_id=$1'),
 ('ledger','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),''[]'') FROM public.chip_ledger r WHERE tournament_id=$1 OR from_entity_id=$1 OR to_entity_id=$1')
 ) q(name,query) LOOP
  EXECUTE item.query INTO rowset USING p_tournament,boundary;
  result:=result||jsonb_build_object(item.name,rowset);
 END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_original_current_case(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Invoked after canonical survivor promotion, and again after payout/replay.
-- No missing original sequence or hand is created. The two original busts
-- remain byte-equivalent, including their NULL/non-NULL sequence distinction.
CREATE FUNCTION smarter_private.spin_original_standings_witness(p_tournament uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE r smarter_private.spin_original_standings%ROWTYPE; original jsonb; current_rows jsonb;
 original_busts jsonb; current_busts jsonb; winner jsonb; original_winner jsonb; candidate jsonb;
BEGIN
 SELECT * INTO r FROM smarter_private.spin_original_standings WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 original:=r.expected->'snapshot';
 IF r.winner_id IS DISTINCT FROM p_winner OR r.expected_hash IS DISTINCT FROM md5(r.expected::text)
 OR original IS DISTINCT FROM smarter_private.spin_original_retained_case(p_tournament)
 OR (r.admitted_xid<>txid_current() AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament)) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_WITNESS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') INTO current_rows FROM public.tournament_players p WHERE tournament_id=p_tournament;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original_busts FROM jsonb_array_elements(original->'roster') v WHERE v->>'user_id'<>p_winner::text;
 SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') INTO current_busts FROM jsonb_array_elements(current_rows) v WHERE v->>'user_id'<>p_winner::text;
 SELECT v INTO original_winner FROM jsonb_array_elements(original->'roster') v WHERE v->>'user_id'=p_winner::text;
 SELECT v INTO winner FROM jsonb_array_elements(current_rows) v WHERE v->>'user_id'=p_winner::text;
 candidate:=original->'candidates'->0;
 IF jsonb_array_length(current_rows)<>3 OR jsonb_array_length(original_busts)<>2
 OR current_busts IS DISTINCT FROM (SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') FROM jsonb_array_elements(original_busts) v)
 OR (winner-ARRAY['status','position','prize','terminal_closed_at']) IS DISTINCT FROM (original_winner-ARRAY['status','position','prize','terminal_closed_at'])
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_tournament
   AND p.terminal_closed_at IS DISTINCT FROM (SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament))
 OR winner->>'status' IS DISTINCT FROM 'winner' OR winner->'position' IS DISTINCT FROM '1'::jsonb
 OR winner->'chips' IS DISTINCT FROM '3000'::jsonb
 OR (winner->>'prize')::numeric NOT IN(0,(original->'tournament'->>'prize_pool')::numeric)
 OR (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.tournament_knockout_candidates c WHERE tournament_id=p_tournament) IS DISTINCT FROM original->'candidates'
 OR (SELECT to_jsonb(a) FROM public.hand_atomic_commits a WHERE hand_id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'atomic'->0
 OR (SELECT to_jsonb(h) FROM public.hand_history h WHERE id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'history'->0 THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('operation_id',r.operation_id,'expected_hash',r.expected_hash,
  'tournament_id',p_tournament,'winner_id',p_winner,'original_ranks',original_busts,
  'accepted_candidate',candidate,'accepted_hand_id',candidate->'hand_id',
  'accepted_hand_number',candidate->'hand_number','original_outcome','recorded_standings',
  'admitted_at',r.admitted_at);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_witness(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_original_standings_requires_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE cash jsonb;
BEGIN
 SELECT cash_receipt INTO cash FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF cash IS NULL OR cash->'original_standings' IS DISTINCT FROM smarter_private.spin_original_standings_witness(NEW.tournament_id,NEW.winner_id)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED') THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_TERMINAL_REQUIRED' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER spin_original_standings_requires_terminal AFTER INSERT
 ON smarter_private.spin_original_standings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_original_standings_requires_terminal();
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_requires_terminal() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_complete_sep8_spin_original_standings(p_operation_id uuid,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private
SET statement_timeout='30s' SET lock_timeout='3s' AS $fn$
DECLARE t uuid; tab uuid; survivor uuid; original jsonb; actual jsonb; manager jsonb; result jsonb;
 r smarter_private.spin_original_standings%ROWTYPE; boundary bigint; funding jsonb;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true THEN RAISE EXCEPTION 'service authority required' USING ERRCODE='28000'; END IF;
 IF p_operation_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_REQUEST_REQUIRED' USING ERRCODE='22023'; END IF;
 t:=(p_expected->>'tournament_id')::uuid;
 original:=smarter_private.spin_original_retained_case(t);
 IF original IS NULL THEN RAISE EXCEPTION 'SPIN_ORIGINAL_EVENT_NOT_NAMED' USING ERRCODE='22023'; END IF;
 SELECT (v->>'user_id')::uuid INTO survivor FROM jsonb_array_elements(original->'roster') v WHERE v->>'status'='playing';
 tab:=(original->'tables'->0->>'id')::uuid;
 boundary:=(original->'candidates'->0->>'hand_number')::bigint;
 PERFORM public.fn_ca_lock_settlement_lane_for_finish(t);
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 SELECT * INTO r FROM smarter_private.spin_original_standings WHERE tournament_id=t;
 IF FOUND THEN
  IF r.operation_id IS DISTINCT FROM p_operation_id OR r.expected IS DISTINCT FROM p_expected THEN
   RAISE EXCEPTION 'SPIN_ORIGINAL_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  result:=public.fn_ca_tournament_terminal_receipt(t,survivor);
  IF (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
    IS DISTINCT FROM smarter_private.spin_original_standings_witness(t,survivor) THEN
   RAISE EXCEPTION 'SPIN_ORIGINAL_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN result;
 END IF;
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 SELECT to_jsonb(l)-ARRAY['heartbeat_at','acquired_at'] INTO manager FROM public.engine_tournament_leases l WHERE tournament_id=t;
 IF manager IS NULL OR manager->>'protocol_version'<>'2' OR manager->>'lease_generation' IS NULL
 OR p_expected IS DISTINCT FROM jsonb_build_object('tournament_id',t,'manager',manager,'snapshot',original) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_EXPECTED_OR_MANAGER_CHANGED' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tournament_obligations WHERE tournament_id=t ORDER BY kind,place,id FOR UPDATE;
 PERFORM 1 FROM public.tournament_escrow WHERE tournament_id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_entry_close_receipts WHERE tournament_id=t FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id WHERE b.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 PERFORM 1 FROM public.tournament_knockout_candidates WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM a.hand_id FROM public.hand_atomic_commits a JOIN public.tables b ON b.id=a.table_id WHERE b.tournament_id=t AND a.hand_number>=boundary ORDER BY a.hand_id FOR SHARE OF a;
 PERFORM 1 FROM public.hand_history WHERE tournament_id=t AND hand_number>=boundary ORDER BY id FOR SHARE;
 PERFORM k.hand_id FROM public.settlement_idempotency_keys k JOIN public.tables b ON b.id=k.table_id WHERE b.tournament_id=t ORDER BY k.hand_id FOR SHARE OF k;
 PERFORM 1 FROM public.chip_ledger WHERE tournament_id=t OR from_entity_id=t OR to_entity_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.rake_records WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.tournament_refund_entitlements WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.spin_reserve_ledger WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.managed_game_contract_versions WHERE game_id=t ORDER BY id FOR SHARE;
 actual:=smarter_private.spin_original_current_case(t);
 IF actual IS DISTINCT FROM original THEN RAISE EXCEPTION 'SPIN_ORIGINAL_PREIMAGE_CHANGED' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.engine_table_leases WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=tab AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=t) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_LATER_AUTHORITY' USING ERRCODE='40001'; END IF;
 -- Existing original charge/reserve/scope proof owns funding. Standings do not
 -- infer earning authority from a remaining fee balance.
 funding:=public.fn_ca_sep8_spin_original_fee_proof(t);
 IF (funding->>'recognized_contributors')::integer IS DISTINCT FROM 3
 OR (funding->>'fee')::numeric IS DISTINCT FROM (original->'escrow'->>'fee_balance')::numeric THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_FUNDING_CHANGED' USING ERRCODE='P0404'; END IF;
 INSERT INTO smarter_private.spin_original_standings(tournament_id,operation_id,winner_id,expected,expected_hash)
 VALUES(t,p_operation_id,survivor,p_expected,md5(p_expected::text));
 result:=public.fn_complete_tournament_terminal(t,survivor,'places');
 IF (result->>'ok')::boolean IS DISTINCT FROM true
 OR (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
   IS DISTINCT FROM smarter_private.spin_original_standings_witness(t,survivor) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_complete_sep8_spin_original_standings(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_sep8_spin_original_standings(uuid,jsonb) TO service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_complete_sep8_spin_original_standings','approved','Exact five original Spin standings; immutable witness, unchanged terminal payer and fee custody')
 ON CONFLICT(proname) DO NOTHING;
