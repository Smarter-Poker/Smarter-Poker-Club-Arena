BEGIN;
TRUNCATE public.ca_hand_facts;
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,
 invested,returned,net,net_bb,vpip,pfr,three_bet,three_bet_opportunity)
VALUES
 ('90000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now(),'nlh',1,'BTN',2,1,11,10,10,true,true,true,true),
 ('90000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now(),'nlh',100,'BTN',2,200,100,-100,-1,false,false,false,true),
 ('90000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004',now(),'nlh',1,'BTN',2,1,0,-1,-1,false,false,false,true),
 ('90000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004',now(),'nlh',1,'BTN',2,1,0,-1,-1,false,false,false,true);
TRUNCATE public.ca_hand_player_stat;
INSERT INTO public.ca_hand_player_stat(hand_id,user_id,created_at,is_cash,tournament_id,game_variant,
 big_blind,seat_position,my_blind,won_amt,is_winner,invested_actions,vpip,pfr,profit,asset,three_bet,three_bet_opp)
SELECT md5(f.hand_id::text||':'||g::text)::uuid,f.user_id,f.played_at,true,NULL,f.game_variant,f.big_blind,f.position,0,f.returned,
 f.returned>0,f.invested,f.vpip,f.pfr,f.net,c.asset,f.three_bet,f.three_bet_opportunity
FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id CROSS JOIN generate_series(1,500) g;
SELECT public.ca_refresh_stat_distribution(1000);
DO $$ BEGIN
 IF (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:chips' AND metric='bb100')<>450
 OR (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:diamonds' AND metric='bb100')<>-100
 OR (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:chips' AND metric='vpip')<>50
 OR (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:chips' AND metric='win_rate')<>100
 OR (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:chips' AND metric='three_bet')<>50
 OR (SELECT sample_size FROM public.ca_stat_distribution WHERE cohort='field:chips' AND metric='bb100')<>1
 THEN RAISE EXCEPTION 'Exact asset cohort calculation wrong'; END IF;
 IF has_function_privilege('authenticated','public.ca_refresh_stat_distribution(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Snapshot writer exposed to browser'; END IF;
END $$;
SELECT public.ca_refresh_stat_distribution(1001);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.ca_stat_distribution WHERE cohort IN ('field','field:chips','field:diamonds'))
 THEN RAISE EXCEPTION 'Empty cohort retained stale comparisons'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: mixed-stake BB/100, weighted rates, pot awards, separate assets, empty cohorts and writer ACL' result;
