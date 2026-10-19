DO $$ DECLARE c uuid:='60000000-0000-0000-0000-000000000001'; u uuid:='60000000-0000-0000-0000-000000000002';
 d jsonb; wl jsonb; s jsonb; sn jsonb; sp jsonb; sr jsonb; b record; BEGIN
 SELECT * INTO b FROM mtt_money_baseline;
 d:=ca_club_member_detail(c,u,NULL,NULL)->'stats';
 wl:=ca_club_member_win_loss(c,u)->'overall';
 s:=ca_club_member_statistics(c,u,NULL,NULL,NULL);
 sn:=ca_club_member_statistics(c,u,'nlh',NULL,NULL);
 sp:=ca_club_member_statistics(c,u,'PLO4',NULL,NULL);
 sr:=ca_club_member_statistics(c,u,'all',current_date-1,current_date-1);
 IF (s->>'net')::numeric<>10 OR (s->>'net')::numeric<>(wl->>'net')::numeric
    OR (s->>'net')::numeric<>(d->>'total_winnings')::numeric+(d->>'mtt_winnings')::numeric THEN RAISE EXCEPTION 'Statistics all-games net wrong % %',s->'net',wl; END IF;
 IF (sn->>'net')::numeric<>36 THEN RAISE EXCEPTION 'NLH net wrong %',sn->'net'; END IF;
 IF (sp->>'net')::numeric<>-26 THEN RAISE EXCEPTION 'PLO4 net wrong %',sp->'net'; END IF;
 IF (sr->>'net')::numeric<>-5 THEN RAISE EXCEPTION 'Ranged net wrong %',sr->'net'; END IF;
 IF s->'fees'<>b.s_all->'fees' OR sn->'fees'<>b.s_nlh->'fees' OR s->'hands'<>b.s_all->'hands' OR s->'vpip'<>b.s_all->'vpip'
    OR s->'win_rate'<>b.s_all->'win_rate' OR sn->'hands'<>b.s_nlh->'hands' THEN RAISE EXCEPTION 'Statistics fees/hands/rates changed % %',s,b.s_all; END IF;
END $$;
\echo MEMBER_STATISTICS_NET PASS: statistics net = cash + tournament money (all games, per game, UTC range) = record = Win/Loss; fees/hands/rates unchanged
