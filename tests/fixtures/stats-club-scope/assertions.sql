\set ON_ERROR_STOP on

INSERT INTO public.clubs(id,name,lifecycle_status,asset) VALUES
  ('10000000-0000-0000-0000-000000000001','Own Club','active','chips'),
  ('10000000-0000-0000-0000-000000000002','Other Club','active','chips'),
  ('10000000-0000-0000-0000-000000000003','Retired Club','retired','chips'),
  ('10000000-0000-0000-0000-000000000004','Diamond Club','active','diamonds');
INSERT INTO public.club_members(club_id,user_id,status) VALUES
  ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active'),
  ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','approved'),
  ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','revoked'),
  ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','approved'),
  ('10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','active'),
  ('10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001','active');

INSERT INTO public.tournaments(id,club_id,name,start_time,ended_at,status,variant,buy_in_amount,buy_in_fee)
VALUES
 ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Finished Inside',now()-interval '10 days',now()-interval '1 hour','COMPLETED','nlh',10,1),
 ('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Still Running',now()-interval '1 hour',NULL,'RUNNING','nlh',10,1);
INSERT INTO public.tournament_players(id,tournament_id,user_id,status,position,prize,rebuys,add_on)
VALUES
 ('41000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','finished',2,20,0,false),
 ('41000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','registered',NULL,0,0,false);
INSERT INTO public.ca_hand_facts(
  hand_id,user_id,club_id,tournament_id,played_at,game_variant,big_blind,position,players_dealt,
  invested,returned,net,net_bb,rake_paid,vpip,pfr,saw_flop,aggressive_actions,passive_actions
) VALUES (
  '30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',NULL,now(),'nlh',2,'BTN',6,10,15,5,2.5,0.25,
  true,true,true,2,1
), (
  '30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  now(),'mtt',100,'BB',6,100,0,-100,-1,0,
  true,true,true,1,0
);

CREATE FUNCTION public.fixture_expect_refusal(p_sql text, p_state text DEFAULT '42501')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN RETURN; END IF;
    RAISE EXCEPTION 'expected state %, got %: %',p_state,SQLSTATE,SQLERRM;
  END;
  RAISE EXCEPTION 'expected state %, call succeeded',p_state;
END $$;

-- 751 additional exact rows prove headline totals and daily values are not
-- inherited from the 750-row analysis sample.
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,
  players_dealt,invested,returned,net,net_bb,rake_paid,vpip,pfr)
SELECT ('31000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
 '20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 now()-interval '2 hours','nlh',1,'BTN',6,1,2,1,1,0.01,true,false
FROM generate_series(1,751) g;

INSERT INTO public.hand_history(id,club_id)
SELECT hand_id,club_id FROM public.ca_hand_facts;
INSERT INTO public.ca_hand_player_stat(user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
  big_blind,seat_position,my_blind,won_amt,is_winner,invested_actions,vpip,pfr,profit)
SELECT user_id,hand_id,played_at,tournament_id IS NULL,tournament_id,game_variant,big_blind,position,
  0,returned,net>0,invested,vpip,pfr,net FROM public.ca_hand_facts;
-- A historical reconstructed row intentionally has neither a retained
-- hand_history row nor a settlement fact. All-Clubs must still count it and
-- must describe the mixed money population honestly.
INSERT INTO public.ca_hand_player_stat(user_id,hand_id,created_at,is_cash,game_variant,big_blind,
  seat_position,my_blind,won_amt,is_winner,invested_actions,vpip,pfr,profit,asset)
VALUES ('20000000-0000-0000-0000-000000000001','32000000-0000-0000-0000-000000000001',
  now()-interval '3 hours',true,'nlh',1,'CO',0,3,true,1,true,false,2,'chips');
GRANT EXECUTE ON FUNCTION public.fixture_expect_refusal(text,text) TO authenticated;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);

DO $$ DECLARE v jsonb; BEGIN
  -- A TWO-day window, not one (2026-10-06). The window is whole calendar days
  -- in the caller's zone and every fixture row sits at now() minus one to
  -- three hours, so with a one-day window this assertion failed for any run
  -- between 00:00 and 03:00 Chicago time: the rows were "yesterday" and only
  -- the single now() row was counted. It stopped every pull request for three
  -- hours a night. Two days holds the same rows at every hour; nothing in this
  -- fixture is older than that except the tournament's start, ten days back.
  v:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',2,'America/Chicago','chips');
  IF (v#>>'{overall,total_hands}')::integer<>754 OR (v#>>'{overall,exact_cash_hands}')::integer<>752
     OR v#>>'{quality,cash_money_source}'<>'mixed' OR (v#>>'{quality,cash_money_exact}')::boolean
     OR (v#>>'{coverage,analysis_sample_hands}')::integer<>750
     OR NOT (v#>>'{coverage,analysis_hands_capped}')::boolean
     OR (v#>>'{tournaments,entries}')::integer<>1 THEN
    RAISE EXCEPTION 'All Clubs exact overlay or completed tournament window wrong: %',v;
  END IF;
END $$;
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_shared_overview_v1(
  '20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',30,'UTC','chips')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_shared_overview_v1(
  '20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003',30,'UTC','chips')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_shared_overview_v1(
  '20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004',30,'UTC','chips')$q$);

DO $$ DECLARE v jsonb; BEGIN
  v:=public.ca_player_stats_shared_clubs('20000000-0000-0000-0000-000000000002','chips');
  IF jsonb_array_length(v->'clubs')<>1 OR v#>>'{clubs,0,id}'<>'10000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'shared club discovery wrong: %',v;
  END IF;
  v:=public.ca_player_stats_shared_overview_v1('20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',30,'UTC','chips');
  IF v#>>'{scope,visibility}'<>'shared_club' OR (v->'overview')?'total_profit'
     OR (v->'overview')?'rake' OR v?'hands' THEN
    RAISE EXCEPTION 'shared public aggregate leaked private fields: %',v;
  END IF;
END $$;

DO $$ DECLARE v jsonb; BEGIN
  v:=public.ca_player_stats_overview_v2_by_club(
    '20000000-0000-0000-0000-000000000001',30,'UTC','chips',
    '10000000-0000-0000-0000-000000000001');
  IF v#>>'{scope,club_id}' <> '10000000-0000-0000-0000-000000000001'
     OR (v#>>'{overall,total_profit}')::numeric <> 756
     OR (v#>>'{quality,section_availability,sessions}')::boolean
     OR v#>>'{quality,section_availability,sessions_reason}' <> 'not_captured_in_ca_hand_facts'
     OR v->'sessions' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'authorized own-club payload wrong: %',v;
  END IF;
END $$;

SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club(
  '20000000-0000-0000-0000-000000000001',30,'UTC','chips',
  '10000000-0000-0000-0000-000000000002')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club(
  '20000000-0000-0000-0000-000000000002',30,'UTC','chips',
  '10000000-0000-0000-0000-000000000002')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club(
  '20000000-0000-0000-0000-000000000001',30,'UTC','chips',
  '10000000-0000-0000-0000-000000000003')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club(
  '20000000-0000-0000-0000-000000000001',30,'UTC','chips',
  '10000000-0000-0000-0000-000000000004')$q$);

DO $$ DECLARE v jsonb; BEGIN
  v:=public.ca_player_stats_club_comparison(
    '20000000-0000-0000-0000-000000000001',30,'chips');
  IF jsonb_array_length(v->'rows') <> 1
     OR v#>>'{rows,0,club_id}' <> '10000000-0000-0000-0000-000000000001'
     OR (v#>>'{totals,hands}')::integer <> 753
     OR (v#>>'{totals,cash_hands}')::integer <> 752
     OR (v#>>'{totals,profit}')::numeric <> 756
     OR (v#>>'{totals,vpip}')::numeric <> 1 THEN
    RAISE EXCEPTION 'comparison leaked or mis-totalled: %',v;
  END IF;
END $$;
RESET ROLE;

DO $$ DECLARE b record; BEGIN
  SELECT * INTO b FROM public.ca_stats_calendar_bounds(1,'America/Chicago','2026-03-08 12:00Z');
  IF extract(epoch FROM (b.to_at-b.from_at))/3600<>23 THEN
    RAISE EXCEPTION 'DST spring calendar day was not 23 hours: % / %',b.from_at,b.to_at;
  END IF;
END $$;

-- Newer non-matching rows precede the matching rows. A LIMIT applied before
-- predicates would therefore return an empty/short page and this proof fails.
INSERT INTO public.hand_history(id,pot_size) VALUES
  ('30000000-0000-0000-0000-000000000010',80),
  ('30000000-0000-0000-0000-000000000011',90),
  ('30000000-0000-0000-0000-000000000012',250),
  ('30000000-0000-0000-0000-000000000013',400),
  ('30000000-0000-0000-0000-000000000014',400),
  ('30000000-0000-0000-0000-000000000015',400);
INSERT INTO public.ca_hand_facts(
  hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,
  hand_class,invested,returned,net,net_bb,rake_paid,vpip,pfr,saw_flop,
  went_to_showdown,won_at_showdown,was_all_in,aggressive_actions,passive_actions,hole_cards
) VALUES
  ('30000000-0000-0000-0000-000000000010','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 11:00Z','nlh',2,'BTN',6,'AKo',10,8,-2,-1,0.1,true,true,true,false,false,false,1,1,'[{"rank":"A","suit":"spades"}]'),
  ('30000000-0000-0000-0000-000000000011','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 12:00Z','nlh',2,'BTN',6,'AKo',10,9,-1,-0.5,0.1,true,true,true,false,false,false,1,1,'[{"rank":"A","suit":"hearts"}]'),
  ('30000000-0000-0000-0000-000000000012','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 12:00Z','nlh',2,'BTN',6,'AKo',10,20,10,5,0.2,true,true,true,true,true,true,2,1,'[{"rank":"A","suit":"diamonds"}]'),
  ('30000000-0000-0000-0000-000000000013','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 13:00Z','nlh',5,'BTN',6,'AKo',10,10,0,0,0,true,true,true,false,false,false,1,1,NULL),
  ('30000000-0000-0000-0000-000000000014','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 14:00Z','nlh',2,'CO',6,'AKo',10,10,0,0,0,true,true,true,false,false,false,1,1,NULL),
  ('30000000-0000-0000-0000-000000000015','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-02 15:00Z','plo4',2,'BTN',6,NULL,10,10,0,0,0,true,true,true,false,false,false,1,1,NULL);
INSERT INTO public.ca_hand_notes(user_id,hand_id,note,tags) VALUES
  ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000012','private note',ARRAY['study']);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE p1 jsonb; p2 jsonb; exact jsonb; BEGIN
  p1:=public.ca_player_stats_hand_evidence(
    p_user=>'20000000-0000-0000-0000-000000000001',
    p_club_id=>'10000000-0000-0000-0000-000000000001',p_asset=>'chips',
    p_variant=>'nlh',p_position=>'BTN',p_big_blind=>2,
    p_from=>'2026-10-02 00:00Z',p_to=>'2026-10-03 00:00Z',p_limit=>2);
  IF jsonb_array_length(p1->'hands')<>2 OR NOT (p1->>'has_more')::boolean
     OR p1#>>'{hands,0,hand_id}'<>'30000000-0000-0000-0000-000000000012'
     OR p1#>>'{hands,1,hand_id}'<>'30000000-0000-0000-0000-000000000011'
     OR p1#>>'{next_cursor,hand_id}'<>'30000000-0000-0000-0000-000000000011' THEN
    RAISE EXCEPTION 'filter-before-page or first cursor wrong: %',p1;
  END IF;
  p2:=public.ca_player_stats_hand_evidence(
    p_user=>'20000000-0000-0000-0000-000000000001',
    p_club_id=>'10000000-0000-0000-0000-000000000001',p_asset=>'chips',
    p_variant=>'nlh',p_position=>'BTN',p_big_blind=>2,
    p_from=>'2026-10-02 00:00Z',p_to=>'2026-10-03 00:00Z',
    p_cursor_played_at=>(p1#>>'{next_cursor,played_at}')::timestamptz,
    p_cursor_hand_id=>(p1#>>'{next_cursor,hand_id}')::uuid,p_limit=>2);
  IF jsonb_array_length(p2->'hands')<>1 OR (p2->>'has_more')::boolean
     OR p2#>>'{hands,0,hand_id}'<>'30000000-0000-0000-0000-000000000010'
     OR (p1->'hands') @> (p2->'hands') THEN
    RAISE EXCEPTION 'second cursor duplicated or skipped evidence: % / %',p1,p2;
  END IF;
  exact:=public.ca_player_stats_hand_evidence(
    p_user=>'20000000-0000-0000-0000-000000000001',
    p_club_id=>'10000000-0000-0000-0000-000000000001',p_asset=>'chips',
    p_outcome=>'won',p_showdown=>true,p_all_in=>true,p_big_pots=>true,
    p_noted=>true,p_hand_class=>'AKo',p_limit=>5);
  IF jsonb_array_length(exact->'hands')<>1
     OR exact#>>'{hands,0,hand_id}'<>'30000000-0000-0000-0000-000000000012'
     OR exact#>'{hands,0,own_hole_cards}' IS NULL
     OR (exact->'hands'->0) ? 'note' OR (exact->'hands'->0) ? 'revealed_hole_cards' THEN
    RAISE EXCEPTION 'private evidence predicate or payload wrong: %',exact;
  END IF;
END $$;
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_hand_evidence(
  p_user=>'20000000-0000-0000-0000-000000000001',
  p_club_id=>'10000000-0000-0000-0000-000000000002',p_asset=>'chips')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_hand_evidence(
  p_user=>'20000000-0000-0000-0000-000000000002',
  p_club_id=>'10000000-0000-0000-0000-000000000002',p_asset=>'chips')$q$);
RESET ROLE;

DO $$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)',
    'public.ca_player_hands_v2_by_club(uuid,text,integer,text,uuid)',
    'public.ca_player_stats_pulse_by_club(uuid,text,uuid)',
    'public.ca_player_ev_curve_by_club(uuid,integer,integer,text,uuid)',
    'public.ca_player_hand_grid_by_club(uuid,text,text,integer,text,uuid)',
    'public.ca_player_class_hands_by_club(uuid,text,text,text,integer,integer,text,uuid)',
    'public.ca_player_nemesis_by_club(uuid,integer,integer,integer,text,uuid)',
    'public.ca_player_rake_stats_by_club(uuid,integer,text,uuid)',
    'public.ca_player_stats_club_comparison(uuid,integer,text,text)',
    'public.ca_player_stats_shared_clubs(uuid,text)',
    'public.ca_player_stats_shared_overview_v1(uuid,uuid,integer,text,text)',
    'public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,boolean,boolean,text,boolean,timestamptz,uuid,integer)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN RAISE EXCEPTION 'missing signature %',sig; END IF;
    IF has_function_privilege('anon',sig,'EXECUTE') THEN RAISE EXCEPTION 'anon execute leak %',sig; END IF;
    IF NOT has_function_privilege('authenticated',sig,'EXECUTE') THEN RAISE EXCEPTION 'authenticated lacks execute %',sig; END IF;
  END LOOP;
  IF has_function_privilege('authenticated',
    'public.ca_assert_player_stats_club(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'authorization helper execute leaked';
  END IF;
END $$;

SELECT 'PASS: Stats club-scope migration, authorization, comparison and grants' AS result;
