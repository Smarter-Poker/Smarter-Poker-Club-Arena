-- Source-only logical fixture restore. Run INSIDE the existing allocation's
-- separate disposable database AFTER authentic schema prefix/principals,
-- BEFORE its first real trigger is attached. Never apply to a populated/live DB.
-- This inserts the captured terminal receipt unchanged, not a made-up receipt.
-- Restore the actual trigger/access/policy/supplement closure before consumer.
-- The starting snapshot is committed only in that disposable database. Never
-- DELETE-clean immutable receipts or reuse this estate for the funded fixture.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
SELECT set_config('spin_retention_fixture.execution', :'execution_uuid', true);
\ir completed-start-input.sql
DO $restore$
DECLARE p jsonb; item jsonb; n text; row_json jsonb; cols text; actual jsonb;
 v_fk jsonb; expected_fk jsonb; v_count integer; r record; relation_count integer:=0; occupied boolean;
BEGIN
 SELECT value INTO STRICT p FROM retention_completed_capture;
 IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
  OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
  OR current_setting('spin_retention_fixture.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR current_setting('spin_retention_fixture.execution') IS DISTINCT FROM current_setting('qualification.execution_uuid',true)
  OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('session_replication_role')<>'origin'
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres' AND NOT rolsuper)
  OR jsonb_array_length(p->'tournament')<>1 OR jsonb_array_length(p->'terminal_receipts')<>1
  OR jsonb_array_length(p->'tables')<>1 OR jsonb_array_length(p->'clubs')<>1
  OR p->'unions'<>'[]'::jsonb OR p->>'transaction_read_only'<>'on'
  OR p->>'transaction_isolation'<>'repeatable read' THEN
  RAISE EXCEPTION 'retention completed restore: exact isolated pre-trigger boundary refused'; END IF;
 -- No existing business rows in the four imported relations. Source parent
 -- admin identity already exists in the provider; no captured player auth row
 -- is required by the receipt's real FK, and none is imported.
 FOREACH n IN ARRAY ARRAY['clubs','tournaments','tables','tournament_terminal_settlements'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',n) INTO v_count;
  IF v_count<>0 THEN RAISE EXCEPTION 'retention completed restore: existing rows in %',n; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(p->'clubs'->0->>'owner_id')::uuid
   AND is_horse IS FALSE) OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=(p->'clubs'->0->>'owner_id')::uuid)
 OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0 OR diamond_balance IS DISTINCT FROM 0) THEN
  RAISE EXCEPTION 'retention completed restore: existing zero principal closure differs'; END IF;
 -- Only the existing isolated principals may precede this logical restore.
 -- Establish this before inserting any snapshot row, including financial
 -- relations that are deliberately not part of this narrow receipt fixture.
 FOR r IN SELECT c.relname,ns.nspname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE c.relkind IN('r','p') AND ns.nspname IN('auth','public','smarter_private')
   AND NOT (ns.nspname='auth' AND c.relname='users')
   AND NOT (ns.nspname='public' AND c.relname='profiles') ORDER BY ns.nspname,c.relname LOOP
  relation_count:=relation_count+1;
  IF relation_count>400 THEN RAISE EXCEPTION 'retention completed restore: relation bound exceeded'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I)',r.nspname,r.relname) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'retention completed restore: contaminated starting relation %.%',r.nspname,r.relname; END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('schema',ns.nspname,'relation',c.relname,'name',k.conname,
  'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,
  'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY ns.nspname,c.relname,k.conname)
 INTO v_fk FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
 WHERE k.contype='f' AND ((ns.nspname='public' AND c.relname IN('tournaments','tournament_terminal_settlements','tables','clubs','unions','profiles'))
  OR (ns.nspname='auth' AND c.relname='users'));
 expected_fk:=p->'foreign_keys';
 IF v_fk IS DISTINCT FROM expected_fk THEN RAISE EXCEPTION 'retention completed restore: captured FK closure drift'; END IF;
 -- Names are deliberately synthetic. Uncaptured administrative/default fields
 -- are provider defaults, not purported historical rows. In contrast, every
 -- captured terminal receipt field/value/identity is inserted unchanged.
 FOR n,item IN SELECT * FROM (VALUES
  ('clubs',p->'clubs'->0),('tournaments',p->'tournament'->0),
  ('tables',p->'tables'->0),('tournament_terminal_settlements',p->'terminal_receipts'->0)) q(n,item) LOOP
  row_json:=item-'source_row_md5';
  IF n<>'tournament_terminal_settlements' THEN
   row_json:=row_json||jsonb_build_object('name','Captured completed Spin retention fixture');
  END IF;
  IF n='clubs' THEN
   -- These uncaptured, unused balances are synthetic zero fixture input,
   -- not historical money authority. Do not inherit the provider's 100000
   -- treasury default or generate a financial success/journal for this setup.
   row_json:=row_json||jsonb_build_object('chip_treasury',0,'chip_pool',0,
    'promo_balance',0,'insurance_balance',0,'total_rake',0);
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(row_json) key WHERE NOT EXISTS(
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=('public.'||n)::regclass
      AND a.attname=key AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity='')) THEN
   RAISE EXCEPTION 'retention completed restore: unsupported captured column in %',n; END IF;
  SELECT string_agg(format('%I',key),',' ORDER BY key) INTO cols FROM jsonb_object_keys(row_json) key;
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1)',n,cols,cols,n) USING row_json;
  EXECUTE format('SELECT to_jsonb(x) FROM public.%I x',n) INTO STRICT actual;
  IF n='tournament_terminal_settlements' AND actual IS DISTINCT FROM item THEN
   RAISE EXCEPTION 'retention completed restore: canonical captured receipt changed';
  ELSIF n<>'tournament_terminal_settlements' AND EXISTS(
   SELECT 1 FROM jsonb_each(item-'source_row_md5') x WHERE actual->x.key IS DISTINCT FROM x.value) THEN
   RAISE EXCEPTION 'retention completed restore: captured parent projection changed for %',n;
  END IF;
 END LOOP;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF (SELECT to_jsonb(x) FROM public.tournament_terminal_settlements x) IS DISTINCT FROM p->'terminal_receipts'->0
  OR EXISTS(SELECT 1 FROM public.clubs WHERE chip_treasury IS DISTINCT FROM 0 OR chip_pool IS DISTINCT FROM 0
    OR promo_balance IS DISTINCT FROM 0 OR insurance_balance IS DISTINCT FROM 0 OR total_rake IS DISTINCT FROM 0)
  OR EXISTS(SELECT 1 FROM public.wallet_transactions) OR EXISTS(SELECT 1 FROM public.chip_ledger)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts) OR EXISTS(SELECT 1 FROM public.tournament_obligations)
  OR EXISTS(SELECT 1 FROM public.tournament_players) OR EXISTS(SELECT 1 FROM public.table_seats)
  OR EXISTS(SELECT 1 FROM public.tournament_escrow) THEN
  RAISE EXCEPTION 'retention completed restore: receipt/zero ancillary estate differs'; END IF;
END $restore$;
COMMIT;
