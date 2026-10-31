DO $$ DECLARE r record; f text; BEGIN
 FOREACH f IN ARRAY ARRAY['ca_hand_player_facts_one','ca_hand_player_facts_range'] LOOP
  EXECUTE format('SELECT * FROM public.%I($1,$2)',f) INTO r USING
   '92000000-0000-0000-0000-000000000001'::uuid,'20000000-0000-0000-0000-000000000001'::uuid;
  IF r.pfr OR r.aggro_cnt<>0 OR r.call_cnt<>1 OR r.amount_sum<>20
  THEN RAISE EXCEPTION 'All-in call/amount preservation failed in %: %',f,to_jsonb(r); END IF;
 END LOOP;
END $$;
SELECT 'PASS: both action reader operators distinguish all-in calls without changing amounts' result;
