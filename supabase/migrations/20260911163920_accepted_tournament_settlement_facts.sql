-- Version 20260911163920 reserved by scripts/new-migration.mjs.
-- Shared private qualification of an accepted tournament hand. JSON validation
-- is NOT financial authority: a caller must load the exact persisted receipt,
-- bind its event and beneficiary, and exclude later play or entry purchases.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.fn_ca_accepted_tournament_settlement_fact(p_receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC'
AS $accepted_tournament_settlement_fact$
DECLARE
 r jsonb; request jsonb; q jsonb; user_key text; user_id uuid;
 table_id uuid; hand_id uuid; hand_number bigint; completed_at timestamptz;
 before_stack numeric; after_stack numeric; written_stack numeric;
 before_total numeric:=0; after_total numeric:=0;
 users uuid[]:='{}'; facts jsonb:='[]'; user_count integer;
BEGIN
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
    OR p_receipt->>'status' IS DISTINCT FROM 'succeeded'
    OR COALESCE(p_receipt->'error','null'::jsonb)<>'null'::jsonb
    OR jsonb_typeof(p_receipt->'result') IS DISTINCT FROM 'object'
 THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','receipt_not_succeeded'); END IF;
 r:=p_receipt->'result';request:=r->'request';
 IF r->'success' IS DISTINCT FROM 'true'::jsonb
    OR r->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(request) IS DISTINCT FROM 'object'
    OR jsonb_typeof(request->'stacks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(r->'written') IS DISTINCT FROM 'object'
 THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_result_shape_invalid'); END IF;
 IF COALESCE(p_receipt->>'completed_at','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_identity_invalid');
 END IF;
 table_id:=(p_receipt->>'table_id')::uuid;hand_id:=(p_receipt->>'hand_id')::uuid;
 completed_at:=(p_receipt->>'completed_at')::timestamptz;
 IF table_id IS NULL OR hand_id IS NULL OR completed_at IS NULL OR NOT isfinite(completed_at)
    OR (r->>'table_id')::uuid IS DISTINCT FROM table_id
    OR (r->>'hand_id')::uuid IS DISTINCT FROM hand_id
    OR jsonb_typeof(r->'hand_number') IS DISTINCT FROM 'number'
    OR COALESCE(r->>'hand_number','')!~'^[1-9][0-9]*$'
 THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_identity_invalid'); END IF;
 hand_number:=(r->>'hand_number')::bigint;
 user_count:=jsonb_array_length(request->'stacks');
 IF user_count<2 OR user_count>10 OR jsonb_typeof(r->'players') IS DISTINCT FROM 'number'
    OR (r->>'players')::integer IS DISTINCT FROM user_count
    OR (SELECT count(*) FROM jsonb_object_keys(r->'written'))<>user_count
 THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_roster_not_one_to_one'); END IF;
 -- A tournament hand transfers only tournament chips between the named seats.
 -- No cash-hand rake, BBJ or outside inflow may justify its conservation.
 FOREACH user_key IN ARRAY ARRAY['rake','bbj','inflow'] LOOP
   IF jsonb_typeof(request->user_key) IS DISTINCT FROM 'number'
      OR jsonb_typeof(r->user_key) IS DISTINCT FROM 'number'
      OR (request->>user_key)::numeric IS DISTINCT FROM 0
      OR (r->>user_key)::numeric IS DISTINCT FROM 0 THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','non_tournament_money_component');
   END IF;
 END LOOP;
 IF jsonb_typeof(r->'net_deltas') IS DISTINCT FROM 'number'
    OR (r->>'net_deltas')::numeric IS DISTINCT FROM 0 THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_net_delta_nonzero');
 END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(request->'stacks') LOOP
   IF jsonb_typeof(q) IS DISTINCT FROM 'object'
      OR jsonb_typeof(q->'stack_before') IS DISTINCT FROM 'number'
      OR jsonb_typeof(q->'stack') IS DISTINCT FROM 'number' THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_stack_shape_invalid');
   END IF;
   user_id:=(q->>'user_id')::uuid;
   IF user_id IS NULL OR user_id=ANY(users) OR q->>'user_id' IS DISTINCT FROM user_id::text
      OR jsonb_typeof(r->'written'->user_id::text) IS DISTINCT FROM 'number' THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_roster_not_one_to_one');
   END IF;
   users:=array_append(users,user_id);
   before_stack:=(q->>'stack_before')::numeric;after_stack:=(q->>'stack')::numeric;
   written_stack:=(r->'written'->>user_id::text)::numeric;
   IF before_stack<0 OR after_stack<0 OR written_stack<0
      OR before_stack::text IN ('NaN','Infinity','-Infinity')
      OR after_stack::text IN ('NaN','Infinity','-Infinity')
      OR written_stack::text IN ('NaN','Infinity','-Infinity')
      OR written_stack IS DISTINCT FROM after_stack THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_written_stack_invalid');
   END IF;
   before_total:=before_total+before_stack;after_total:=after_total+after_stack;
   facts:=facts||jsonb_build_array(jsonb_build_object('user_id',user_id,'stack_before',before_stack,'stack',after_stack));
 END LOOP;
 IF before_total<=0 OR before_total IS DISTINCT FROM after_total THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_stacks_not_conserved');
 END IF;
 SELECT jsonb_agg(value ORDER BY value->>'user_id') INTO facts FROM jsonb_array_elements(facts);
 RETURN jsonb_build_object('version',1,'ok',true,'reason',NULL,
   'source_key',jsonb_build_object('table_id',table_id,'hand_id',hand_id),
   'table_id',table_id,'hand_id',hand_id,'hand_number',hand_number,'completed_at',completed_at,
   'player_count',user_count,'chip_total',before_total,'facts',facts,
   'source_sha256',encode(extensions.digest(convert_to(p_receipt::text,'UTF8'),'sha256'),'hex'));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
 RETURN jsonb_build_object('version',1,'ok',false,'reason','accepted_value_invalid');
END;
$accepted_tournament_settlement_fact$;
ALTER FUNCTION public.fn_ca_accepted_tournament_settlement_fact(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_accepted_tournament_settlement_fact(jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_accepted_tournament_settlement_fact(jsonb) IS
 'Private pure JSON qualification only, never payment authority. Callers must load the exact persisted settlement row and bind event, table, hand, beneficiary, later play, post-zero entry and source hash.';
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_tournament_finish_witness(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC'
AS $legacy_tournament_finish_witness$
DECLARE
 t public.tournaments%ROWTYPE; player record; source record;
 user_ids uuid[]; player_count integer; receipt_count integer;
 qualified jsonb; accepted jsonb:='[]'; observations jsonb; last_fact jsonb;
 last_zero jsonb; first_zero_at timestamptz; losers jsonb:='[]'; standings jsonb; winner jsonb;
 basis jsonb; paid boolean; zero_count integer; survivor_count integer:=0;
BEGIN
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','tournament_not_found','tournament_id',p_tournament_id); END IF;
 IF t.status IS NULL OR t.status NOT IN ('REGISTERING','RUNNING','COMPLETING')
    OR t.prize_pool_finalized IS NOT TRUE OR t.is_bounty IS TRUE OR t.is_pko IS TRUE
    OR t.is_mystery_bounty IS TRUE THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_event_not_eligible','tournament_id',p_tournament_id);
 END IF;
 IF (t.tournament_type='SATELLITE') IS DISTINCT FROM (t.satellite_target_id IS NOT NULL) THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','satellite_target_mode_inconsistent','tournament_id',t.id);
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key LIKE 'tourney:'||t.id::text||':%')
     OR EXISTS(SELECT 1 FROM public.wallet_transactions WHERE related_entity_id=t.id AND category IN ('prize','refund') AND amount<>0)
     OR EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=t.id
        AND (prize_out<>0 OR refund_prize<>0 OR refund_fee<>0 OR refund_bounty<>0))
     INTO paid;
 IF paid THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','paid_history_requires_its_own_authority','tournament_id',t.id); END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id=t.id)
    OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.tables tb ON tb.id=c.table_id WHERE tb.tournament_id=t.id)
    OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t.id AND elimination_sequence IS NOT NULL) THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','mixed_modern_or_sequenced_history','tournament_id',t.id);
 END IF;
 SELECT count(*),array_agg(user_id ORDER BY user_id) INTO player_count,user_ids
   FROM public.tournament_players WHERE tournament_id=t.id;
 IF player_count<2 OR player_count>1000 OR array_position(user_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT u) FROM unnest(user_ids) u)<>player_count THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_roster_invalid','tournament_id',t.id);
 END IF;
 SELECT count(*) INTO receipt_count FROM public.settlement_idempotency_keys s
   JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t.id;
 IF receipt_count=0 OR receipt_count>10000 THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_receipt_scope_invalid','tournament_id',t.id);
 END IF;
 -- Failed attempts are not accepted witnesses. A malformed succeeded row is
 -- never filtered away to make an earlier, more convenient history win.
 FOR source IN SELECT to_jsonb(s) AS receipt FROM public.settlement_idempotency_keys s
   JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t.id
   ORDER BY s.completed_at,s.table_id,s.hand_id LOOP
   IF source.receipt->>'status'='failed' THEN CONTINUE; END IF;
   IF source.receipt->>'status'<>'succeeded' THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_hand_not_settled','tournament_id',t.id);
   END IF;
   qualified:=public.fn_ca_accepted_tournament_settlement_fact(source.receipt);
   IF qualified->'ok' IS DISTINCT FROM 'true'::jsonb THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_accepted_receipt_invalid','detail',qualified->>'reason','tournament_id',t.id);
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(qualified->'facts') f WHERE NOT ((f->>'user_id')::uuid=ANY(user_ids))) THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','foreign_player_in_accepted_receipt','tournament_id',t.id);
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(accepted) a
      WHERE a->>'hand_id'=qualified->>'hand_id' OR a->>'hand_number'=qualified->>'hand_number') THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','ambiguous_accepted_hand_claim','tournament_id',t.id);
   END IF;
   accepted:=accepted||jsonb_build_array(qualified||jsonb_build_object('source_receipt',source.receipt));
 END LOOP;
 FOR player IN SELECT id,user_id,status,chips FROM public.tournament_players WHERE tournament_id=t.id ORDER BY user_id LOOP
   SELECT jsonb_agg(a||jsonb_build_object('player_fact',f) ORDER BY (a->>'completed_at')::timestamptz DESC)
     INTO observations FROM jsonb_array_elements(accepted) a
     CROSS JOIN LATERAL jsonb_array_elements(a->'facts') f WHERE (f->>'user_id')::uuid=player.user_id;
   IF observations IS NULL THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_player_has_no_accepted_receipt','user_id',player.user_id,'tournament_id',t.id); END IF;
   last_fact:=observations->0;
   IF (SELECT count(*) FROM jsonb_array_elements(observations) o WHERE o->>'completed_at'=last_fact->>'completed_at')<>1 THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','ambiguous_latest_player_observation','user_id',player.user_id,'tournament_id',t.id);
   END IF;
   SELECT o INTO last_zero FROM jsonb_array_elements(observations) o
     WHERE (o#>>'{player_fact,stack_before}')::numeric>0 AND (o#>>'{player_fact,stack}')::numeric=0
     ORDER BY (o->>'completed_at')::timestamptz DESC LIMIT 1;
   SELECT min((o->>'completed_at')::timestamptz) INTO first_zero_at
     FROM jsonb_array_elements(observations) o
     WHERE (o#>>'{player_fact,stack_before}')::numeric>0 AND (o#>>'{player_fact,stack}')::numeric=0;
   IF first_zero_at IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(observations) o
       WHERE (o->>'completed_at')::timestamptz>first_zero_at
         AND (o#>>'{player_fact,stack}')::numeric>0) THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','post_zero_positive_write','user_id',player.user_id,'tournament_id',t.id);
   END IF;
   IF last_zero IS NOT NULL AND EXISTS(SELECT 1 FROM public.chip_ledger l
       WHERE l.tournament_id=t.id AND l.from_entity_id=player.user_id AND l.from_type='player_wallet'
         AND l.status='posted' AND l.amount>0 AND l.category IN ('rebuy','reentry','tournament_buyin')
         AND l.created_at>first_zero_at) THEN
     RETURN jsonb_build_object('version',1,'ok',false,'reason','post_zero_entry_purchase','user_id',player.user_id,'tournament_id',t.id);
   END IF;
   IF (last_fact#>>'{player_fact,stack}')::numeric>0 THEN
     survivor_count:=survivor_count+1;
     IF last_zero IS NOT NULL THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','survivor_previously_zero','tournament_id',t.id); END IF;
     winner:=jsonb_build_object('position',1,'user_id',player.user_id,'player_id',player.id,
       'observed_chips',(last_fact#>>'{player_fact,stack}')::numeric,'recorded_chips',player.chips,
       'recorded_status',player.status,'table_id',last_fact->'table_id','hand_id',last_fact->'hand_id',
       'hand_number',last_fact->'hand_number','accepted_settlement_key',last_fact->'source_key',
       'committed_at',last_fact->'completed_at','source_sha256',last_fact->'source_sha256','source_receipt',last_fact->'source_receipt');
   ELSE
     IF last_zero IS NULL THEN RETURN jsonb_build_object('version',1,'ok',false,'reason','zero_player_has_no_positive_to_zero_hand','user_id',player.user_id,'tournament_id',t.id); END IF;
     losers:=losers||jsonb_build_array(jsonb_build_object('user_id',player.user_id,'player_id',player.id,
       'table_id',last_zero->'table_id','hand_id',last_zero->'hand_id','hand_number',last_zero->'hand_number',
       'accepted_settlement_key',last_zero->'source_key','committed_at',last_zero->'completed_at',
       'stack_before',last_zero#>'{player_fact,stack_before}','source_sha256',last_zero->'source_sha256',
       'source_receipt',last_zero->'source_receipt','recorded_chips',player.chips,'recorded_status',player.status));
   END IF;
 END LOOP;
 IF survivor_count<>1 OR jsonb_array_length(losers)<>player_count-1 THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_finish_not_decided','positive_survivors',survivor_count,'tournament_id',t.id);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(losers) a JOIN jsonb_array_elements(losers) b
      ON a->>'user_id'<b->>'user_id' AND a->>'committed_at'=b->>'committed_at'
      WHERE a->>'table_id'<>b->>'table_id' OR a->>'hand_id'<>b->>'hand_id'
         OR (a->>'stack_before')::numeric=(b->>'stack_before')::numeric) THEN
   RETURN jsonb_build_object('version',1,'ok',false,'reason','legacy_bust_rank_tie_ambiguous','tournament_id',t.id);
 END IF;
 SELECT jsonb_agg(value||jsonb_build_object('position',position) ORDER BY position) INTO standings
   FROM (SELECT value,row_number() OVER(ORDER BY (value->>'committed_at')::timestamptz DESC,(value->>'stack_before')::numeric DESC)+1 position
     FROM jsonb_array_elements(losers)) ordered;
 standings:=jsonb_build_array(winner)||standings;
 basis:=jsonb_build_object('version',1,'tournament_id',t.id,'event_before',to_jsonb(t),
   'roster_before',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id) FROM public.tournament_players p WHERE p.tournament_id=t.id),
   'table_event_bindings',(SELECT jsonb_agg(jsonb_build_object('table_id',tb.id,'tournament_id',tb.tournament_id) ORDER BY tb.id) FROM public.tables tb WHERE tb.tournament_id=t.id),
   'accepted_receipts',accepted,'observed_winner_user_id',winner->'user_id');
 RETURN jsonb_build_object('version',1,'ok',true,'reason',NULL,'tournament_id',t.id,
   'financial_mode',CASE WHEN t.satellite_target_id IS NOT NULL THEN 'satellite' WHEN lower(t.variant)='spin' THEN 'spin' ELSE 'cash_places' END,
   'satellite_target_id',t.satellite_target_id,
   'observed_winner_user_id',winner->'user_id','observed_winner_chips',winner->'observed_chips',
   'recorded_winner_chips',winner->'recorded_chips','field_size',player_count,
   'recorded_winner_chips_match',winner->'observed_chips'=winner->'recorded_chips',
   'standings',standings,'accepted_receipt_count',jsonb_array_length(accepted),
   'basis_sha256',encode(extensions.digest(convert_to(basis::text,'UTF8'),'sha256'),'hex'),
   'sequence_writes',0,'money_writes',0);
END;
$legacy_tournament_finish_witness$;
ALTER FUNCTION public.fn_ca_legacy_tournament_finish_witness(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_tournament_finish_witness(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_legacy_tournament_finish_witness(uuid) IS
 'Private read-only legacy unpaid standings evidence; satellites must use their canonical satellite financial authority. Loads persisted receipts, refuses modern/mixed/paid/ambiguous history, preserves NULL sequences, and returns accepted facts for separately locked ordinary finish integration.';

COMMIT;
