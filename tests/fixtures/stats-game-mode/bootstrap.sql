-- Isolated PostgreSQL fixture only. Never run these writes on production.
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS hand_number integer;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS community_cards2 text[];
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS community_cards3 text[];
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS rit_boards jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS players jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS winners jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS winners_by_board jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS game_variant text;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS small_blind numeric;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS rake_amount numeric;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS bbj_amount numeric;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS button_seat smallint;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS hole_cards jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS showdown jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS pots jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS bomb_pot jsonb;
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS kill_pot jsonb;
CREATE FUNCTION public.fn_poker_arena_context(p_club text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('member',EXISTS(SELECT 1 FROM public.club_members WHERE club_id=p_club::uuid AND user_id=auth.uid() AND status IN ('active','approved')))
$$;
-- Ordinary NLH is used in both modes. Distinct values make contamination visible.
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,big_blind,position,players_dealt,invested,returned,net,net_bb,vpip,pfr,hand_class,went_to_showdown)
VALUES
 ('99000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001',NULL,now(),'nlh',2,'BTN',2,10,15,5,2.5,false,false,'AA',true),
 ('99000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000001',now(),'nlh',100,'BB',2,2000,12000,10000,100,true,true,'AA',true);
INSERT INTO public.hand_history(id,created_at,started_at,ended_at,table_id,tournament_id,hand_number,game_variant,players,actions,pot_size,big_blind)
SELECT hand_id,played_at,played_at-interval '1minute',played_at,table_id,tournament_id,CASE WHEN tournament_id IS NULL THEN 990001 ELSE 990002 END,game_variant,
 jsonb_build_array(jsonb_build_object('userId',user_id)), '[]'::jsonb,returned,big_blind
FROM public.ca_hand_facts WHERE hand_id::text LIKE '99000000%';
INSERT INTO public.ca_hand_player_stat(user_id,hand_id,created_at,is_cash,tournament_id,game_variant,big_blind,seat_position,my_blind,won_amt,is_winner,invested_actions,vpip,pfr,profit,asset,n_players)
SELECT user_id,hand_id,played_at,tournament_id IS NULL,tournament_id,game_variant,big_blind,position,0,returned,returned>0,invested,vpip,pfr,net,'chips',players_dealt
FROM public.ca_hand_facts WHERE hand_id::text LIKE '99000000%';
CREATE TEMP TABLE separated_expected AS
SELECT cash,count(*) hands,count(*) FILTER(WHERE vpip) vpip_hands,sum(net) net FROM (
 SELECT coalesce(s.is_cash,f.tournament_id IS NULL) cash,coalesce(f.vpip,s.vpip) vpip,coalesce(f.net,s.profit) net
 FROM (SELECT * FROM public.ca_hand_facts WHERE user_id='20000000-0000-0000-0000-000000000001') f
 FULL JOIN (SELECT * FROM public.ca_hand_player_stat WHERE user_id='20000000-0000-0000-0000-000000000001' AND asset='chips') s USING(hand_id)
) independent_expected GROUP BY cash;
GRANT SELECT ON separated_expected TO authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
-- Reproduce the old blend before installing the candidate.
DO $$ DECLARE old jsonb; BEGIN
 old:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',NULL,'UTC','chips');
 IF (old#>>'{overall,cash_hands}')::int=0 OR (old#>>'{overall,tourney_hands}')::int=0 THEN
  RAISE EXCEPTION 'Fixture did not reproduce mixed-mode overview';
 END IF;
END $$;
