DO $$ DECLARE c uuid:='60000000-0000-0000-0000-000000000001'; u uuid:='60000000-0000-0000-0000-000000000002'; s jsonb; b record;
BEGIN
 SELECT * INTO b FROM variant_fee_baseline;
 s:=ca_club_member_statistics(c,u,'NLH','2026-10-26','2026-10-29');
 IF (s->>'fees')::numeric<>(b.variant->>'fees')::numeric+8 THEN
   RAISE EXCEPTION 'Variant tournament fee receipts missing: %',s->'fees'; END IF;
 IF s-'fees' IS DISTINCT FROM b.variant-'fees' THEN RAISE EXCEPTION 'Variant non-fee fields changed'; END IF;
 IF ca_club_member_statistics(c,u,NULL,NULL,NULL) IS DISTINCT FROM b.all_games
 OR ca_club_member_statistics(c,u,'all',NULL,NULL) IS DISTINCT FROM b.all_games THEN RAISE EXCEPTION 'All-games fee contract changed'; END IF;
 IF (ca_club_member_statistics(c,u,'nlh','2026-10-27','2026-10-27')->>'fees')::numeric<>4
 OR (ca_club_member_statistics(c,u,'plo4','2026-10-26','2026-10-29')->>'fees')::numeric<>6
 OR (ca_club_member_statistics(c,u,'missing','2026-10-26','2026-10-29')->>'fees')::numeric<>0 THEN
   RAISE EXCEPTION 'Variant/date isolation failed'; END IF;
 -- The fixed counting floor excludes the old 100 receipt even for Overall.
 IF (ca_club_member_statistics(c,u,'nlh',NULL,NULL)->>'fees')::numeric<>211 THEN
   RAISE EXCEPTION 'Counting-floor or cash-rake preservation failed'; END IF;
 PERFORM set_config('test.access','none',true);
 IF ca_club_member_statistics(c,u,'nlh',NULL,NULL)->>'authorized'<>'false' THEN
   RAISE EXCEPTION 'Variant receipts bypassed authorization'; END IF;
END $$;
\echo MEMBER_VARIANT_FEES PASS: receipt inclusion, variants, inclusive UTC dates, counting floor, cash rake, access and unchanged other fields
