-- A cold live Seven Days ledger timed out after the lifetime repair.
-- Keep exact UTC-day/variant/classification totals in the original facts
-- transaction. No cache timer, reconciliation or separate writer supplies them.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE TABLE public.club_member_daily_facts (
  club_id uuid NOT NULL, user_id uuid NOT NULL,
  played_on date, game_variant text, is_mtt boolean NOT NULL,
  hands bigint NOT NULL DEFAULT 0,
  wins bigint NOT NULL DEFAULT 0,
  vpip_hands bigint NOT NULL DEFAULT 0,
  pfr_hands bigint NOT NULL DEFAULT 0,
  tb_hands bigint NOT NULL DEFAULT 0,
  faced_tb bigint NOT NULL DEFAULT 0,
  folded_tb bigint NOT NULL DEFAULT 0,
  cb_hands bigint NOT NULL DEFAULT 0,
  cb_opps bigint NOT NULL DEFAULT 0,
  fees numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  CONSTRAINT club_member_daily_facts_identity UNIQUE NULLS NOT DISTINCT
    (club_id,user_id,played_on,game_variant,is_mtt)
);
ALTER TABLE public.club_member_daily_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_member_daily_facts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_member_daily_facts TO service_role;
CREATE TABLE public.club_member_daily_facts_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  initialized boolean NOT NULL DEFAULT false
);
INSERT INTO public.club_member_daily_facts_state VALUES(true,false);
ALTER TABLE public.club_member_daily_facts_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_member_daily_facts_state FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_member_daily_facts_state TO service_role;
CREATE FUNCTION public.fn_club_member_daily_facts_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
  SELECT club_id,user_id,played_on,game_variant,is_mtt,sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net)
  FROM (SELECT club_id,user_id,(played_at AT TIME ZONE 'UTC')::date AS played_on,lower(game_variant) AS game_variant,(tournament_id IS NOT NULL) AS is_mtt,(1)*(1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(1) AS cb_opps,(rake_paid)*(1) AS fees,(coalesce(net,0))*(1) AS net FROM new_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id,played_on,game_variant,is_mtt
  HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
  ORDER BY club_id,user_id,played_on,game_variant,is_mtt
  ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,
    wins=totals.wins+EXCLUDED.wins,
    vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,
    pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,
    tb_hands=totals.tb_hands+EXCLUDED.tb_hands,
    faced_tb=totals.faced_tb+EXCLUDED.faced_tb,
    folded_tb=totals.folded_tb+EXCLUDED.folded_tb,
    cb_hands=totals.cb_hands+EXCLUDED.cb_hands,
    cb_opps=totals.cb_opps+EXCLUDED.cb_opps,
    fees=totals.fees+EXCLUDED.fees,
    net=totals.net+EXCLUDED.net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_daily_facts_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_daily_facts_insert
AFTER INSERT ON public.ca_hand_facts
REFERENCING NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_daily_facts_insert();
CREATE FUNCTION public.fn_club_member_daily_facts_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
  SELECT club_id,user_id,played_on,game_variant,is_mtt,sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net)
  FROM (SELECT club_id,user_id,(played_at AT TIME ZONE 'UTC')::date AS played_on,lower(game_variant) AS game_variant,(tournament_id IS NOT NULL) AS is_mtt,(1)*(1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(1) AS cb_opps,(rake_paid)*(1) AS fees,(coalesce(net,0))*(1) AS net FROM new_facts UNION ALL SELECT club_id,user_id,(played_at AT TIME ZONE 'UTC')::date AS played_on,lower(game_variant) AS game_variant,(tournament_id IS NOT NULL) AS is_mtt,(1)*(-1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(-1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(-1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(-1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(-1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(-1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(-1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(-1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(-1) AS cb_opps,(rake_paid)*(-1) AS fees,(coalesce(net,0))*(-1) AS net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id,played_on,game_variant,is_mtt
  HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
  ORDER BY club_id,user_id,played_on,game_variant,is_mtt
  ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,
    wins=totals.wins+EXCLUDED.wins,
    vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,
    pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,
    tb_hands=totals.tb_hands+EXCLUDED.tb_hands,
    faced_tb=totals.faced_tb+EXCLUDED.faced_tb,
    folded_tb=totals.folded_tb+EXCLUDED.folded_tb,
    cb_hands=totals.cb_hands+EXCLUDED.cb_hands,
    cb_opps=totals.cb_opps+EXCLUDED.cb_opps,
    fees=totals.fees+EXCLUDED.fees,
    net=totals.net+EXCLUDED.net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_daily_facts_update() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_daily_facts_update
AFTER UPDATE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_daily_facts_update();
CREATE FUNCTION public.fn_club_member_daily_facts_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
  SELECT club_id,user_id,played_on,game_variant,is_mtt,sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net)
  FROM (SELECT club_id,user_id,(played_at AT TIME ZONE 'UTC')::date AS played_on,lower(game_variant) AS game_variant,(tournament_id IS NOT NULL) AS is_mtt,(1)*(-1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(-1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(-1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(-1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(-1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(-1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(-1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(-1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(-1) AS cb_opps,(rake_paid)*(-1) AS fees,(coalesce(net,0))*(-1) AS net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id,played_on,game_variant,is_mtt
  HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
  ORDER BY club_id,user_id,played_on,game_variant,is_mtt
  ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,
    wins=totals.wins+EXCLUDED.wins,
    vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,
    pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,
    tb_hands=totals.tb_hands+EXCLUDED.tb_hands,
    faced_tb=totals.faced_tb+EXCLUDED.faced_tb,
    folded_tb=totals.folded_tb+EXCLUDED.folded_tb,
    cb_hands=totals.cb_hands+EXCLUDED.cb_hands,
    cb_opps=totals.cb_opps+EXCLUDED.cb_opps,
    fees=totals.fees+EXCLUDED.fees,
    net=totals.net+EXCLUDED.net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_daily_facts_delete() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_daily_facts_delete
AFTER DELETE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_daily_facts_delete();
COMMIT;
