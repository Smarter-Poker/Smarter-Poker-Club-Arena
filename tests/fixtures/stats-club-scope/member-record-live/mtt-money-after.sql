DO $$ DECLARE c uuid:='60000000-0000-0000-0000-000000000001'; u uuid:='60000000-0000-0000-0000-000000000002';
 d jsonb; r jsonb; wl jsonb; s jsonb; sn jsonb; sp jsonb; sr jsonb; b record; BEGIN
 SELECT * INTO b FROM mtt_money_baseline;
 d:=ca_club_member_detail(c,u,NULL,NULL)->'stats';
 r:=ca_club_member_detail(c,u,current_date-3,current_date-3)->'stats';
 wl:=ca_club_member_win_loss(c,u)->'overall';
 IF (d->>'mtt_winnings')::numeric<>-5 OR (d->>'mtt_winnings')::numeric<>(wl->>'mtt')::numeric THEN RAISE EXCEPTION 'Record MTT money wrong % %',d,wl; END IF;
 IF (d->>'total_winnings')::numeric<>15 OR (d->>'total_winnings')::numeric<>(wl->>'cash')::numeric THEN RAISE EXCEPTION 'Record cash changed %',d; END IF;
 IF (d->>'mtt_hands')::int<>8 OR (d->>'hands')::int<>6 OR (d->>'total_fee')::numeric<>16.55 THEN RAISE EXCEPTION 'Record hands/fees changed %',d; END IF;
 IF (r->>'mtt_winnings')::numeric<>15 THEN RAISE EXCEPTION 'Record UTC day range wrong %',r; END IF;
 IF (ca_club_member_detail(c,u,current_date-2,current_date-2)#>>'{stats,mtt_winnings}')::numeric<>0 THEN RAISE EXCEPTION 'Empty day not zero'; END IF;
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
 IF (SELECT count(*) FROM pg_index WHERE indisvalid AND indexrelid IN (to_regclass('idx_chip_ledger_tournament_prize_to_player'),to_regclass('idx_chip_ledger_tournament_entry_from_player')))<>2
   THEN RAISE EXCEPTION 'Covering indexes missing'; END IF;
END $$;
-- Both legs are answered from the partial covering indexes alone.
SET enable_seqscan=off; SET enable_bitmapscan=off;
VACUUM (ANALYZE) chip_ledger;
DO $$ DECLARE p text:=''; l text; BEGIN
 FOR l IN EXPLAIN SELECT ca_club_member_tournament_money_plan.* FROM (SELECT 1) x, LATERAL (
   SELECT sum(amount) FROM chip_ledger WHERE club_id='60000000-0000-0000-0000-000000000001' AND to_entity_id='60000000-0000-0000-0000-000000000002'
     AND to_type='player_wallet' AND from_type='prize_liability' AND tournament_id IS NOT NULL AND status='posted'
   UNION ALL
   SELECT sum(amount) FROM chip_ledger WHERE club_id='60000000-0000-0000-0000-000000000001' AND from_entity_id='60000000-0000-0000-0000-000000000002'
     AND from_type='player_wallet' AND to_type='prize_liability' AND tournament_id IS NOT NULL AND status='posted') ca_club_member_tournament_money_plan LOOP p:=p||l||chr(10); END LOOP;
 IF strpos(p,'Index Only Scan using idx_chip_ledger_tournament_prize_to_player')=0 OR strpos(p,'Index Only Scan using idx_chip_ledger_tournament_entry_from_player')=0 THEN
   RAISE EXCEPTION 'Tournament legs not index-only: %',p; END IF;
END $$;
RESET enable_seqscan; RESET enable_bitmapscan;
\echo MEMBER_MTT_MONEY PASS: record MTT = Win/Loss tournament money, statistics net = cash + tournament money (all, per game, UTC range), fees/hands/rates unchanged, index-only legs
