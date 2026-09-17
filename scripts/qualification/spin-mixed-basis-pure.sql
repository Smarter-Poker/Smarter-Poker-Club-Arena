-- Pure evidence/key qualification only, inside each existing isolated Spin image.
-- Embedded source is byte-checked against the two maintained originals by the
-- driver. Only their single outer transaction wrappers are removed so all
-- installation/control effects roll back. No financial writer is invoked.
\set ON_ERROR_STOP on
SELECT set_config('mixed_pure.execution', :'execution_uuid', false) AS execution;
DO $boundary$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('mixed_pure.execution'),'-','')
    OR current_setting('mixed_pure.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR current_setting('qualification.execution_uuid')<>current_setting('mixed_pure.execution')
    OR inet_server_addr() IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'mixed pure: isolated non-superuser postgres allocation required';
 END IF;
END $boundary$;
SET statement_timeout='20s';
SET lock_timeout='1s';
SET timezone='UTC';
\ir fixtures/spin-history-retention/database-state.sql
CREATE FUNCTION pg_temp.mixed_pure_catalog() RETURNS jsonb LANGUAGE sql AS $catalog$
 SELECT coalesce(jsonb_agg(jsonb_build_object('proc',to_jsonb(p),
  'comment',obj_description(p.oid,'pg_proc')) ORDER BY p.oid),'[]'::jsonb)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
  'fn_settle_tournament_places','fn_ca_accepted_tournament_settlement_fact',
  'fn_ca_spin_mixed_history_shape_v1','fn_ca_spin_mixed_retained_reserve_key_v1'])
$catalog$;
CREATE TEMP TABLE mixed_pure_before AS SELECT pg_temp.mixed_pure_catalog() catalog,
 pg_temp.retention_database_state() business;
CREATE TEMP TABLE mixed_pure_source(component_sql text NOT NULL, shape_sql text NOT NULL);
INSERT INTO mixed_pure_source VALUES ($mixed_component_source$-- SOURCE-ONLY, PARTIAL FIFO5 candidate. Outside auto-applied migrations.
-- Installs private read-only evidence functions only. Does not replace the
-- settler, seal an admission, promote/rank players, or authorize any payment.
-- SQL/native qualification and current catalog/authority closure are UNRUN.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'))
          IS DISTINCT FROM '6181734ff98555ecc04648186f6ebf24'
     OR to_regprocedure('public.fn_ca_accepted_tournament_settlement_fact(jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_spin_mixed_history_shape_v1(jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'mixed-history evidence candidate preimage/authority differs'
      USING ERRCODE='55000';
  END IF;
END;
$guard$;

-- Exact private D9 accepted-fact body, retained prosrc MD5
-- 0be7ce46c91572336ee97c80e827428d. No legacy-only witness is replayed.
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

-- A pure shape/continuity check, NOT an admission function. In particular its
-- arguments cannot establish complete database coverage, source immutability,
-- paid-entry authority, or serialization. No financial caller is patched here.
CREATE FUNCTION public.fn_ca_spin_mixed_history_shape_v1(p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC'
AS $mixed_shape$
DECLARE
  event_row jsonb; roster jsonb; receipts jsonb; histories jsonb;
  commits jsonb; knocks jsonb; raw_receipt jsonb; fact jsonb;
  history_row jsonb; commit_row jsonb; player jsonb; seat_fact jsonb;
  old_player jsonb; modern_player jsonb; survivor jsonb; knockout jsonb;
  snapshot_key text; table_id uuid; tournament_id uuid; requested_winner uuid;
  users uuid[] := '{}'; receipt_ids uuid[] := '{}'; history_ids uuid[] := '{}';
  hand_numbers bigint[] := '{}'; user_id uuid; hand_number bigint;
  last_number bigint := 0; last_time timestamptz;
  stacks jsonb := '{}'; zeros jsonb := '[]';
  first_stacks boolean := true; count_rows integer; modern_count integer := 0;
  before_stack numeric; after_stack numeric; starting_stack numeric;
  legacy_zero jsonb; modern_zero jsonb;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->'version' IS DISTINCT FROM '1'::jsonb THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','snapshot_version');
  END IF;
  FOREACH snapshot_key IN ARRAY ARRAY['roster','tables','receipts','histories','commits','knockouts'] LOOP
    IF jsonb_typeof(p_snapshot->snapshot_key) IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','snapshot_array','field',snapshot_key);
    END IF;
    -- The retained D9 ceiling is a logical row bound, not a measured resource
    -- guarantee. A DB loader must enforce it before aggregation as well.
    IF jsonb_array_length(p_snapshot->snapshot_key)>10000 THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','snapshot_row_limit','field',snapshot_key);
    END IF;
  END LOOP;
  event_row:=p_snapshot->'tournament'; roster:=p_snapshot->'roster';
  receipts:=p_snapshot->'receipts'; histories:=p_snapshot->'histories';
  commits:=p_snapshot->'commits'; knocks:=p_snapshot->'knockouts';
  IF jsonb_typeof(event_row) IS DISTINCT FROM 'object'
     OR event_row->>'status' IS DISTINCT FROM 'RUNNING'
     OR lower(event_row->>'variant') IS DISTINCT FROM 'spin'
     OR upper(COALESCE(event_row->>'tournament_type',''))='SATELLITE'
     OR COALESCE(event_row->'satellite_target_id','null'::jsonb)<>'null'::jsonb
     OR COALESCE(event_row->'satellite_target','null'::jsonb)<>'null'::jsonb
     OR event_row->'is_bounty' IS DISTINCT FROM 'false'::jsonb
     OR event_row->'is_pko' IS DISTINCT FROM 'false'::jsonb
     OR event_row->'is_mystery_bounty' IS DISTINCT FROM 'false'::jsonb
     OR jsonb_typeof(event_row->'starting_chips') IS DISTINCT FROM 'number'
     OR jsonb_array_length(roster)<>3 OR jsonb_array_length(p_snapshot->'tables')<>1
     OR jsonb_array_length(receipts)<2
     OR jsonb_array_length(histories)<>jsonb_array_length(receipts)
     OR jsonb_array_length(commits)<1 OR jsonb_array_length(knocks)<>1 THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','ordinary_three_entrant_shape');
  END IF;
  tournament_id:=(event_row->>'id')::uuid;
  table_id:=(p_snapshot#>>'{tables,0,id}')::uuid;
  requested_winner:=(p_snapshot->>'observed_winner_id')::uuid;
  starting_stack:=(event_row->>'starting_chips')::numeric;
  IF tournament_id IS NULL OR table_id IS NULL OR requested_winner IS NULL
     OR (p_snapshot#>>'{tables,0,tournament_id}')::uuid IS DISTINCT FROM tournament_id
     OR starting_stack<=0 OR starting_stack::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','event_identity_or_starting_stack');
  END IF;
  FOR player IN SELECT value FROM jsonb_array_elements(roster) LOOP
    user_id:=(player->>'user_id')::uuid;
    IF jsonb_typeof(player) IS DISTINCT FROM 'object' OR user_id IS NULL
       OR user_id=ANY(users) OR (player->>'id')::uuid IS NULL
       OR (player->>'tournament_id')::uuid IS DISTINCT FROM tournament_id
       OR (player->>'table_id')::uuid IS DISTINCT FROM table_id
       OR jsonb_typeof(player->'chips') IS DISTINCT FROM 'number'
       OR (player->>'chips')::numeric<0
       OR (player->>'chips')::numeric::text IN ('NaN','Infinity','-Infinity')
       OR player->'rebuys' IS DISTINCT FROM '0'::jsonb
       OR player->'add_on' IS DISTINCT FROM 'false'::jsonb
       OR COALESCE(player->'terminal_closed_at','null'::jsonb)<>'null'::jsonb THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','roster_identity_or_scope');
    END IF;
    users:=array_append(users,user_id);
    IF player->>'status'='eliminated' AND player->'position'='3'::jsonb
       AND player->'elimination_sequence'='null'::jsonb AND player->'chips'='0'::jsonb
       AND old_player IS NULL THEN old_player:=player;
    ELSIF player->>'status'='eliminated' AND player->'position'='2'::jsonb
       AND jsonb_typeof(player->'elimination_sequence')='number'
       AND (player->>'elimination_sequence')~'^[1-9][0-9]*$'
       AND player->'chips'='0'::jsonb AND modern_player IS NULL THEN modern_player:=player;
    ELSIF player->>'status'='playing' AND player->'position'='null'::jsonb
       AND player->'elimination_sequence'='null'::jsonb AND (player->>'chips')::numeric>0
       AND survivor IS NULL THEN survivor:=player;
    ELSE RETURN jsonb_build_object('shape_ok',false,'reason','existing_places_or_sequences');
    END IF;
  END LOOP;
  IF old_player IS NULL OR modern_player IS NULL OR survivor IS NULL
     OR (survivor->>'user_id')::uuid IS DISTINCT FROM requested_winner
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(roster))<>3 THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','three_distinct_existing_roles');
  END IF;

  -- Do not skip a failed, pending or malformed receipt to select a convenient
  -- history. This proposed narrow shape conservatively requires every supplied
  -- retained source row to be an accepted hand.
  FOR raw_receipt IN SELECT value FROM jsonb_array_elements(receipts)
      ORDER BY (value->>'completed_at')::timestamptz,value->>'hand_id' LOOP
    fact:=public.fn_ca_accepted_tournament_settlement_fact(raw_receipt);
    IF fact->'ok' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','unaccepted_receipt','detail',fact->>'reason');
    END IF;
    hand_number:=(fact->>'hand_number')::bigint;
    IF (fact->>'table_id')::uuid IS DISTINCT FROM table_id
       OR (fact->>'hand_id')::uuid=ANY(receipt_ids)
       OR hand_number=ANY(hand_numbers) OR hand_number<=last_number
       OR (last_time IS NOT NULL AND (fact->>'completed_at')::timestamptz<=last_time) THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','receipt_identity_or_order');
    END IF;
    receipt_ids:=array_append(receipt_ids,(fact->>'hand_id')::uuid);
    hand_numbers:=array_append(hand_numbers,hand_number);
    last_number:=hand_number; last_time:=(fact->>'completed_at')::timestamptz;
    SELECT count(*) INTO count_rows FROM jsonb_array_elements(histories) h
      WHERE h->>'table_id'=table_id::text AND h->'hand_number'=to_jsonb(hand_number);
    IF count_rows<>1 THEN RETURN jsonb_build_object('shape_ok',false,'reason','history_not_one_to_one'); END IF;
    SELECT h INTO history_row FROM jsonb_array_elements(histories) h
      WHERE h->>'table_id'=table_id::text AND h->'hand_number'=to_jsonb(hand_number);
    IF (history_row->>'id')::uuid IS NULL OR (history_row->>'id')::uuid=ANY(history_ids)
       OR (history_row->>'tournament_id')::uuid IS DISTINCT FROM tournament_id
       OR jsonb_typeof(history_row->'players') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','history_identity');
    END IF;
    history_ids:=array_append(history_ids,(history_row->>'id')::uuid);
    IF jsonb_array_length(history_row->'players')<>jsonb_array_length(fact->'facts')
       OR (SELECT count(DISTINCT h->>'userId') FROM jsonb_array_elements(history_row->'players') h)
            <>jsonb_array_length(fact->'facts') THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','history_player_set');
    END IF;
    IF first_stacks THEN
      IF jsonb_array_length(fact->'facts')<>3 THEN
        RETURN jsonb_build_object('shape_ok',false,'reason','initial_field_incomplete');
      END IF;
    ELSIF jsonb_array_length(fact->'facts')<>(SELECT count(*) FROM jsonb_each(stacks) s WHERE s.value::numeric>0) THEN
      RETURN jsonb_build_object('shape_ok',false,'reason','later_participation_set');
    END IF;
    FOR seat_fact IN SELECT value FROM jsonb_array_elements(fact->'facts') LOOP
      user_id:=(seat_fact->>'user_id')::uuid;
      before_stack:=(seat_fact->>'stack_before')::numeric;
      after_stack:=(seat_fact->>'stack')::numeric;
      IF NOT user_id=ANY(users)
         OR (first_stacks AND before_stack IS DISTINCT FROM starting_stack)
         OR (NOT first_stacks AND (before_stack IS DISTINCT FROM (stacks->>user_id::text)::numeric OR before_stack<=0))
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history_row->'players') h
             WHERE h->>'userId'=user_id::text AND jsonb_typeof(h->'stack')='number'
               AND (h->>'stack')::numeric=after_stack) THEN
        RETURN jsonb_build_object('shape_ok',false,'reason','stack_continuity_or_history');
      END IF;
      stacks:=jsonb_set(stacks,ARRAY[user_id::text],to_jsonb(after_stack));
      IF before_stack>0 AND after_stack=0 THEN
        zeros:=zeros||jsonb_build_array(jsonb_build_object('user_id',user_id,
          'hand_number',hand_number,'settlement_hand_id',fact->'hand_id',
          'history_hand_id',history_row->'id','completed_at',fact->'completed_at',
          'stack_before',before_stack,'source_sha256',fact->'source_sha256'));
      END IF;
    END LOOP;
    first_stacks:=false;
    SELECT count(*) INTO count_rows FROM jsonb_array_elements(commits) c
      WHERE c->>'table_id'=table_id::text AND c->'hand_number'=to_jsonb(hand_number);
    IF count_rows>1 THEN RETURN jsonb_build_object('shape_ok',false,'reason','duplicate_modern_commit'); END IF;
    IF count_rows=1 THEN
      SELECT c INTO commit_row FROM jsonb_array_elements(commits) c
        WHERE c->>'table_id'=table_id::text AND c->'hand_number'=to_jsonb(hand_number);
      IF commit_row->'hand_id' IS DISTINCT FROM history_row->'id'
         OR commit_row->'stack_result' IS DISTINCT FROM raw_receipt->'result'
         OR commit_row#>'{post_commit_result,ok}' IS DISTINCT FROM 'true'::jsonb
         OR commit_row#>'{post_commit_result,hand_id}' IS DISTINCT FROM commit_row->'hand_id'
         OR commit_row#>'{post_commit_result,hand_number}' IS DISTINCT FROM to_jsonb(hand_number)
         OR jsonb_typeof(commit_row->'post_commit_payload') IS DISTINCT FROM 'object'
         OR commit_row->>'post_commit_payload_hash' IS DISTINCT FROM
              encode(extensions.digest(convert_to((commit_row->'post_commit_payload')::text,'UTF8'),'sha256'),'hex')
         OR commit_row->>'committed_at' IS NULL
         OR commit_row->>'post_commit_completed_at' IS NULL
         OR NOT isfinite((commit_row->>'committed_at')::timestamptz)
         OR NOT isfinite((commit_row->>'post_commit_completed_at')::timestamptz)
         OR (commit_row->>'post_commit_completed_at')::timestamptz<(commit_row->>'committed_at')::timestamptz THEN
        RETURN jsonb_build_object('shape_ok',false,'reason','modern_commit_or_required_completion');
      END IF;
      modern_count:=modern_count+1;
    END IF;
  END LOOP;
  IF modern_count<>jsonb_array_length(commits) OR jsonb_array_length(zeros)<>2 THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','commit_coverage_or_zero_count');
  END IF;
  legacy_zero:=zeros->0; modern_zero:=zeros->1; knockout:=knocks->0;
  IF legacy_zero->'user_id' IS DISTINCT FROM old_player->'user_id'
     OR modern_zero->'user_id' IS DISTINCT FROM modern_player->'user_id'
     OR modern_zero->'hand_number' IS DISTINCT FROM to_jsonb(last_number)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(commits) c WHERE c->'hand_number'=legacy_zero->'hand_number')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(commits) c WHERE c->'hand_number'=modern_zero->'hand_number')
     OR jsonb_typeof(knockout) IS DISTINCT FROM 'object'
     OR (knockout->>'id')::uuid IS NULL
     OR knockout->>'state' IS DISTINCT FROM 'eliminated'
     OR (knockout->>'tournament_id')::uuid IS DISTINCT FROM tournament_id
     OR (knockout->>'table_id')::uuid IS DISTINCT FROM table_id
     OR knockout->'eliminated_user_id' IS DISTINCT FROM modern_player->'user_id'
     OR knockout->'hand_id' IS DISTINCT FROM modern_zero->'history_hand_id'
     OR knockout->'hand_number' IS DISTINCT FROM modern_zero->'hand_number'
     OR knockout->'stack_before' IS DISTINCT FROM modern_zero->'stack_before'
     OR knockout->'stack_after' IS DISTINCT FROM '0'::jsonb THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','legacy_then_canonical_modern_bust');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(roster) p
      WHERE (p->>'chips')::numeric IS DISTINCT FROM (stacks->>(p->>'user_id'))::numeric) THEN
    RETURN jsonb_build_object('shape_ok',false,'reason','current_roster_stack_mismatch');
  END IF;
  RETURN jsonb_build_object('version',1,'shape_ok',true,'reason',NULL,
    'tournament_id',tournament_id,'table_id',table_id,'observed_winner_id',requested_winner,
    'legacy_zero',legacy_zero,'modern_zero',modern_zero,'retained_receipt_count',jsonb_array_length(receipts),
    'modern_commit_count',modern_count,'final_stacks',stacks,
    'snapshot_sha256',encode(extensions.digest(convert_to(p_snapshot::text,'UTF8'),'sha256'),'hex'),
    'payment_authority',false,'historical_immutability_proven',false,
    'scope','supplied current retained history; DB completeness, paid-entry and sealing require separate admission');
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
  RETURN jsonb_build_object('shape_ok',false,'reason','invalid_snapshot_value');
END;
$mixed_shape$;
ALTER FUNCTION public.fn_ca_spin_mixed_history_shape_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_history_shape_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_spin_mixed_history_shape_v1(jsonb) IS
 'Private pure mixed-history shape evidence only; no admission or financial authority, no historical immutability claim. Requires existing places 3/2 and preserves legacy NULL and modern sequence.';

-- The original 20260909014433 reserve validator accepted NULL on retained
-- contribution and draw legs. Current INSERT authority requires an entry key;
-- this private read-only compatibility predicate does not change that writer.
-- Admission separately requires exactly one original leg with the exact
-- tournament/pool/club, amount and balance transition; NULL is not a receipt.
CREATE FUNCTION public.fn_ca_spin_mixed_retained_reserve_key_v1(
  p_tournament_id uuid,p_kind text,p_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO pg_catalog
AS $retained_key$
 SELECT coalesce(p_tournament_id IS NOT NULL AND p_kind IN ('entry','draw')
   AND (p_key IS NULL OR p_key='spin:'||p_tournament_id::text||':'||p_kind),false)
$retained_key$;
ALTER FUNCTION public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text) IS
 'Private retained-cutover key predicate only; original NULL key is permitted with separate exact journal evidence. Does not authorize money or change current INSERT rules.';

$mixed_component_source$,$mixed_shape_source$-- UNRUN native pure-evidence tests. Run only in the existing protected
-- accounting PostgreSQL allocation after the evidence component. No financial
-- table inserts, business functions, paid fixture or production identities.
SET LOCAL statement_timeout='10s';
DO $test$
DECLARE sample jsonb := $sample${
  "version": 1,
  "tournament": {
    "id": "10000000-0000-4000-8000-000000000001",
    "status": "RUNNING",
    "variant": "spin",
    "tournament_type": "SNG",
    "satellite_target_id": null,
    "satellite_target": null,
    "is_bounty": false,
    "is_pko": false,
    "is_mystery_bounty": false,
    "starting_chips": 100
  },
  "observed_winner_id": "00000000-0000-4000-8000-000000000003",
  "tables": [
    {
      "id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001"
    }
  ],
  "roster": [
    {
      "id": "30000000-0000-4000-8000-000000000001",
      "user_id": "00000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 0,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "eliminated",
      "position": 3,
      "elimination_sequence": null
    },
    {
      "id": "30000000-0000-4000-8000-000000000002",
      "user_id": "00000000-0000-4000-8000-000000000002",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 0,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "eliminated",
      "position": 2,
      "elimination_sequence": 7
    },
    {
      "id": "30000000-0000-4000-8000-000000000003",
      "user_id": "00000000-0000-4000-8000-000000000003",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 300,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "playing",
      "position": null,
      "elimination_sequence": null
    }
  ],
  "receipts": [
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_id": "40000000-0000-4000-8000-000000000001",
      "status": "succeeded",
      "error": null,
      "completed_at": "2026-09-01T00:00:01+00:00",
      "result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000001",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000001,
        "players": 3,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000001",
              "stack_before": 100,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 100,
              "stack": 200
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 100
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000001": 0,
          "00000000-0000-4000-8000-000000000002": 200,
          "00000000-0000-4000-8000-000000000003": 100
        }
      }
    },
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_id": "40000000-0000-4000-8000-000000000002",
      "status": "succeeded",
      "error": null,
      "completed_at": "2026-09-01T00:00:02+00:00",
      "result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000002",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000002,
        "players": 2,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 200,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 300
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000002": 0,
          "00000000-0000-4000-8000-000000000003": 300
        }
      }
    }
  ],
  "histories": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "hand_number": 1000001,
      "players": [
        {
          "userId": "00000000-0000-4000-8000-000000000001",
          "stack": 0
        },
        {
          "userId": "00000000-0000-4000-8000-000000000002",
          "stack": 200
        },
        {
          "userId": "00000000-0000-4000-8000-000000000003",
          "stack": 100
        }
      ]
    },
    {
      "id": "50000000-0000-4000-8000-000000000002",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "hand_number": 1000002,
      "players": [
        {
          "userId": "00000000-0000-4000-8000-000000000002",
          "stack": 0
        },
        {
          "userId": "00000000-0000-4000-8000-000000000003",
          "stack": 300
        }
      ]
    }
  ],
  "commits": [
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_number": 1000002,
      "hand_id": "50000000-0000-4000-8000-000000000002",
      "stack_result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000002",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000002,
        "players": 2,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 200,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 300
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000002": 0,
          "00000000-0000-4000-8000-000000000003": 300
        }
      },
      "committed_at": "2026-09-01T00:00:03+00:00",
      "post_commit_completed_at": "2026-09-01T00:00:04+00:00",
      "post_commit_payload": {
        "time_banks": []
      },
      "post_commit_payload_hash": "filled by native JSONB digest below",
      "post_commit_result": {
        "ok": true,
        "hand_id": "50000000-0000-4000-8000-000000000002",
        "hand_number": 1000002
      }
    }
  ],
  "knockouts": [
    {
      "id": "60000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "eliminated_user_id": "00000000-0000-4000-8000-000000000002",
      "hand_id": "50000000-0000-4000-8000-000000000002",
      "hand_number": 1000002,
      "stack_before": 200,
      "stack_after": 0,
      "state": "eliminated"
    }
  ]
}$sample$::jsonb;
 original jsonb; changed jsonb; result jsonb; item record; tested integer:=0;
BEGIN
 sample:=jsonb_set(sample,'{commits,0,post_commit_payload_hash}',
   to_jsonb(encode(extensions.digest((sample#>'{commits,0,post_commit_payload}')::text,'sha256'),'hex')));
 original:=sample;
 result:=public.fn_ca_spin_mixed_history_shape_v1(sample);
 IF result->'shape_ok' IS DISTINCT FROM 'true'::jsonb
    OR result->'payment_authority' IS DISTINCT FROM 'false'::jsonb
    OR result->'historical_immutability_proven' IS DISTINCT FROM 'false'::jsonb
    OR result#>>'{legacy_zero,settlement_hand_id}'=result#>>'{legacy_zero,history_hand_id}'
    OR sample IS DISTINCT FROM original THEN
   RAISE EXCEPTION 'mixed shape positive/identity/non-authority control failed: %',result;
 END IF;
 FOR item IN SELECT * FROM (VALUES
  ('failed_receipt',ARRAY['receipts','0','status'],'"failed"'::jsonb),
  ('false_success',ARRAY['receipts','0','result','success'],'false'::jsonb),
  ('false_conservation',ARRAY['receipts','0','result','conservation_checked'],'false'::jsonb),
  ('foreign_result_hand',ARRAY['receipts','0','result','hand_id'],'"40000000-0000-4000-8000-000000000009"'::jsonb),
  ('missing_old_sequence_field',ARRAY['roster','0','elimination_sequence'],'"unknown"'::jsonb),
  ('already_sequenced_old_bust',ARRAY['roster','0','elimination_sequence'],'6'::jsonb),
  ('missing_modern_sequence',ARRAY['roster','1','elimination_sequence'],'null'::jsonb),
  ('changed_existing_place',ARRAY['roster','0','position'],'2'::jsonb),
  ('changed_current_stack',ARRAY['roster','2','chips'],'301'::jsonb),
  ('foreign_history_user',ARRAY['histories','0','players','0','userId'],'"00000000-0000-4000-8000-000000000009"'::jsonb),
  ('duplicate_history_number',ARRAY['histories','1','hand_number'],'1000001'::jsonb),
  ('pending_postcommit',ARRAY['commits','0','post_commit_completed_at'],'null'::jsonb),
  ('wrong_canonical_completion_uuid',ARRAY['commits','0','post_commit_result','hand_id'],'"40000000-0000-4000-8000-000000000002"'::jsonb),
  ('changed_stored_envelope',ARRAY['commits','0','post_commit_payload','time_banks'],'[{}]'::jsonb),
  ('no_modern_commit',ARRAY['commits'],'[]'::jsonb),
  ('foreign_knockout',ARRAY['knockouts','0','eliminated_user_id'],'"00000000-0000-4000-8000-000000000001"'::jsonb),
  ('late_entry_count',ARRAY['roster','0','rebuys'],'1'::jsonb),
  ('two_tables',ARRAY['tables'],'[]'::jsonb),
  ('missing_receipt',ARRAY['receipts'],'[]'::jsonb),
  ('invalid_date',ARRAY['receipts','0','completed_at'],'"today"'::jsonb)
 ) cases(name,path,replacement) LOOP
  changed:=jsonb_set(sample,item.path,item.replacement);
  result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
  IF result->'shape_ok' IS DISTINCT FROM 'false'::jsonb OR result->>'reason' IS NULL THEN
   RAISE EXCEPTION 'mixed shape negative % falsely passed: %',item.name,result;
  END IF;
  tested:=tested+1;
 END LOOP;
 -- Conservation alone is insufficient: before-stacks may conserve the total
 -- while disagreeing with the preceding exact accepted after-stacks.
 changed:=jsonb_set(jsonb_set(sample,'{receipts,1,result,request,stacks,0,stack_before}','199'),
   '{receipts,1,result,request,stacks,1,stack_before}','101');
 changed:=jsonb_set(changed,'{commits,0,stack_result}',changed#>'{receipts,1,result}');
 result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
 IF result->>'reason' IS DISTINCT FROM 'stack_continuity_or_history' THEN
  RAISE EXCEPTION 'mixed conserved-but-discontinuous stack control failed: %',result;
 END IF;
 IF tested<>20 OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) role_name
     WHERE has_function_privilege(role_name,'public.fn_ca_spin_mixed_history_shape_v1(jsonb)','EXECUTE')
        OR has_function_privilege(role_name,'public.fn_ca_accepted_tournament_settlement_fact(jsonb)','EXECUTE')) THEN
  RAISE EXCEPTION 'mixed shape control count/private execute boundary failed';
 END IF;
 RAISE NOTICE 'mixed shape: one positive and 21 negative native controls passed; no financial qualification';
END;
$test$;
$mixed_shape_source$);
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
DO $controls$
DECLARE source record; before record; f record; r text; msg text; n integer:=0;
 tid constant uuid:='10000000-0000-4000-8000-000000000001';
BEGIN
 SELECT * INTO STRICT source FROM pg_temp.mixed_pure_source;
 SELECT * INTO STRICT before FROM pg_temp.mixed_pure_before;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'))
       IS DISTINCT FROM '6181734ff98555ecc04648186f6ebf24'
    OR to_regprocedure('public.fn_ca_accepted_tournament_settlement_fact(jsonb)') IS NOT NULL
    OR to_regprocedure('public.fn_ca_spin_mixed_history_shape_v1(jsonb)') IS NOT NULL
    OR to_regprocedure('public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'mixed pure: original exact provider preimage required';
 END IF;
 -- Missing real preimage must refuse before any private function can install.
 -- Rename is transaction-local authority fault injection; no replaced body or
 -- business call is used, and the exception restores the original exact row.
 BEGIN
  ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid) RENAME TO mixed_pure_missing_preimage;
  BEGIN
   EXECUTE source.component_sql;
   RAISE EXCEPTION 'mixed pure: missing preimage incorrectly accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
   GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
   IF msg<>'mixed-history evidence candidate preimage/authority differs' THEN RAISE; END IF;
  END;
  RAISE EXCEPTION USING ERRCODE='PZ901',MESSAGE='mixed pure rollback missing preimage';
 EXCEPTION WHEN SQLSTATE 'PZ901' THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'mixed pure rollback missing preimage' THEN RAISE; END IF;
 END;
 IF pg_temp.mixed_pure_catalog() IS DISTINCT FROM before.catalog THEN
  RAISE EXCEPTION 'mixed pure: preimage control did not restore exact catalog'; END IF;
 BEGIN
  EXECUTE source.component_sql;
  FOR f IN SELECT * FROM (VALUES
   ('fn_ca_accepted_tournament_settlement_fact','0be7ce46c91572336ee97c80e827428d',true,'plpgsql',ARRAY['search_path=pg_catalog, public, pg_temp','TimeZone=UTC']::text[]),
   ('fn_ca_spin_mixed_history_shape_v1','5c7fcb7ef050039c78c4df05d77100f9',true,'plpgsql',ARRAY['search_path=pg_catalog, public, pg_temp','TimeZone=UTC']::text[]),
   ('fn_ca_spin_mixed_retained_reserve_key_v1','057cf3d695142e81ee11378eed07be1c',false,'sql',ARRAY['search_path=pg_catalog']::text[])
  ) expected(name,body_md5,security_definer,language,config) LOOP
   IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_language l ON l.oid=p.prolang
       WHERE n.nspname='public' AND p.proname=f.name
         AND md5(p.prosrc)=f.body_md5 AND p.proowner='postgres'::regrole
         AND p.provolatile='i' AND p.prosecdef=f.security_definer
         AND l.lanname=f.language AND p.proconfig=f.config
         AND p.proacl::text='{postgres=X/postgres}')<>1 THEN
    RAISE EXCEPTION 'mixed pure: installed function body/owner/ACL/config differs: %',f.name;
   END IF;
  END LOOP;
  BEGIN
   EXECUTE source.component_sql;
   RAISE EXCEPTION 'mixed pure: duplicate installation incorrectly accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
   GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
   IF msg<>'mixed-history evidence candidate preimage/authority differs' THEN RAISE; END IF;
  END;
  EXECUTE source.shape_sql; -- unchanged one positive plus 21 negative controls
  FOR f IN SELECT * FROM (VALUES
   ('entry',NULL::text,true),('draw',NULL::text,true),
   ('entry','spin:'||tid::text||':entry',true),('draw','spin:'||tid::text||':draw',true),
   ('entry','spin:'||tid::text||':draw',false),('draw','spin:'||tid::text||':entry',false),
   ('entry','spin:10000000-0000-4000-8000-000000000002:entry',false),
   ('entry','',false),('entry',' spin:'||tid::text||':entry',false),
   ('entry','spin:'||tid::text||':entry ',false),('entry','SPIN:'||tid::text||':entry',false),
   ('ENTRY',NULL,false),('',NULL,false),('refund',NULL,false),(NULL,NULL,false)
  ) cases(kind,key,expected) LOOP
   IF public.fn_ca_spin_mixed_retained_reserve_key_v1(tid,f.kind,f.key) IS DISTINCT FROM f.expected THEN
    RAISE EXCEPTION 'mixed pure: retained key scalar case differs: %',n; END IF;
   n:=n+1;
  END LOOP;
  IF n<>15 OR public.fn_ca_spin_mixed_retained_reserve_key_v1(NULL,'entry',NULL) IS DISTINCT FROM false
     OR public.fn_ca_spin_mixed_retained_reserve_key_v1(NULL,'draw','spin:'||tid::text||':draw') IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'mixed pure: retained key null identity/count control differs'; END IF;
  -- Actual denied invocations complement exact ACL inspection, including PUBLIC.
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF NOT has_schema_privilege(r,'public','USAGE') THEN
    RAISE EXCEPTION 'mixed pure: role cannot reach public schema: %',r; END IF;
   FOR f IN SELECT * FROM (VALUES
    ('fn_ca_accepted_tournament_settlement_fact','SELECT public.fn_ca_accepted_tournament_settlement_fact(NULL::jsonb)'),
    ('fn_ca_spin_mixed_history_shape_v1','SELECT public.fn_ca_spin_mixed_history_shape_v1(NULL::jsonb)'),
    ('fn_ca_spin_mixed_retained_reserve_key_v1','SELECT public.fn_ca_spin_mixed_retained_reserve_key_v1(NULL::uuid,NULL::text,NULL::text)')
   ) calls(name,sql) LOOP
    BEGIN
     EXECUTE format('SET LOCAL ROLE %I',r);
     EXECUTE f.sql;
     RAISE EXCEPTION 'mixed pure: private invocation incorrectly accepted';
    EXCEPTION WHEN insufficient_privilege THEN
     GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
     IF msg<>'permission denied for function '||f.name THEN RAISE; END IF;
    END;
    IF current_user<>'postgres' THEN RAISE EXCEPTION 'mixed pure: role rollback failed'; END IF;
   END LOOP;
  END LOOP;
  IF pg_temp.retention_database_state() IS DISTINCT FROM before.business THEN
   RAISE EXCEPTION 'mixed pure: evidence controls changed business rows'; END IF;
  RAISE EXCEPTION USING ERRCODE='PZ902',MESSAGE='mixed pure rollback installed controls';
 EXCEPTION WHEN SQLSTATE 'PZ902' THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'mixed pure rollback installed controls' THEN RAISE; END IF;
 END;
 IF pg_temp.mixed_pure_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business THEN
  RAISE EXCEPTION 'mixed pure: inner rollback changed original state'; END IF;
 -- Install once more solely to observe the real outer ROLLBACK below.
 EXECUTE source.component_sql;
END $controls$;
ROLLBACK;
DO $outer_observer$
DECLARE before record;
BEGIN
 SELECT * INTO STRICT before FROM pg_temp.mixed_pure_before;
 IF pg_temp.mixed_pure_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business
    OR to_regprocedure('public.fn_ca_accepted_tournament_settlement_fact(jsonb)') IS NOT NULL
    OR to_regprocedure('public.fn_ca_spin_mixed_history_shape_v1(jsonb)') IS NOT NULL
    OR to_regprocedure('public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'mixed pure: outer rollback did not restore exact absence/catalog/business state';
 END IF;
END $outer_observer$;
SELECT jsonb_build_object('qualification','spin_mixed_basis_pure_evidence',
 'shape_positive',1,'shape_negative',21,'key_scalar_controls',17,'private_invocation_refusals',9,
 'installed_authority_verified',true,'missing_preimage_refused',true,'duplicate_install_refused',true,
 'inner_and_outer_rollback_verified',true,'business_rows_unchanged',true,
 'historical_original_rows_qualified',false,'statement_lane_qualified',false,
 'financial_completion_qualified',false,'full_qualification',false);
