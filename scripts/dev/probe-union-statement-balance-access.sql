-- One MCP call; AUDIT_TEST_PASS exception is success, all pg_temp fixtures roll back.
DO $probe$
DECLARE
  src text;
  u uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  total numeric; n integer; vals numeric[];
BEGIN
  CREATE TEMP TABLE settlement_invoices(id uuid DEFAULT gen_random_uuid(),created_at timestamptz,
    invoice_type text,invoice_number text,breakdown jsonb,from_entity_type text,net_amount numeric,
    status text,club_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE union_presettlements(id uuid DEFAULT gen_random_uuid(),received_at timestamptz,
    reference text,method text,applied_settlement_id uuid,amount numeric,union_id uuid,club_id uuid) ON COMMIT DROP;
  EXECUTE $fn$CREATE FUNCTION pg_temp.ca_can_view_club_finances(uuid) RETURNS boolean
    LANGUAGE sql STABLE AS 'SELECT current_setting(''audit.club_access'',true) = ''yes'''$fn$;
  EXECUTE $fn$CREATE FUNCTION pg_temp.ca_can_oversee_union(uuid) RETURNS boolean
    LANGUAGE sql STABLE AS 'SELECT current_setting(''audit.union_access'',true) = ''yes'''$fn$;
  EXECUTE $fn$CREATE FUNCTION pg_temp.fn_is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE AS 'SELECT current_setting(''audit.admin_access'',true) = ''yes'''$fn$;
  SELECT pg_get_functiondef('public.fn_union_club_statement_of_account(uuid,uuid,timestamptz)'::regprocedure) INTO src;
  src := replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp''');
  EXECUTE src;
  INSERT INTO pg_temp.settlement_invoices(created_at,invoice_type,invoice_number,breakdown,from_entity_type,net_amount,status,club_id)
    VALUES('2026-01-01Z','union_weekly_squareup','A',jsonb_build_object('union_id',u),'club',100,'generated',c),
          ('2026-01-03Z','union_weekly_squareup','B',jsonb_build_object('union_id',u),'club',50,'generated',c),
          ('2026-01-04Z','union_weekly_credit_note','C',jsonb_build_object('union_id',u),'union',10,'generated',c);
  INSERT INTO pg_temp.union_presettlements(received_at,reference,amount,union_id,club_id)
    VALUES('2026-01-02Z','P1',20,u,c),('2026-01-05Z','P2',30,u,c);
  PERFORM set_config('audit.club_access','yes',true);
  SELECT array_agg(running_balance ORDER BY entry_at) INTO vals
    FROM pg_temp.fn_union_club_statement_of_account(u,c,'2026-01-03Z');
  IF vals IS DISTINCT FROM ARRAY[130,120,90]::numeric[] THEN
    RAISE EXCEPTION 'FAIL opening balance: expected [130,120,90], received %',vals;
  END IF;
  SELECT count(*),sum(amount) INTO n,total FROM pg_temp.fn_union_club_statement_of_account(u,c,NULL);
  IF n<>5 OR total<>90 THEN RAISE EXCEPTION 'FAIL complete history'; END IF;
  PERFORM set_config('audit.club_access','no',true);
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(u,c,NULL);
  IF n<>0 THEN RAISE EXCEPTION 'FAIL unauthorized caller sees % entries',n; END IF;
  PERFORM set_config('audit.union_access','yes',true);
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(u,c,NULL);
  IF n<>5 THEN RAISE EXCEPTION 'FAIL union permission'; END IF;
  PERFORM set_config('audit.union_access','no',true);
  PERFORM set_config('audit.admin_access','yes',true);
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(u,c,NULL);
  IF n<>5 THEN RAISE EXCEPTION 'FAIL platform permission'; END IF;
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(gen_random_uuid(),c,NULL);
  IF n<>0 THEN RAISE EXCEPTION 'FAIL cross-union row mixing'; END IF;
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(u,gen_random_uuid(),NULL);
  IF n<>0 THEN RAISE EXCEPTION 'FAIL cross-club row mixing'; END IF;
  SELECT count(*) INTO n FROM pg_temp.fn_union_club_statement_of_account(u,c,'2027-01-01Z');
  IF n<>0 THEN RAISE EXCEPTION 'FAIL empty range'; END IF;
  RAISE EXCEPTION 'AUDIT_TEST_PASS: opening balance, full history, credit direction, date boundary, denied access, club/union/platform permissions, tenant row separation and empty range. All fixtures rolled back; permission helpers stubbed.';
END;
$probe$;