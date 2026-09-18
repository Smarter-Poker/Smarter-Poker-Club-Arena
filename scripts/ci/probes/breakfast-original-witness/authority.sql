-- The immutable witness records a failed original request, not a committed hand.
-- Only the exact retained Breakfast case can use this door. Ordinary tournaments
-- retain their existing hand/sequence authority and every financial payer.
CREATE TABLE smarter_private.breakfast_original_witness (
 tournament_id uuid PRIMARY KEY CHECK(tournament_id='f370585d-40ea-4085-bb8f-c7e8c74f3fb4'),
 operation_id uuid NOT NULL UNIQUE,
 expected jsonb NOT NULL,
 expected_hash text NOT NULL CHECK(expected_hash=md5(expected::text)),
 original_archive_sha256 text NOT NULL CHECK(original_archive_sha256='bec825a59f7ced2063d2ddc7c5d1859c30bbd1412178fc6535e25700d525366f'),
 original_line integer NOT NULL CHECK(original_line=164263),
 original_observed_at timestamptz NOT NULL CHECK(original_observed_at='2026-09-08T14:28:11.325815271Z'),
 original_error text NOT NULL CHECK(original_error='TOURNAMENT_SEAT_ROSTER_REQUIRED'),
 original_place integer NOT NULL CHECK(original_place=21),
 original_prize numeric NOT NULL CHECK(original_prize=0),
 target_postimage jsonb NOT NULL,
 admitted_xid bigint NOT NULL DEFAULT txid_current(),
 admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE smarter_private.breakfast_original_witness OWNER TO postgres;
ALTER TABLE smarter_private.breakfast_original_witness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.breakfast_original_witness FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.breakfast_witness_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_WITNESS_IMMUTABLE' USING ERRCODE='55000'; END
$body$;
CREATE TRIGGER breakfast_witness_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.breakfast_original_witness FOR EACH ROW
 EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
CREATE TRIGGER breakfast_witness_no_truncate BEFORE TRUNCATE
 ON smarter_private.breakfast_original_witness FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
REVOKE ALL ON FUNCTION smarter_private.breakfast_witness_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.breakfast_roster(p_tournament uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',p.id,'user_id',p.user_id,'club_id',p.club_id,'tournament_id',p.tournament_id,
  'status',p.status,'position',p.position,'chips',p.chips,'chip_count',p.chip_count,
  'prize',p.prize,'table_id',p.table_id,'seat_number',p.seat_number,
  'registered_at',p.registered_at,'eliminated_at',p.eliminated_at,
  'elimination_sequence',p.elimination_sequence,'rebuys',p.rebuys,'add_on',p.add_on,
  'rebuy_prompt_until',p.rebuy_prompt_until,'current_bounty',p.current_bounty,
  'bounty_winnings',p.bounty_winnings,'bounties_collected',p.bounties_collected,
  'source_satellite_id',p.source_satellite_id,'is_satellite_qualifier',p.is_satellite_qualifier
 ) ORDER BY p.id),'[]'::jsonb) FROM public.tournament_players p WHERE p.tournament_id=p_tournament
$body$;
REVOKE ALL ON FUNCTION smarter_private.breakfast_roster(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Called after the unchanged cash owner derives/promotes its sole survivor.
-- It authenticates the original 32 standings without fabricating old sequence
-- values or reordering them by later retry timestamps.
CREATE FUNCTION smarter_private.breakfast_standings_witness(p_tournament uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE r smarter_private.breakfast_original_witness%ROWTYPE; actual jsonb; original jsonb; target jsonb;
BEGIN
 SELECT * INTO r FROM smarter_private.breakfast_original_witness WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_tournament<>'f370585d-40ea-4085-bb8f-c7e8c74f3fb4'
 OR p_winner<>'ae0bc48d-f98c-4b25-a9fa-e3522f986173'
 OR r.expected_hash IS DISTINCT FROM md5(r.expected::text) THEN
  RAISE EXCEPTION 'BREAKFAST_WITNESS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original FROM jsonb_array_elements(r.expected->'roster') v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO actual FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT v INTO target FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id'='9ee591b7-2360-4ea8-ad3b-942ef829fbda';
 IF jsonb_array_length(original)<>32 OR actual IS DISTINCT FROM original
 OR target IS DISTINCT FROM r.target_postimage
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament
  AND user_id=p_winner AND status='winner' AND position=1 AND chips=430255)
 OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id=p_tournament)<>34
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament AND (position IS NULL OR position<1 OR position>34)) THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_STANDINGS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('operation_id',r.operation_id,'expected_hash',r.expected_hash,
  'archive_sha256',r.original_archive_sha256,'original_line',r.original_line,
  'original_place',r.original_place,'original_prize',r.original_prize,
  'original_outcome','failed_request','admitted_at',r.admitted_at);
END $body$;
REVOKE ALL ON FUNCTION smarter_private.breakfast_standings_witness(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_complete_breakfast_original_witness(p_operation_id uuid,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private
SET statement_timeout='30s' SET lock_timeout='3s' AS $body$
DECLARE
 t constant uuid:='f370585d-40ea-4085-bb8f-c7e8c74f3fb4';
 u constant uuid:='9ee591b7-2360-4ea8-ad3b-942ef829fbda';
 survivor constant uuid:='ae0bc48d-f98c-4b25-a9fa-e3522f986173';
 v_original jsonb; v_current jsonb; v_token uuid; v_result jsonb; v_reprice jsonb;
 v_receipt smarter_private.breakfast_original_witness%ROWTYPE;
 v_t public.tournaments%ROWTYPE; v_entry public.tournament_entry_close_receipts%ROWTYPE;
 v_structure jsonb; v_target jsonb; v_old_seats jsonb; v_old_snapshots jsonb;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true THEN RAISE EXCEPTION 'service authority required' USING ERRCODE='28000'; END IF;
 IF p_operation_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'BREAKFAST_REQUEST_REQUIRED' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_for_finish(t);
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT * INTO v_t FROM public.tournaments WHERE id=t FOR UPDATE;
 SELECT * INTO v_receipt FROM smarter_private.breakfast_original_witness WHERE tournament_id=t;
 IF FOUND THEN
  IF v_receipt.operation_id IS DISTINCT FROM p_operation_id OR v_receipt.expected IS DISTINCT FROM p_expected THEN
   RAISE EXCEPTION 'BREAKFAST_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  v_result:=public.fn_ca_tournament_terminal_receipt(t,survivor);
  IF (SELECT cash_receipt->'original_witness' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
    IS DISTINCT FROM smarter_private.breakfast_standings_witness(t,survivor) THEN
   RAISE EXCEPTION 'BREAKFAST_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN v_result;
 END IF;
 IF v_t.id IS NULL OR v_t.status<>'RUNNING' OR v_t.club_id<>'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
 OR v_t.prize_pool IS DISTINCT FROM 153::numeric OR v_t.total_rake IS DISTINCT FROM 17::numeric
 OR v_t.bounty_pool IS DISTINCT FROM 0::numeric OR v_t.current_players<>2
 OR v_t.prize_pool_finalized IS DISTINCT FROM true OR v_t.entry_contract_locked IS DISTINCT FROM true
 OR coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false) OR coalesce(v_t.is_mystery_bounty,false)
 OR coalesce(v_t.bubble_protection,false) OR v_t.tournament_type IS DISTINCT FROM 'MTT'
 OR v_t.starting_chips IS DISTINCT FROM 12000 OR v_t.satellite_target_id IS NOT NULL THEN
  RAISE EXCEPTION 'BREAKFAST_EVENT_CHANGED' USING ERRCODE='40001'; END IF;
 -- The old snapshot manager is still present. Lock its actual current identity;
 -- expiry/heartbeat are liveness fields, never absence or historical authority.
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(l)-ARRAY['heartbeat_at','acquired_at'] ORDER BY lease_generation),'[]') INTO v_current
 FROM public.engine_tournament_leases l WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM p_expected->'manager' THEN RAISE EXCEPTION 'BREAKFAST_MANAGER_CHANGED' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tournament_obligations WHERE tournament_id=t ORDER BY kind,place,id FOR UPDATE;
 PERFORM 1 FROM public.tournament_payouts WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 SELECT * INTO v_entry FROM public.tournament_entry_close_receipts WHERE tournament_id=t FOR UPDATE;
 v_original:=smarter_private.breakfast_retained_case();
 IF smarter_private.breakfast_roster(t) IS DISTINCT FROM v_original->'roster'
 OR p_expected->'roster' IS DISTINCT FROM v_original->'roster'
 OR to_jsonb(v_entry) IS DISTINCT FROM v_original->'entry'
 OR to_jsonb(v_entry) IS DISTINCT FROM p_expected->'entry'
 OR public.fn_safe_jsonb_array(v_t.payout_structure::text) IS DISTINCT FROM v_entry.payout_structure_snapshot
 OR v_entry.reprice_completed_at IS NOT NULL THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO v_current FROM public.tournament_payouts p WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'payouts' THEN RAISE EXCEPTION 'BREAKFAST_PAID_EVIDENCE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]') INTO v_current FROM public.tournament_obligations o WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'obligations' THEN RAISE EXCEPTION 'BREAKFAST_OBLIGATIONS_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY key),'[]') INTO v_current FROM public.wallet_credit_idempotency k WHERE key LIKE 'tourney:'||t||':%';
 IF v_current IS DISTINCT FROM v_original->'wallet_keys' THEN RAISE EXCEPTION 'BREAKFAST_CREDIT_EVIDENCE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_current FROM public.rake_records r WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'fee_charges' THEN RAISE EXCEPTION 'BREAKFAST_FEE_CHARGE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO v_old_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t;
 IF v_old_seats IS DISTINCT FROM v_original->'seats' OR v_old_seats IS DISTINCT FROM p_expected->'seats'
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t)<>4
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t AND status='running')<>1
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id='dd835bad-d3c8-4984-ab2f-5ed52d1fb664' AND tournament_id=t AND status='running' AND f06_lifecycle=9657) THEN
  RAISE EXCEPTION 'BREAKFAST_PHYSICAL_ROSTER_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO v_old_snapshots FROM public.hand_state_snapshots s
 WHERE NOT is_complete AND table_id IN(SELECT id FROM public.tables WHERE tournament_id=t);
 -- Three unchanged Sept8 snapshots belong to CLOSED tables. They remain
 -- unfinished historical evidence. This operation never completes/clears them.
 IF v_old_snapshots IS DISTINCT FROM v_original->'historical_snapshots'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=t AND NOT s.is_complete AND tb.status<>'closed')
 OR EXISTS(SELECT 1 FROM public.engine_table_leases l JOIN public.tables tb ON tb.id=l.table_id WHERE tb.tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a JOIN public.tables tb ON tb.id=a.table_id WHERE tb.tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=t) THEN
  RAISE EXCEPTION 'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=t
  AND e.gross_in=170 AND e.fee_entries_in=17 AND e.prize_out=99.88
  AND e.prize_balance=53.12 AND e.fee_balance=17 AND e.bounty_balance=0
  AND e.refund_prize=0 AND e.refund_fee=0 AND e.refund_bounty=0
  AND e.fee_out=0 AND e.bounty_out=0 AND e.reserve_in=0 AND e.reserve_out=0
  AND e.overlay_in=0 AND e.satellite_in=0 AND e.satellite_fee_in=0
  AND e.closed_at IS NULL) THEN
  RAISE EXCEPTION 'BREAKFAST_FUNDING_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT public.fn_safe_jsonb_array((p.payout_structure->>'payout_structure')) INTO v_structure FROM public.tournament_payouts p WHERE tournament_id=t ORDER BY id LIMIT 1;
 IF v_structure IS DISTINCT FROM v_original->'original_structure'
 OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE tournament_id=t AND public.fn_safe_jsonb_array(p.payout_structure->>'payout_structure') IS DISTINCT FROM v_structure) THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_PAID_CONTRACT_CONFLICT' USING ERRCODE='P0404'; END IF;
 v_token:=public.fn_ca_open_tournament_seat_exit_authority(t,'elimination',u);
 UPDATE public.table_seats SET left_at=clock_timestamp(),status='left',active_game_scope=NULL,active_parent_key=NULL,
  leave_pending=false,is_sitting_out=false,is_away=false
 WHERE id='41cef73d-6c47-4241-a2da-9ed9572059ad' AND user_id=u AND left_at IS NULL AND stack=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'BREAKFAST_ZERO_SEAT_EXIT_LOST' USING ERRCODE='40001'; END IF;
 UPDATE public.tournament_players SET status='eliminated',position=21,prize=0,eliminated_at=clock_timestamp(),table_id=NULL,seat_number=NULL
 WHERE id='e49fdaa8-3f02-44e3-9f40-59cfbb18f1b9' AND user_id=u AND status='playing' AND chips=0 AND position IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_RANK_LOST' USING ERRCODE='40001'; END IF;
 PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,true);
 SELECT v INTO v_target FROM jsonb_array_elements(smarter_private.breakfast_roster(t)) v WHERE v->>'user_id'=u::text;
 INSERT INTO smarter_private.breakfast_original_witness(tournament_id,operation_id,expected,expected_hash,
 original_archive_sha256,original_line,original_observed_at,original_error,original_place,original_prize,target_postimage)
 VALUES(t,p_operation_id,p_expected,md5(p_expected::text),
 'bec825a59f7ced2063d2ddc7c5d1859c30bbd1412178fc6535e25700d525366f',164263,
 '2026-09-08T14:28:11.325815271Z','TOURNAMENT_SEAT_ROSTER_REQUIRED',21,0,v_target);
 UPDATE public.tournaments SET payout_structure=v_structure::text,current_players=1 WHERE id=t;
 UPDATE public.tournament_entry_close_receipts SET payout_structure_snapshot=v_structure,updated_at=clock_timestamp() WHERE tournament_id=t;
 v_reprice:=public.fn_complete_tournament_entry_reprice(t);
 IF (v_reprice->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'BREAKFAST_REPRICE_REFUSED: %',v_reprice USING ERRCODE='P0404'; END IF;
 -- This unchanged authority derives its sole survivor, pays only the remaining
 -- 53.12, and preserves unresolved original fees through its explicit v3
 -- custody contract. Failure rolls back the new rank, contract, witness and
 -- every attempted payment together.
 v_result:=public.fn_complete_tournament_terminal(t,survivor,'places');
 IF (SELECT cash_receipt->'original_witness' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
  IS DISTINCT FROM smarter_private.breakfast_standings_witness(t,survivor) THEN
  RAISE EXCEPTION 'BREAKFAST_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
 IF (v_result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'BREAKFAST_TERMINAL_REFUSED: %',v_result USING ERRCODE='P0404'; END IF;
 IF (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM public.hand_state_snapshots s WHERE NOT is_complete AND table_id IN(SELECT id FROM public.tables WHERE tournament_id=t)) IS DISTINCT FROM v_old_snapshots THEN
  RAISE EXCEPTION 'BREAKFAST_HISTORICAL_SNAPSHOT_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN v_result;
END $body$;
REVOKE ALL ON FUNCTION public.fn_complete_breakfast_original_witness(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_breakfast_original_witness(uuid,jsonb) TO service_role;
