-- Run as ONE Supabase MCP call. AUDIT_TEST_PASS exception is success.
-- Only pg_temp fixtures and functions; all changes roll back.
DO $probe$
<<probe>>
DECLARE
  src text;
  tbl text;
  n integer;
  i integer;
  amount numeric;
  pool uuid := gen_random_uuid();
  felt uuid := gen_random_uuid();
  loser uuid := gen_random_uuid();
  winner uuid := gen_random_uuid();
  ids uuid[];
  paid numeric;
  r record;
  again record;
  cases integer := 0;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['bbj_pools','bbj_mini_tiers','bbj_payouts','bbj_winners',
    'bbj_payout_recipients','hand_history','profiles','ca_payout_freeze'] LOOP
    EXECUTE format('CREATE TEMP TABLE %I (LIKE public.%I INCLUDING DEFAULTS) ON COMMIT DROP',tbl,tbl);
  END LOOP;
  CREATE UNIQUE INDEX ON pg_temp.bbj_payout_recipients(payout_id,user_id);
  CREATE UNIQUE INDEX ON pg_temp.bbj_winners(pool_id,table_id,hand_number);
  EXECUTE $helper$CREATE FUNCTION pg_temp.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)
    RETURNS boolean LANGUAGE plpgsql AS $body$
    BEGIN
      INSERT INTO pg_temp.bbj_payout_recipients(payout_id,user_id,amount)
      SELECT $1,$3,$4 WHERE $4 > 0 ON CONFLICT DO NOTHING;
      RETURN FOUND;
    END $body$ $helper$;
  EXECUTE $helper$CREATE FUNCTION pg_temp.fn_ca_declare_ledger(text,text,uuid,uuid,text,uuid)
    RETURNS void LANGUAGE sql AS 'SELECT' $helper$;
  EXECUTE $helper$CREATE FUNCTION pg_temp.fn_arena_name(text,text,text,text,text,text)
    RETURNS text LANGUAGE sql AS 'SELECT ''Fixture''' $helper$;
  SELECT pg_get_functiondef('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)'::regprocedure) INTO src;
  src := replace(src,'public.','pg_temp.');
  EXECUTE src;
  INSERT INTO pg_temp.bbj_pools(id,backup_balance,mini_reserve_floor) VALUES(pool,1000000,5000);
  INSERT INTO pg_temp.bbj_mini_tiers(tier_id,amount) VALUES('fixture',250);
  FOREACH amount IN ARRAY ARRAY[250,700,2500,0.01,0.03,1.01]::numeric[] LOOP
    FOR n IN 0..8 LOOP
      UPDATE pg_temp.bbj_mini_tiers t SET amount=probe.amount,enabled=true;
      ids := ARRAY[loser,winner];
      FOR i IN 1..n LOOP ids := array_append(ids,gen_random_uuid()); END LOOP;
      -- Duplicates and nulls must not change the eligible recipient set.
      ids := ids || ids || ARRAY[NULL::uuid];
      cases := cases+1;
      SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,cases,'fixture',loser,winner,ids,ids);
      SELECT sum(x.amount) INTO paid FROM pg_temp.bbj_payout_recipients x WHERE x.payout_id=r.payout_id;
      IF NOT r.applied OR paid IS DISTINCT FROM amount OR
         r.loser_share+r.winner_share+r.table_share IS DISTINCT FROM amount THEN
        RAISE EXCEPTION 'FAIL allocation: n=%, amount=%, paid=%, result=%',n,amount,paid,row_to_json(r);
      END IF;
      -- Persisted award is authoritative even if an operator disables its tier.
      UPDATE pg_temp.bbj_mini_tiers SET enabled=false;
      SELECT * INTO again FROM pg_temp.fn_bbj_mini_payout(pool,felt,cases,'fixture',loser,winner,ids,ids);
      IF again.applied OR NOT again.already_paid OR again.payout_id<>r.payout_id OR
         again.per_player_share<>r.per_player_share THEN
        RAISE EXCEPTION 'FAIL replay: %',row_to_json(again);
      END IF;
    END LOOP;
  END LOOP;
  UPDATE pg_temp.bbj_mini_tiers SET amount=250,enabled=true;
  UPDATE pg_temp.bbj_pools SET backup_balance=5249.99;
  SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,9999,'fixture',loser,winner,ids,ids);
  IF r.refused IS DISTINCT FROM 'reserve_at_floor' OR r.applied THEN RAISE EXCEPTION 'FAIL floor'; END IF;
  UPDATE pg_temp.bbj_pools SET backup_balance=5250;
  SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,9999,'fixture',loser,winner,ids,ids);
  IF NOT r.applied OR r.backup_after<>5000 THEN RAISE EXCEPTION 'FAIL exact floor'; END IF;
  BEGIN
    PERFORM * FROM pg_temp.fn_bbj_mini_payout(pool,felt,10000,'fixture',loser,loser,ids,ids);
    RAISE EXCEPTION 'FAIL identical recipients accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE EXCEPTION 'AUDIT_TEST_PASS: % allocation cases; replay after disable; duplicate and null recipients; reserve boundaries; invalid identities. All fixtures rolled back. Recipient helper stubbed; no live funds moved.',cases;
END;
$probe$;