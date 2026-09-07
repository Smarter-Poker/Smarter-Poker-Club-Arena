DO $probe$
DECLARE src text; tbl text; j jsonb;
 old_u uuid:='00000000-0000-4000-8000-000000000001';
 new_u uuid:='00000000-0000-4000-8000-000000000002';
 c uuid:='00000000-0000-4000-8000-000000000003';
 i uuid:='00000000-0000-4000-8000-000000000004';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['unions','clubs','union_clubs','settlement_invoices'] LOOP
  EXECUTE format('CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT * FROM public.%I WITH NO DATA',tbl,tbl);
 END LOOP;
 CREATE TEMP TABLE probe_access(union_id uuid) ON COMMIT DROP;
 EXECUTE $f$CREATE FUNCTION pg_temp.ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM pg_temp.probe_access WHERE union_id=$1)'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.probe_uid() RETURNS uuid LANGUAGE sql AS 'SELECT ''00000000-0000-4000-8000-000000000005''::uuid'$f$;
 SELECT pg_get_functiondef('public.ca_union_statement_board(uuid,date,integer)'::regprocedure) INTO src; src:=replace(replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'auth.uid()','pg_temp.probe_uid()'),'ca_can_oversee_union(','pg_temp.ca_can_oversee_union('); EXECUTE src;
SELECT pg_get_functiondef('public.ca_union_set_statement_paid(uuid,boolean,numeric,text)'::regprocedure) INTO src; src:=replace(replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'auth.uid()','pg_temp.probe_uid()'),'ca_can_oversee_union(','pg_temp.ca_can_oversee_union('); EXECUTE src;
 INSERT INTO pg_temp.unions(id,name) VALUES(old_u,'Original Union'),(new_u,'New Union');
 INSERT INTO pg_temp.clubs(id,name,code,slug) VALUES(c,'Moved Club','1234','moved-club');
 INSERT INTO pg_temp.union_clubs(union_id,club_id) VALUES(new_u,c);
 INSERT INTO pg_temp.settlement_invoices(id,club_id,invoice_type,status,net_amount,message_sent,breakdown,created_at) VALUES
  (i,c,'union_weekly_squareup','generated',100,false,jsonb_build_object('union_id',old_u,'period_start','2026-08-03','period_end','2026-08-10','rake_generated',1000,'union_fee_kept',100,'rakeback_due',900),now());
 INSERT INTO pg_temp.probe_access VALUES(old_u);
 j:=pg_temp.ca_union_statement_board(old_u,NULL,1);
 IF j->>'period_end' IS DISTINCT FROM '2026-08-10' OR jsonb_array_length(j->'clubs')<>1 OR j->'clubs'->0->>'invoice_id' IS DISTINCT FROM i::text THEN RAISE EXCEPTION 'FAIL issuing union loses moved club invoice: %',j; END IF;
 IF j->'clubs'->0->>'snapshot_complete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL complete snapshot not identified'; END IF;
 -- Explicit old periods keep their start even when outside the history limit.
 INSERT INTO pg_temp.settlement_invoices(id,club_id,invoice_type,status,net_amount,message_sent,breakdown,created_at) VALUES
  (gen_random_uuid(),c,'union_weekly_squareup','generated',20,false,jsonb_build_object('union_id',old_u,'period_start','2026-08-10','period_end','2026-08-17'),now()+interval '1 second');
 j:=pg_temp.ca_union_statement_board(old_u,NULL,1);
 IF j->'clubs'->0->>'snapshot_complete' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL absent accounting fields became zero'; END IF;
 j:=pg_temp.ca_union_statement_board(old_u,'2026-08-10',1);
 IF j->>'period_start' IS DISTINCT FROM '2026-08-03' THEN RAISE EXCEPTION 'FAIL history cap loses selected start'; END IF;
 j:=pg_temp.ca_union_set_statement_paid(i,true,50,NULL);
 IF (j->>'paid_total')::numeric<>50 THEN RAISE EXCEPTION 'FAIL issuer cannot acknowledge payment'; END IF;
 UPDATE pg_temp.probe_access SET union_id=new_u;
 j:=pg_temp.ca_union_statement_board(new_u,'2026-08-10',1);
 IF j->'clubs'->0->>'status' IS DISTINCT FROM 'missing' OR jsonb_array_length(j->'history')<>0 THEN RAISE EXCEPTION 'FAIL new union sees old invoice or history: %',j; END IF;
 BEGIN
  PERFORM pg_temp.ca_union_set_statement_paid(i,true,50,NULL);
  RAISE EXCEPTION 'FAIL new union can mark old invoice paid';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: complete and incomplete accounting snapshots identified, actual statement board/payment functions retain invoice under issuing union after club move; new union sees missing invoice without old history and cannot acknowledge old payment; selected start survives history cap. All pg_temp rolled back. Auth helper/identity stubbed; no production invoices changed.';
END;
$probe$;
