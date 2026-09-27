\set ON_ERROR_STOP on
-- Authentic first-event restore, executed only by the existing finite native
-- allocator before its trigger suffix. It is not an entry producer or payout.
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL timezone='UTC';
CREATE TEMP TABLE first_archive_seed_document(value jsonb NOT NULL);
INSERT INTO first_archive_seed_document VALUES(:'archive_state_json'::jsonb);
DO $restore$
DECLARE document jsonb; relation_name text; rows jsonb; columns text; count_before bigint;
 invalid_column text; restored_count integer; expected_count integer; original_contract jsonb;
 original_rake jsonb; economic_text text;
BEGIN
 IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
 OR current_database() NOT LIKE 'qual_spin_expiry_%'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal) THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_PRE_TRIGGER_RESTORE_BOUNDARY'; END IF;
 SELECT value INTO STRICT document FROM first_archive_seed_document;
 IF document->>'event' IS DISTINCT FROM '2aa4cba1-506f-426b-a1ba-d8e22e018533'
 OR document->'contacts_or_credentials_restored' IS DISTINCT FROM 'false'::jsonb
 OR document->'financial_qualification' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_RESTORE_IDENTITY'; END IF;
 FOR relation_name IN SELECT jsonb_array_elements_text(document->'order') LOOP
  IF relation_name<>ALL(ARRAY['auth.users','public.profiles','public.unions','public.clubs',
   'public.spin_bonus_pools','public.tournaments','public.tables','public.tournament_players',
   'public.table_seats','public.club_members','public.chip_ledger','public.rake_records',
   'public.tournament_escrow','public.spin_reserve_ledger','public.tournament_refund_entitlements',
   'public.managed_game_contract_versions','public.ca_mtt_admission_contract','public.ca_chip_store_coverage','public.accepted_event_operations']) THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_UNEXPECTED_RELATION: %',relation_name; END IF;
  IF to_regclass(relation_name) IS NULL THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_PROVIDER_RELATION_MISSING: %',relation_name; END IF;
  rows:=document->'rows'->relation_name;
  IF jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_RESTORE_ROWS_REQUIRED: %',relation_name; END IF;
  expected_count:=jsonb_array_length(rows);
  EXECUTE format('SELECT count(*) FROM %s',relation_name) INTO count_before;
  IF count_before<>0 THEN RAISE EXCEPTION 'FIRST_ARCHIVE_PROVIDER_NOT_EMPTY: %',relation_name; END IF;
  IF expected_count=0 THEN CONTINUE; END IF;
  SELECT key INTO invalid_column FROM jsonb_array_elements(rows) row_value,
   LATERAL jsonb_object_keys(row_value) key
   WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(relation_name)
     AND attname=key AND attnum>0 AND NOT attisdropped) LIMIT 1;
  IF invalid_column IS NOT NULL THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_PROVIDER_COLUMN_MISSING: %.%',relation_name,invalid_column; END IF;
  SELECT string_agg(quote_ident(key),',' ORDER BY key) INTO columns
   FROM jsonb_object_keys(rows->0) key JOIN pg_attribute a
    ON a.attrelid=to_regclass(relation_name) AND a.attname=key
   WHERE a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='';
  EXECUTE format('INSERT INTO %s(%s) SELECT %s FROM jsonb_populate_recordset(NULL::%s,$1)',
   relation_name,columns,columns,relation_name) USING rows;
  GET DIAGNOSTICS restored_count=ROW_COUNT;
  IF restored_count<>expected_count THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_RESTORE_COUNT_CHANGED: %',relation_name; END IF;
  IF relation_name='public.ca_chip_store_coverage' AND
   (SELECT jsonb_agg(to_jsonb(g) ORDER BY store) FROM public.ca_chip_store_coverage g)
   IS DISTINCT FROM rows THEN RAISE EXCEPTION 'FIRST_ARCHIVE_CHIP_STORE_REGISTRY_CHANGED'; END IF;
  IF relation_name='public.accepted_event_operations' AND
   (SELECT jsonb_agg(to_jsonb(g) ORDER BY event_kind,event_id) FROM public.accepted_event_operations g)
   IS DISTINCT FROM rows THEN RAISE EXCEPTION 'FIRST_ARCHIVE_ACCEPTED_OPERATION_CHANGED'; END IF;
 END LOOP;
 -- Restore exact captured JSONB numeric lexemes, not a normalized JSON roundtrip.
 -- JSONB equality proves only scale changed; the original authoritative hash stays.
 IF jsonb_array_length(document->'original_contract_text_custody'->'versions') IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_ORIGINAL_CONTRACT_TEXT_REQUIRED'; END IF;
 FOR original_contract IN SELECT value FROM jsonb_array_elements(document->'original_contract_text_custody'->'versions') LOOP
  UPDATE public.managed_game_contract_versions
   SET contract=(original_contract->>'contract_text')::jsonb
   WHERE id=(original_contract->>'id')::bigint
    AND game_id='2aa4cba1-506f-426b-a1ba-d8e22e018533' AND game_kind='tournament'
    AND version=(original_contract->>'version')::integer
    AND contract=(original_contract->>'contract_text')::jsonb
    AND contract_hash=original_contract->>'stored_hash'
    AND original_contract->>'stored_hash'=original_contract->>'computed_hash';
  GET DIAGNOSTICS restored_count=ROW_COUNT;
  IF restored_count<>1 OR NOT EXISTS(SELECT 1 FROM public.managed_game_contract_versions
   WHERE id=(original_contract->>'id')::bigint
    AND contract::text=original_contract->>'contract_text'
    AND encode(extensions.digest(convert_to(contract::text,'UTF8'),'sha256'),'hex')=contract_hash) THEN
   RAISE EXCEPTION 'FIRST_ARCHIVE_ORIGINAL_CONTRACT_BYTES_CHANGED'; END IF;
 END LOOP;
 IF jsonb_array_length(document->'original_rake_text_custody'->'rakes') IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_ORIGINAL_RAKE_TEXT_REQUIRED'; END IF;
 original_rake:=document->'original_rake_text_custody'->'rakes'->0;
 UPDATE public.rake_records r
  SET player_contributions=(original_rake->>'player_contributions_text')::jsonb,
      metadata=(original_rake->>'metadata_text')::jsonb
  WHERE r.id=(original_rake->>'id')::uuid
   AND r.tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'
   AND to_jsonb(r)=(original_rake->>'row_text')::jsonb;
 GET DIAGNOSTICS restored_count=ROW_COUNT;
 IF restored_count<>1 THEN RAISE EXCEPTION 'FIRST_ARCHIVE_ORIGINAL_RAKE_CHANGED'; END IF;
 SELECT (SELECT jsonb_object_agg(field,to_jsonb(r)->field ORDER BY field)::text
   FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
    'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
    'rake_method','returned_uncalled']::text[])field)
 INTO STRICT economic_text FROM public.rake_records r WHERE r.id=(original_rake->>'id')::uuid;
 IF economic_text IS DISTINCT FROM original_rake->>'economic_text'
  OR md5(economic_text) IS DISTINCT FROM original_rake->>'fingerprint'
  OR md5(md5(economic_text)) IS DISTINCT FROM original_rake->>'source_fingerprint'
  OR original_rake->>'source_fingerprint' IS DISTINCT FROM 'bfb56dac635bc7a238383d785ea88f35' THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_ORIGINAL_RAKE_BYTES_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_history)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) THEN
  RAISE EXCEPTION 'FIRST_ARCHIVE_MUST_NOT_INVENT_HISTORY'; END IF;
END $restore$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('first_event_restored',true,'history_inserted',false,
 'financial_completion_qualified',false,'trigger_execution_qualified',false);
COMMIT;
