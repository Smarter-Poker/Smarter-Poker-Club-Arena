-- A hand-content policy cannot subtract previously recorded player statistics,
-- rake fees or net totals. Keep all fact rows and derived fields. Erase only
-- hole_cards, using the durable original horse/success certificate captured
-- before original request erasure, independently of adaptive model activation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $pins$
BEGIN
 IF to_regclass('smarter_private.horse_fact_card_disposals') IS NOT NULL THEN
  RAISE EXCEPTION 'HORSE_FACT_CARD_RETENTION_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure)) IS DISTINCT FROM '759f77b0f2db91ee882d4520419618db'
 OR md5(pg_get_functiondef('smarter_private.hand_submission_immutable()'::regprocedure)) IS DISTINCT FROM 'b1bac3bfa723379011a73864275f7bde'
 OR md5(pg_get_functiondef('public.fn_cash_provenance_immutable()'::regprocedure)) IS DISTINCT FROM '5ac67ae7565d639be7372d51b0e24fee'
 OR md5(pg_get_functiondef('smarter_private.compact_horse_cash_play_contents(uuid[])'::regprocedure)) IS DISTINCT FROM '243d9ef305ff1e8c689ed564faffa7f1'
 OR md5(pg_get_functiondef('smarter_private.compact_settled_horse_requests(uuid[])'::regprocedure)) IS DISTINCT FROM 'd60f97e0c67d9a8a17584dfcc0b9bdd1'
 OR md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_matches(uuid,uuid,bigint,text)'::regprocedure)) IS DISTINCT FROM 'b512986eabb51dc559d4bc2d138b2a39'
 OR md5(pg_get_functiondef('public.fn_club_member_daily_facts_update()'::regprocedure)) IS DISTINCT FROM '20587bfe49aecb48cb05845b5ea30246'
 OR md5(pg_get_functiondef('public.fn_club_member_play_totals_update()'::regprocedure)) IS DISTINCT FROM '8ef370c5fa7a7f2ad9517934f3e2d889'
 OR md5(pg_get_functiondef('public.fn_club_roster_hand_totals_update()'::regprocedure)) IS DISTINCT FROM '0204331d58f0e2a0c51002a3b9797a21' THEN
  RAISE EXCEPTION 'HORSE_FACT_CARD_RETENTION_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_prune_ca_hand_facts(integer)'::regprocedure
 AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']) THEN
  RAISE EXCEPTION 'HORSE_FACT_CARD_RETENTION_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $pins$;
CREATE TABLE smarter_private.horse_fact_card_disposals (
 hand_id uuid PRIMARY KEY,
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 fact_rows integer NOT NULL CHECK(fact_rows>=0),
 disposed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.horse_fact_card_disposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.horse_fact_card_disposals FROM PUBLIC,anon,authenticated,service_role;

-- Accepted derived statistics remain an indefinite reconciliation basis even
-- when an earlier retention pass already removed projected rows. No restoration
-- of player counters or monetary balances is attempted by this transition.
CREATE TABLE smarter_private.horse_retained_stats_basis (
 hand_id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 request_hash text NOT NULL, original_stats_sha256 text NOT NULL,
 compact_stats jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.horse_retained_stats_basis ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.horse_retained_stats_basis FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_compact_stats_basis(p_stats jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE facts jsonb;
BEGIN
 IF p_stats IS NULL THEN RETURN 'null'::jsonb; END IF;
 IF COALESCE(p_stats->>'version','') NOT IN('1','2') OR jsonb_typeof(p_stats->'facts') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_stats->'transfers') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p_stats->'facts') NOT BETWEEN 1 AND 10 OR jsonb_array_length(p_stats->'transfers') NOT BETWEEN 0 AND 90
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_stats) k WHERE k NOT IN('version','facts','transfers'))
 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_INVALID_SHAPE' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_stats->'facts') f WHERE jsonb_typeof(f) IS DISTINCT FROM 'object')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_stats->'transfers') t WHERE jsonb_typeof(t) IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'HORSE_STATS_BASIS_INVALID_ROW' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_stats->'facts') f CROSS JOIN LATERAL jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['hand_id','user_id','club_id','table_id','tournament_id','played_at','game_variant','big_blind','seat','position','players_dealt','hole_cards','hand_class','invested','returned','net','net_bb','rake_paid','vpip','pfr','three_bet','faced_three_bet','folded_to_three_bet','had_cbet_flop_opp','cbet_flop','saw_flop','went_to_showdown','won_at_showdown','aggressive_actions','passive_actions','was_all_in','all_in_street','all_in_at_risk','all_in_equity','ev_returned','ev_net','ev_net_bb','created_at','opponent_ids','four_bet','all_in_equity_owed','source_hash','effective_stack_bb_at_deal','hero_in_position','aggressive_actions_preflop','passive_actions_preflop','aggressive_actions_flop','passive_actions_flop','aggressive_actions_turn','passive_actions_turn','aggressive_actions_river','passive_actions_river','three_bet_opportunity','four_bet_opportunity','steal_opportunity','stole','squeeze_opportunity','squeezed','blind_defense_opportunity','defended_blind','cbet_flop_opportunity','barrel_turn_opportunity','barreled_turn','barrel_river_opportunity','barreled_river','check_raise_opportunity','check_raised','donk_opportunity','donk_bet','probe_opportunity','probe_bet']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_stats->'transfers') t CROSS JOIN LATERAL jsonb_object_keys(t) k WHERE k NOT IN('hand_id','winner_id','loser_id','amount','played_at','club_id','table_id'))
 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_UNKNOWN_FIELD' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(f-'hole_cards' ORDER BY ord) INTO facts FROM jsonb_array_elements(p_stats->'facts') WITH ORDINALITY x(f,ord);
 RETURN jsonb_set(p_stats,'{facts}',facts);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_compact_stats_basis(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_stats_basis_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE s smarter_private.hand_submissions; original jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_IMMUTABLE' USING ERRCODE='55000'; END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.hand_id;
 original:=s.request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}';
 IF NOT FOUND OR NOT smarter_private.horse_request_payload_disposable(NEW.hand_id)
 OR (NEW.table_id,NEW.hand_number,NEW.request_hash) IS DISTINCT FROM (s.table_id,s.hand_number,s.request_hash)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=NEW.hand_id
  AND (a.table_id IS DISTINCT FROM NEW.table_id OR a.hand_number IS DISTINCT FROM NEW.hand_number
   OR COALESCE(a.post_commit_payload#>'{accepted_hand_facts,stats_facts}','null'::jsonb) IS DISTINCT FROM COALESCE(original,'null'::jsonb)))
 OR NEW.original_stats_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(COALESCE(original,'null'::jsonb)::text,'UTF8'),'sha256'),'hex')
 OR (original IS NOT NULL AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements(original->'facts') f WHERE f->>'hand_id' IS DISTINCT FROM NEW.hand_id::text OR f->>'table_id' IS DISTINCT FROM NEW.table_id::text
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request#>'{p_hand_row,players}') player WHERE player->>'userId'=f->>'user_id'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(original->'transfers') t WHERE t->>'hand_id' IS DISTINCT FROM NEW.hand_id::text OR t->>'table_id' IS DISTINCT FROM NEW.table_id::text)))
 OR NEW.compact_stats IS DISTINCT FROM smarter_private.horse_compact_stats_basis(original)
 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_ORIGINAL_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_stats_basis_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_stats_basis_immutable BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.horse_retained_stats_basis
 FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_stats_basis_immutable();
CREATE TRIGGER horse_stats_basis_no_truncate BEFORE TRUNCATE ON smarter_private.horse_retained_stats_basis
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_stats_basis_immutable();
CREATE FUNCTION smarter_private.capture_horse_stats_basis(p_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE n integer;
BEGIN
 IF cardinality(p_ids)>10000 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_BATCH_TOO_LARGE' USING ERRCODE='22023'; END IF;
 INSERT INTO smarter_private.horse_retained_stats_basis(hand_id,table_id,hand_number,request_hash,original_stats_sha256,compact_stats)
 SELECT s.submission_id,s.table_id,s.hand_number,s.request_hash,
 encode(extensions.digest(convert_to(COALESCE(s.request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb)::text,'UTF8'),'sha256'),'hex'),
 smarter_private.horse_compact_stats_basis(s.request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}')
 FROM smarter_private.hand_submissions s WHERE s.submission_id=ANY(p_ids)
 AND smarter_private.horse_request_payload_disposable(s.submission_id)
 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=s.submission_id);
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.capture_horse_stats_basis(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.horse_stats_basis_matches(p_hand uuid,p_table uuid,p_number bigint,p_stats jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
 SELECT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b
  WHERE (b.hand_id,b.table_id,b.hand_number) IS NOT DISTINCT FROM (p_hand,p_table,p_number)
  AND b.original_stats_sha256=encode(extensions.digest(convert_to(COALESCE(p_stats,'null'::jsonb)::text,'UTF8'),'sha256'),'hex')
  AND b.compact_stats IS NOT DISTINCT FROM smarter_private.horse_compact_stats_basis(p_stats))
$function$;
REVOKE ALL ON FUNCTION smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- The row owners require preservation even when a future caller bypasses the
-- compaction helper. Keep every other immutable-row restriction intact.
DO $row_owner_basis_guard$
DECLARE src text; anchor text;
BEGIN
 src:=pg_get_functiondef('smarter_private.hand_submission_immutable()'::regprocedure);
 anchor:='AND smarter_private.horse_request_payload_disposable(OLD.submission_id) THEN RETURN NEW;';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_RAW_OWNER_CHANGED'; END IF;
 EXECUTE replace(src,anchor,'AND smarter_private.horse_request_payload_disposable(OLD.submission_id)
  AND smarter_private.horse_adaptive_disposal_certificate_matches(OLD.submission_id,OLD.table_id,OLD.hand_number,OLD.request_hash)
  AND smarter_private.horse_stats_basis_matches(OLD.submission_id,OLD.table_id,OLD.hand_number,OLD.request#>''{p_hand_row,_accepted_post_commit_facts,stats_facts}'')
  AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=OLD.submission_id AND b.request_hash=OLD.request_hash) THEN RETURN NEW;');
 src:=pg_get_functiondef('public.fn_cash_provenance_immutable()'::regprocedure);
 anchor:='AND NEW.accepted_request IS NOT DISTINCT FROM smarter_private.horse_cash_compact_request(OLD.accepted_request)';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_CASH_OWNER_CHANGED'; END IF;
 EXECUTE replace(src,anchor,'AND smarter_private.horse_stats_basis_matches(OLD.hand_id,OLD.table_id,OLD.hand_number,OLD.accepted_request#>''{hand_row,_accepted_post_commit_facts,stats_facts}'')
  AND COALESCE(OLD.atomic_receipt#>''{post_commit_payload,accepted_hand_facts,stats_facts}'',''null''::jsonb) IS NOT DISTINCT FROM COALESCE(OLD.accepted_request#>''{hand_row,_accepted_post_commit_facts,stats_facts}'',''null''::jsonb)
  '||anchor);
END $row_owner_basis_guard$;

CREATE FUNCTION smarter_private.horse_fact_cards_disposable(p_hand uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE c smarter_private.horse_adaptive_disposal_certificates; tour uuid;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=p_hand;
 IF NOT FOUND OR NOT smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash)
 OR (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=p_hand AND (h.has_human IS DISTINCT FROM false OR h.reported IS true))
 OR smarter_private.f06_hand_cards_unresolved(c.table_id,c.hand_number)
 OR smarter_private.f06_movement_boundary_retained(c.table_id,c.hand_number)
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=c.table_id AND b.hand_number=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=p_hand)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=p_hand AND k.state='pending')
 OR NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=p_hand
  AND (b.table_id,b.hand_number,b.request_hash) IS NOT DISTINCT FROM (c.table_id,c.hand_number,c.request_hash))
 OR EXISTS(SELECT 1 FROM public.ca_hand_facts f WHERE f.hand_id=p_hand AND NOT EXISTS(
  SELECT 1 FROM smarter_private.horse_retained_stats_basis b CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.compact_stats->'facts')='array' THEN b.compact_stats->'facts' ELSE '[]'::jsonb END) original
  WHERE b.hand_id=p_hand AND original->>'user_id'=f.user_id::text))
 OR EXISTS(SELECT 1 FROM public.ca_hand_facts f WHERE f.hand_id=p_hand
  AND (f.table_id IS DISTINCT FROM c.table_id OR NOT isfinite(f.played_at) OR f.played_at>=statement_timestamp()-interval '8 days'))
 THEN RETURN false; END IF;
 SELECT p.tournament_id INTO tour FROM smarter_private.f06_hand_permits p
 WHERE p.table_id=c.table_id AND p.hand_number=c.hand_number;
 IF tour IS NULL THEN SELECT t.tournament_id INTO tour FROM public.tables t WHERE t.id=c.table_id; END IF;
 IF tour IS NOT NULL AND (
  NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=tour
   AND upper(COALESCE(t.status::text,'')) IN('COMPLETED','CANCELLED','CANCELED')
   AND COALESCE(t.bounty_pool,0)<=COALESCE(t.bounty_pool_paid,0))
  OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=tour AND e.closed_at IS NULL)) THEN RETURN false; END IF;
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_fact_cards_disposable(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.horse_fact_card_disposal_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE c smarter_private.horse_adaptive_disposal_certificates;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HORSE_FACT_CARD_DISPOSAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=NEW.hand_id;
 IF NOT smarter_private.horse_fact_cards_disposable(NEW.hand_id)
 OR (NEW.table_id,NEW.hand_number,NEW.request_hash) IS DISTINCT FROM (c.table_id,c.hand_number,c.request_hash)
 OR NEW.fact_rows<>(SELECT count(*) FROM public.ca_hand_facts f WHERE f.hand_id=NEW.hand_id)
 THEN RAISE EXCEPTION 'HORSE_FACT_CARD_DISPOSAL_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_fact_card_disposal_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_fact_card_disposal_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON smarter_private.horse_fact_card_disposals FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_fact_card_disposal_immutable();
CREATE TRIGGER horse_fact_card_disposal_no_truncate BEFORE TRUNCATE
 ON smarter_private.horse_fact_card_disposals FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_fact_card_disposal_immutable();

CREATE FUNCTION smarter_private.horse_fact_retired_cards_stay_erased() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
BEGIN
 -- Serialize only this hand's admission with its one-time content transition.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('horse:fact-card-retention:'||NEW.hand_id::text,0));
 IF EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals d
  JOIN smarter_private.horse_retained_stats_basis b ON b.hand_id=d.hand_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.compact_stats->'facts')='array'
   THEN b.compact_stats->'facts' ELSE '[]'::jsonb END) original
  WHERE d.hand_id=NEW.hand_id AND original->>'user_id'=NEW.user_id::text)
 THEN NEW.hole_cards:=NULL; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_fact_retired_cards_stay_erased() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_horse_fact_retired_cards_stay_erased BEFORE INSERT OR UPDATE ON public.ca_hand_facts
 FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_fact_retired_cards_stay_erased();

CREATE FUNCTION smarter_private.compact_horse_fact_cards(p_hand_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE id uuid; c smarter_private.horse_adaptive_disposal_certificates; n integer; total integer:=0;
BEGIN
 IF cardinality(p_hand_ids)>10000 THEN RAISE EXCEPTION 'HORSE_FACT_CARD_BATCH_TOO_LARGE' USING ERRCODE='22023'; END IF;
 FOR id IN SELECT DISTINCT unnest(p_hand_ids) LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse:fact-card-retention:'||id::text,0)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals WHERE hand_id=id)
   OR NOT smarter_private.horse_fact_cards_disposable(id) THEN CONTINUE; END IF;
  SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=id;
  INSERT INTO smarter_private.horse_fact_card_disposals(hand_id,table_id,hand_number,request_hash,fact_rows)
   SELECT c.hand_id,c.table_id,c.hand_number,c.request_hash,count(*) FROM public.ca_hand_facts f WHERE f.hand_id=id
   ON CONFLICT(hand_id) DO NOTHING;
  UPDATE public.ca_hand_facts f SET hole_cards=NULL WHERE f.hand_id=id AND f.hole_cards IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 END LOOP;
 RETURN total;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.compact_horse_fact_cards(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve function identity, owner, ACL and response's deleted/cutoff/days/more
-- keys. 'deleted' is truthfully zero: no financial or statistic row is removed.
CREATE OR REPLACE FUNCTION public.fn_prune_ca_hand_facts(p_limit integer DEFAULT 200000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE ids uuid[]; n integer; lim integer:=LEAST(GREATEST(COALESCE(p_limit,250),1),250); days integer;
BEGIN
 SELECT horse_retention_days INTO days FROM public.hand_history_retention_policy LIMIT 1;
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('deleted',0,'compacted',0,'more',false,'retention_days',days,'status','frozen'); END IF;
 SELECT array_agg(q.hand_id ORDER BY q.qualified_at,q.hand_id) INTO ids FROM (
  SELECT c.hand_id,c.qualified_at FROM smarter_private.horse_adaptive_disposal_certificates c
  WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals f WHERE f.hand_id=c.hand_id)
  ORDER BY c.qualified_at,c.hand_id LIMIT lim) q;
 n:=smarter_private.compact_horse_fact_cards(ids);
 RETURN jsonb_build_object('deleted',0,'compacted',n,'cutoff',now()-make_interval(days=>COALESCE(days,8)),
  'retention_days',days,'more',COALESCE(cardinality(ids),0)>=lim);
END $function$;
DO $cash_basis_guard$
DECLARE src text; anchor text:=E'  request_after:=smarter_private.horse_cash_compact_request(p.accepted_request);';
BEGIN
 src:=pg_get_functiondef('smarter_private.compact_horse_cash_play_contents(uuid[])'::regprocedure);
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'HORSE_STATS_BASIS_CASH_HOOK_CHANGED'; END IF;
 EXECUTE replace(src,anchor,E'  -- An erased raw request must leave the exact accepted derived basis.
  IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b
   WHERE b.hand_id=p.hand_id AND b.table_id=p.table_id AND b.hand_number=p.hand_number
   AND b.original_stats_sha256=encode(extensions.digest(convert_to(COALESCE(p.accepted_request#>''{hand_row,_accepted_post_commit_facts,stats_facts}'',''null''::jsonb)::text,''UTF8''),''sha256''),''hex'')
   AND b.compact_stats IS NOT DISTINCT FROM smarter_private.horse_compact_stats_basis(p.accepted_request#>''{hand_row,_accepted_post_commit_facts,stats_facts}'')
   AND COALESCE(p.atomic_receipt#>''{post_commit_payload,accepted_hand_facts,stats_facts}'',''null''::jsonb) IS NOT DISTINCT FROM COALESCE(p.accepted_request#>''{hand_row,_accepted_post_commit_facts,stats_facts}'',''null''::jsonb)) THEN CONTINUE; END IF;
'||anchor);
END $cash_basis_guard$;
DO $hook$
DECLARE src text; anchor text:=E' PERFORM smarter_private.capture_horse_adaptive_disposals(p_submission_ids);\n';
BEGIN
 src:=pg_get_functiondef('smarter_private.compact_settled_horse_requests(uuid[])'::regprocedure);
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'HORSE_FACT_CARD_CAPTURE_HOOK_CHANGED'; END IF;
 EXECUTE replace(src,anchor,anchor||E' PERFORM smarter_private.capture_horse_stats_basis(p_submission_ids);\n PERFORM smarter_private.compact_horse_fact_cards(p_submission_ids);\n');
END $hook$;
DO $owners$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'smarter_private.horse_compact_stats_basis(jsonb)',
  'smarter_private.horse_stats_basis_immutable()',
  'smarter_private.capture_horse_stats_basis(uuid[])',
  'smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)',
  'smarter_private.horse_fact_cards_disposable(uuid)',
  'smarter_private.horse_fact_card_disposal_immutable()',
  'smarter_private.horse_fact_retired_cards_stay_erased()',
  'smarter_private.compact_horse_fact_cards(uuid[])'] LOOP
  EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO postgres';
 END LOOP;
 ALTER TABLE smarter_private.horse_fact_card_disposals OWNER TO postgres;
 ALTER TABLE smarter_private.horse_retained_stats_basis OWNER TO postgres;
END $owners$;
COMMIT;
