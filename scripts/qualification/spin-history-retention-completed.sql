-- SOURCE ONLY / UNRUN. Actual pruner on an authentic captured terminal receipt
-- and a synthetic late history projection. This does not execute or certify
-- the terminal financial lifecycle, gameplay, or historical payment sidecars.
-- The existing runner must dispose of this whole logical-fixture database;
-- do not DELETE-clean the immutable receipt or enter the funded fixture here.
\set ON_ERROR_STOP on
SET timezone='UTC';
SELECT set_config('spin_retention_fixture.execution', :'execution_uuid', false);
\ir fixtures/spin-history-retention/completed-start-input.sql
DO $boundary$
DECLARE p jsonb; item jsonb; actual jsonb; n text; v_count integer;
BEGIN
 SELECT value INTO STRICT p FROM retention_completed_capture;
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
  OR current_setting('spin_retention_fixture.execution') IS DISTINCT FROM current_setting('qualification.execution_uuid',true)
  OR current_setting('spin_retention_fixture.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR md5(pg_get_functiondef(to_regprocedure('public.sp_prune_hand_history(integer)')))
     IS DISTINCT FROM '03f156a50f882354f7d09f30fe08afd2'
  OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_insert_hand_with_awards(jsonb,jsonb)')))
     IS DISTINCT FROM 'e7f05bb7d61360be7424c5f429066047'
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.hand_history'::regclass AND NOT tgisinternal)<>8
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_history'::regclass AND NOT tgisinternal AND tgenabled<>'O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_terminal_settlements'::regclass
     AND NOT tgisinternal AND tgenabled='O' AND tgtype=27
     AND md5(pg_get_functiondef(tgfoid))='618843a6d0646709dac2a9c3b24a7652') THEN
  RAISE EXCEPTION 'retention completed: actual isolated authority/trigger boundary refused'; END IF;
 -- Exact source input and parent projection, including every captured receipt
 -- field. The parent rows are narrow logical-fixture projections, not claimed
 -- byte-identical historical rows; their source_row_md5 is provenance only.
 FOR n,item IN SELECT * FROM (VALUES
  ('clubs',p->'clubs'->0),('tournaments',p->'tournament'->0),
  ('tables',p->'tables'->0),('tournament_terminal_settlements',p->'terminal_receipts'->0)) q(n,item) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',n) INTO v_count;
  IF v_count<>1 THEN RAISE EXCEPTION 'retention completed: expected one source row in %',n; END IF;
  EXECUTE format('SELECT to_jsonb(x) FROM public.%I x',n) INTO STRICT actual;
  IF n='tournament_terminal_settlements' AND actual IS DISTINCT FROM item THEN
   RAISE EXCEPTION 'retention completed: original canonical receipt differs';
  ELSIF n<>'tournament_terminal_settlements' AND EXISTS(
   SELECT 1 FROM jsonb_each(item-'source_row_md5') x WHERE actual->x.key IS DISTINCT FROM x.value) THEN
   RAISE EXCEPTION 'retention completed: captured parent projection differs for %',n;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.clubs WHERE chip_treasury IS DISTINCT FROM 0 OR chip_pool IS DISTINCT FROM 0
   OR promo_balance IS DISTINCT FROM 0 OR insurance_balance IS DISTINCT FROM 0 OR total_rake IS DISTINCT FROM 0) THEN
  RAISE EXCEPTION 'retention completed: synthetic zero club starting balances differ'; END IF;
 FOREACH n IN ARRAY ARRAY['hand_history','hand_atomic_commits','settlement_idempotency_keys',
   'hand_projection_outbox','tournament_knockout_candidates','tournament_cancellation_receipts',
   'tournament_players','table_seats','tournament_escrow','tournament_payouts',
   'tournament_obligations','wallet_transactions','chip_ledger','chip_transactions','ca_mint_ledger'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',n) INTO v_count;
  IF v_count<>0 THEN RAISE EXCEPTION 'retention completed: unexpected ancillary rows in %',n; END IF;
 END LOOP;
END $boundary$;
\ir fixtures/spin-history-retention/database-state.sql
CREATE TEMP TABLE retention_completed_initial AS SELECT
 pg_temp.retention_database_state() row_state,pg_temp.retention_catalog_state() catalog_state,
 pg_temp.retention_sequence_state() sequences;
BEGIN;
\ir fixtures/spin-history-retention/component-inputs.sql
CREATE TEMP TABLE retention_completed_inputs AS SELECT
 :'execution_uuid'::uuid execution, :'ordinary_user_uuid'::uuid horse,
 extensions.uuid_generate_v5(:'execution_uuid'::uuid,'retention-authentic-completed-late-history') hand_id;
\ir fixtures/spin-history-retention/social-alias-reference.sql
DO $projection$
DECLARE q record; p jsonb; returned uuid;
BEGIN
 SELECT * INTO STRICT q FROM retention_completed_inputs;
 SELECT value INTO STRICT p FROM retention_completed_capture;
 IF (SELECT count(DISTINCT id) FROM unnest(ARRAY[q.execution,q.horse,q.hand_id,
      (p->'tournament'->0->>'id')::uuid,(p->'tables'->0->>'id')::uuid,
      (p->'clubs'->0->>'id')::uuid,(p->'clubs'->0->>'owner_id')::uuid]) id)<>7
  OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=q.horse AND is_horse IS FALSE)
  OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0 OR diamond_balance IS DISTINCT FROM 0) THEN
  RAISE EXCEPTION 'retention completed: distinct zero synthetic principal required'; END IF;
 UPDATE public.profiles SET is_horse=true WHERE id=q.horse;
 IF (SELECT count(*) FROM public.content_authors WHERE profile_id=q.horse
     AND is_active IS TRUE AND personality->>'seeded_by'='fn_socialize_horse')<>1
  OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=q.horse AND is_horse IS TRUE
     AND social_profile_completed IS TRUE) THEN
  RAISE EXCEPTION 'retention completed: real horse social trigger differs'; END IF;
 returned:=public.fn_ca_insert_hand_with_awards(jsonb_build_object(
  'id',q.hand_id,'table_id',p->'tables'->0->>'id','tournament_id',p->'tournament'->0->>'id',
  'hand_number',987000101,'created_at',transaction_timestamp()-interval '8 days',
  'started_at',transaction_timestamp()-interval '8 days','ended_at',transaction_timestamp()-interval '8 days',
  'game_variant',p->'tables'->0->>'game_variant','small_blind',145,'big_blind',290,
  'pot_size',0,'rake_amount',0,'bbj_amount',0,
  'players',jsonb_build_array(jsonb_build_object('userId',q.horse,'seat',1,'startStack',0,'endStack',0)),
  'winners','[]'::jsonb,'actions','[]'::jsonb,'reported',false,'has_human',false,
  'source','retention_qualification_projection',
  'summary','Synthetic late zero-money projection against captured completed receipt; no accepted hand settlement'),
  '[]'::jsonb);
 IF returned IS DISTINCT FROM q.hand_id OR (SELECT count(*) FROM public.hand_history)<>1
  OR NOT EXISTS(SELECT 1 FROM public.hand_history WHERE id=q.hand_id
    AND table_id=(p->'tables'->0->>'id')::uuid
    AND tournament_id=(p->'tournament'->0->>'id')::uuid
    AND created_at<transaction_timestamp()-interval '7 days' AND rake_amount=0 AND bbj_amount=0)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys)
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE state='pending')
  OR EXISTS(SELECT 1 FROM public.wallet_transactions) OR EXISTS(SELECT 1 FROM public.chip_ledger)
  OR EXISTS(SELECT 1 FROM public.chip_transactions) OR EXISTS(SELECT 1 FROM public.ca_mint_ledger)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts) OR EXISTS(SELECT 1 FROM public.tournament_obligations)
  OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0 OR diamond_balance IS DISTINCT FROM 0)
  OR EXISTS(SELECT 1 FROM public.clubs WHERE chip_treasury IS DISTINCT FROM 0 OR chip_pool IS DISTINCT FROM 0
    OR promo_balance IS DISTINCT FROM 0 OR insurance_balance IS DISTINCT FROM 0 OR total_rake IS DISTINCT FROM 0)
  OR (SELECT to_jsonb(x) FROM public.tournament_terminal_settlements x) IS DISTINCT FROM p->'terminal_receipts'->0 THEN
  RAISE EXCEPTION 'retention completed: actual projection/unchanged receipt differs'; END IF;
END $projection$;
SET CONSTRAINTS ALL IMMEDIATE;
DO $pruner$
DECLARE original_rows jsonb:=pg_temp.retention_database_state();
 original_catalog jsonb:=pg_temp.retention_catalog_state(); expected_rows jsonb;
 forward_sql text; rollback_sql text; projected uuid; image integer; removed integer; asserted boolean;
BEGIN
 SELECT s.forward_sql,s.rollback_sql INTO STRICT forward_sql,rollback_sql FROM spin_history_retention_source s;
 SELECT hand_id INTO STRICT projected FROM retention_completed_inputs;
 expected_rows:=pg_temp.retention_database_state(ARRAY[projected]);
 FOR image IN 1..2 LOOP
  asserted:=false;
  BEGIN
   IF image=1 THEN EXECUTE rollback_sql; ELSE EXECUTE forward_sql; END IF;
   removed:=public.sp_prune_hand_history(1);
   IF removed IS DISTINCT FROM 1 OR pg_temp.retention_database_state() IS DISTINCT FROM expected_rows THEN
    RAISE EXCEPTION 'retention completed: actual deletion/unchanged full estate differs for image %',image; END IF;
   asserted:=true;
   RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='rollback completed eligibility pruner image';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN IF NOT asserted THEN RAISE; END IF;
  END;
  IF pg_temp.retention_database_state() IS DISTINCT FROM original_rows
   OR pg_temp.retention_catalog_state() IS DISTINCT FROM original_catalog THEN
   RAISE EXCEPTION 'retention completed: image rollback differs'; END IF;
 END LOOP;
END $pruner$;
ROLLBACK;
DO $restored$
BEGIN
 IF pg_temp.retention_database_state() IS DISTINCT FROM (SELECT row_state FROM retention_completed_initial)
  OR pg_temp.retention_catalog_state() IS DISTINCT FROM (SELECT catalog_state FROM retention_completed_initial) THEN
  RAISE EXCEPTION 'retention completed: actual projection/pruner rollback differs'; END IF;
END $restored$;
SELECT jsonb_build_object('qualification','spin_history_retention_completed_receipt_eligibility',
 'old_deleted',1,'candidate_deleted',1,'captured_receipt_unchanged',true,
 'projection_and_catalog_rollback_verified',true,'starting_estate_retained_until_database_disposal',true,
 'terminal_creation_qualified',false,'financial_lifecycle_qualified',false,'multi_session_race_qualified',false,
 'source_capture_observed_at',(SELECT value->>'observed_at' FROM retention_completed_capture),
 'sequence_counters_restored',false,'sequence_before',(SELECT sequences FROM retention_completed_initial),
 'sequence_after',pg_temp.retention_sequence_state()) AS qualification;
