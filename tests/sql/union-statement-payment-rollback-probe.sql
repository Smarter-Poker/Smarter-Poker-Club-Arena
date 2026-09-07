DO $probe$
DECLARE src text; j jsonb; bad numeric; before_state jsonb;
 i uuid:='00000000-0000-4000-8000-000000000001';
 c uuid:='00000000-0000-4000-8000-000000000002';
 u uuid:='00000000-0000-4000-8000-000000000003';
BEGIN
 CREATE TEMP TABLE settlement_invoices(id uuid,club_id uuid,invoice_type text,status text,net_amount numeric,breakdown jsonb,updated_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE union_clubs(club_id uuid,union_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE probe_access(allowed boolean) ON COMMIT DROP;
 INSERT INTO pg_temp.probe_access VALUES(true);
 EXECUTE $f$CREATE FUNCTION pg_temp.probe_uid() RETURNS uuid LANGUAGE sql AS 'SELECT ''00000000-0000-4000-8000-000000000004''::uuid'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT allowed FROM pg_temp.probe_access'$f$;
 SELECT pg_get_functiondef('public.ca_union_set_statement_paid(uuid,boolean,numeric,text)'::regprocedure) INTO src;
 src:=replace(replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'auth.uid()','pg_temp.probe_uid()'),'NOT ca_can_oversee_union(','NOT pg_temp.ca_can_oversee_union('); EXECUTE src;
 INSERT INTO pg_temp.union_clubs VALUES(c,u);
 INSERT INTO pg_temp.settlement_invoices VALUES(i,c,'union_weekly_squareup','generated',100,'{}',now());
 j:=pg_temp.ca_union_set_statement_paid(i,true,99.99,'first payment');
 IF j->>'status'='paid' OR (j->>'paid_total')::numeric<>99.99 THEN RAISE EXCEPTION 'FAIL one cent short marked paid: %',j; END IF;
 j:=pg_temp.ca_union_set_statement_paid(i,true,0.01,'last cent');
 IF j->>'fully_settled' IS DISTINCT FROM 'true' OR (j->>'paid_total')::numeric<>100 THEN RAISE EXCEPTION 'FAIL exact completion'; END IF;
 SELECT breakdown INTO before_state FROM pg_temp.settlement_invoices WHERE id=i;
 j:=pg_temp.ca_union_set_statement_paid(i,true,NULL,NULL);
 IF j->>'already_settled' IS DISTINCT FROM 'true' OR (SELECT breakdown FROM pg_temp.settlement_invoices WHERE id=i)<>before_state THEN RAISE EXCEPTION 'FAIL repeated full settlement mutated history'; END IF;
 j:=pg_temp.ca_union_set_statement_paid(i,false,NULL,'reopen');
 IF (j->>'paid_total')::numeric<>0 OR j->>'status'<>'generated' OR jsonb_array_length((SELECT breakdown->'payments' FROM pg_temp.settlement_invoices WHERE id=i))<>3 THEN RAISE EXCEPTION 'FAIL reversal history'; END IF;
 UPDATE pg_temp.settlement_invoices SET net_amount=-100 WHERE id=i;
 j:=pg_temp.ca_union_set_statement_paid(i,true,99.99,NULL);
 IF j->>'fully_settled'='true' THEN RAISE EXCEPTION 'FAIL outgoing direction one cent short'; END IF;
 j:=pg_temp.ca_union_set_statement_paid(i,true,NULL,NULL);
 IF (j->>'paid_total')::numeric<>100 OR j->>'fully_settled'<>'true' THEN RAISE EXCEPTION 'FAIL settle remaining'; END IF;
 FOREACH bad IN ARRAY ARRAY[0::numeric,-1,0.001,'NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric] LOOP
  SELECT breakdown INTO before_state FROM pg_temp.settlement_invoices WHERE id=i;
  BEGIN
   PERFORM pg_temp.ca_union_set_statement_paid(i,true,bad,NULL);
   RAISE EXCEPTION 'FAIL invalid amount accepted: %',bad;
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF (SELECT breakdown FROM pg_temp.settlement_invoices WHERE id=i)<>before_state THEN RAISE EXCEPTION 'FAIL rejected payment changed record'; END IF;
 END LOOP;
 BEGIN
  PERFORM pg_temp.ca_union_set_statement_paid(i,NULL,NULL,NULL);
  RAISE EXCEPTION 'FAIL null action reopened invoice';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 UPDATE pg_temp.probe_access SET allowed=false;
 BEGIN
  PERFORM pg_temp.ca_union_set_statement_paid(i,true,NULL,NULL);
  RAISE EXCEPTION 'FAIL unauthorized';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: actual payment function, exact last cent in both directions, remainder settlement, full-settlement replay, reversal history, invalid numeric rejection with no mutation, null action and denied authorization. All pg_temp rolled back. Auth identity and membership gate stubbed; no actual payments or concurrent sessions.';
END;
$probe$;
