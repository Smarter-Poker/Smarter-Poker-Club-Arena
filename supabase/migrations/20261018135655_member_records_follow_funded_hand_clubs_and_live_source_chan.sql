-- 20261018135655_member_records_follow_funded_hand_clubs_and_live_source_chan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: to_regclass('public.member_record_daily_facts') IS NOT NULL
-- @live-proof: EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='member_record_facts_insert' AND tgenabled='O')
-- @live-proof: EXISTS(SELECT 1 FROM pg_policy WHERE polname='authorized viewers receive member record changes')
-- Shark member b52f183b has 12 facts under Midway's table club, but the
-- immutable buy-in and rake attributions name Shark. Never guess a club from
-- current membership or the most recently joined unrelated seat.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='45s';

CREATE TABLE public.member_record_daily_facts (LIKE public.club_member_daily_facts INCLUDING DEFAULTS);
ALTER TABLE public.member_record_daily_facts ADD COLUMN accounting_cutoff timestamptz;
ALTER TABLE public.member_record_daily_facts ADD CONSTRAINT member_record_daily_facts_identity
 UNIQUE NULLS NOT DISTINCT(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff);
ALTER TABLE public.member_record_daily_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_record_daily_facts FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.member_record_daily_facts_state(singleton boolean PRIMARY KEY CHECK(singleton),initialized boolean NOT NULL);
INSERT INTO public.member_record_daily_facts_state VALUES(true,false);
ALTER TABLE public.member_record_daily_facts_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_record_daily_facts_state FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_member_record_fact_club(f public.ca_hand_facts) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(
   (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
    WHERE f.tournament_id IS NULL AND x.operation_kind='buyin' AND x.table_id=f.table_id
      AND x.account_entity_id=f.user_id AND x.seat_joined_at<=f.played_at
    ORDER BY x.seat_joined_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1),
   (SELECT tp.club_id FROM public.tournament_players tp WHERE tp.tournament_id=f.tournament_id AND tp.user_id=f.user_id),
   (SELECT ra.club_id FROM public.rake_attributions ra WHERE ra.hand_id=f.hand_id AND ra.player_id=f.user_id),
   f.club_id);
$$;
REVOKE ALL ON FUNCTION public.fn_member_record_fact_club(public.ca_hand_facts) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_member_record_daily_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO public.member_record_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
 SELECT club_id,user_id,played_on,game_variant,is_mtt,public.fn_ca_launch_accounting_cutoff('club',club_id),sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net) FROM (SELECT public.fn_member_record_fact_club(f) club_id,user_id,(played_at AT TIME ZONE 'UTC')::date played_on,lower(game_variant) game_variant,tournament_id IS NOT NULL is_mtt,played_at,(1)*(1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(1) AS cb_opps,(coalesce(rake_paid,0))*(1) AS fees,(coalesce(net,0))*(1) AS net FROM new_facts f) changes
 WHERE club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(club_id,played_at)
 GROUP BY club_id,user_id,played_on,game_variant,is_mtt
 HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
 ORDER BY club_id,user_id,played_on,game_variant,is_mtt
 ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff) DO UPDATE SET hands=totals.hands+EXCLUDED.hands,wins=totals.wins+EXCLUDED.wins,vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,tb_hands=totals.tb_hands+EXCLUDED.tb_hands,faced_tb=totals.faced_tb+EXCLUDED.faced_tb,folded_tb=totals.folded_tb+EXCLUDED.folded_tb,cb_hands=totals.cb_hands+EXCLUDED.cb_hands,cb_opps=totals.cb_opps+EXCLUDED.cb_opps,fees=totals.fees+EXCLUDED.fees,net=totals.net+EXCLUDED.net;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_member_record_daily_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_daily_insert AFTER INSERT ON public.ca_hand_facts
REFERENCING NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_record_daily_insert();
CREATE FUNCTION public.fn_member_record_daily_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Card-retention updates leave every report metric unchanged. Do not resolve
 -- funding receipts or touch aggregate rows for that high-volume path.
 IF NOT EXISTS(
   (SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM new_facts EXCEPT SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM old_facts)
   UNION ALL
   (SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM old_facts EXCEPT SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM new_facts)
 ) THEN RETURN NULL; END IF;
 INSERT INTO public.member_record_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
 SELECT club_id,user_id,played_on,game_variant,is_mtt,public.fn_ca_launch_accounting_cutoff('club',club_id),sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net) FROM (SELECT public.fn_member_record_fact_club(f) club_id,user_id,(played_at AT TIME ZONE 'UTC')::date played_on,lower(game_variant) game_variant,tournament_id IS NOT NULL is_mtt,played_at,(1)*(1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(1) AS cb_opps,(coalesce(rake_paid,0))*(1) AS fees,(coalesce(net,0))*(1) AS net FROM new_facts f UNION ALL SELECT public.fn_member_record_fact_club(f) club_id,user_id,(played_at AT TIME ZONE 'UTC')::date played_on,lower(game_variant) game_variant,tournament_id IS NOT NULL is_mtt,played_at,(1)*(-1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(-1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(-1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(-1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(-1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(-1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(-1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(-1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(-1) AS cb_opps,(coalesce(rake_paid,0))*(-1) AS fees,(coalesce(net,0))*(-1) AS net FROM old_facts f) changes
 WHERE club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(club_id,played_at)
 GROUP BY club_id,user_id,played_on,game_variant,is_mtt
 HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
 ORDER BY club_id,user_id,played_on,game_variant,is_mtt
 ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff) DO UPDATE SET hands=totals.hands+EXCLUDED.hands,wins=totals.wins+EXCLUDED.wins,vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,tb_hands=totals.tb_hands+EXCLUDED.tb_hands,faced_tb=totals.faced_tb+EXCLUDED.faced_tb,folded_tb=totals.folded_tb+EXCLUDED.folded_tb,cb_hands=totals.cb_hands+EXCLUDED.cb_hands,cb_opps=totals.cb_opps+EXCLUDED.cb_opps,fees=totals.fees+EXCLUDED.fees,net=totals.net+EXCLUDED.net;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_member_record_daily_update() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_daily_update AFTER UPDATE ON public.ca_hand_facts
REFERENCING NEW TABLE AS new_facts OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_record_daily_update();
CREATE FUNCTION public.fn_member_record_daily_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO public.member_record_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
 SELECT club_id,user_id,played_on,game_variant,is_mtt,public.fn_ca_launch_accounting_cutoff('club',club_id),sum(hands)::bigint,sum(wins)::bigint,sum(vpip_hands)::bigint,sum(pfr_hands)::bigint,sum(tb_hands)::bigint,sum(faced_tb)::bigint,sum(folded_tb)::bigint,sum(cb_hands)::bigint,sum(cb_opps)::bigint,sum(fees),sum(net) FROM (SELECT public.fn_member_record_fact_club(f) club_id,user_id,(played_at AT TIME ZONE 'UTC')::date played_on,lower(game_variant) game_variant,tournament_id IS NOT NULL is_mtt,played_at,(1)*(-1) AS hands,(CASE WHEN net>0 THEN 1 ELSE 0 END)*(-1) AS wins,(CASE WHEN vpip THEN 1 ELSE 0 END)*(-1) AS vpip_hands,(CASE WHEN pfr THEN 1 ELSE 0 END)*(-1) AS pfr_hands,(CASE WHEN three_bet THEN 1 ELSE 0 END)*(-1) AS tb_hands,(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)*(-1) AS faced_tb,(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)*(-1) AS folded_tb,(CASE WHEN cbet_flop THEN 1 ELSE 0 END)*(-1) AS cb_hands,(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)*(-1) AS cb_opps,(coalesce(rake_paid,0))*(-1) AS fees,(coalesce(net,0))*(-1) AS net FROM old_facts f) changes
 WHERE club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(club_id,played_at)
 GROUP BY club_id,user_id,played_on,game_variant,is_mtt
 HAVING sum(hands)<>0 OR sum(wins)<>0 OR sum(vpip_hands)<>0 OR sum(pfr_hands)<>0 OR sum(tb_hands)<>0 OR sum(faced_tb)<>0 OR sum(folded_tb)<>0 OR sum(cb_hands)<>0 OR sum(cb_opps)<>0 OR sum(fees)<>0 OR sum(net)<>0
 ORDER BY club_id,user_id,played_on,game_variant,is_mtt
 ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff) DO UPDATE SET hands=totals.hands+EXCLUDED.hands,wins=totals.wins+EXCLUDED.wins,vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,tb_hands=totals.tb_hands+EXCLUDED.tb_hands,faced_tb=totals.faced_tb+EXCLUDED.faced_tb,folded_tb=totals.folded_tb+EXCLUDED.folded_tb,cb_hands=totals.cb_hands+EXCLUDED.cb_hands,cb_opps=totals.cb_opps+EXCLUDED.cb_opps,fees=totals.fees+EXCLUDED.fees,net=totals.net+EXCLUDED.net;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_member_record_daily_delete() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_daily_delete AFTER DELETE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_record_daily_delete();
-- Private invalidations carry no balances, hand details, notes or role terms.
CREATE FUNCTION public.ca_member_record_can_subscribe(topic text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF topic !~ '^member-record:[0-9a-f-]{36}:[0-9a-f-]{36}$' OR auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN public.ca_club_roster_access(split_part(topic,':',2)::uuid,split_part(topic,':',3)::uuid)
    IN ('staff','downline','service','identity');
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.ca_member_record_can_subscribe(text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ca_member_record_can_subscribe(text) TO authenticated;
CREATE POLICY "authorized viewers receive member record changes" ON realtime.messages
FOR SELECT TO authenticated USING(extension='broadcast' AND private IS TRUE AND topic=realtime.topic()
  AND public.ca_member_record_can_subscribe(topic));

CREATE FUNCTION public.fn_publish_member_record_user(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target record;
BEGIN
  FOR target IN
    WITH RECURSIVE owners AS (
      SELECT club_id,user_id,agent_id,ARRAY[user_id] path FROM public.club_members WHERE user_id=p_user
      UNION ALL
      SELECT m.club_id,m.user_id,m.agent_id,o.path||m.user_id
      FROM owners o JOIN public.club_members m ON m.club_id=o.club_id AND m.user_id=o.agent_id
      WHERE cardinality(o.path)<20 AND NOT m.user_id=ANY(o.path)
    ) SELECT DISTINCT club_id,user_id FROM owners
  LOOP
    BEGIN
      PERFORM realtime.send(jsonb_build_object('user_id',p_user),
        'record_changed','member-record:'||target.club_id::text||':'||target.user_id::text,true);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Member record signal failed: %',SQLERRM;
    END;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_user(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_publish_member_record_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; old_user uuid; new_user uuid; child uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    r:=to_jsonb(OLD); old_user:=coalesce(r->>'user_id',r->>'player_id',r->>'id')::uuid;
    PERFORM public.fn_publish_member_record_user(old_user);
    IF TG_TABLE_NAME='club_members' THEN
      BEGIN
        PERFORM realtime.send('{}'::jsonb,'record_changed','member-record:'||(r->>'club_id')||':'||old_user::text,true);
        PERFORM public.fn_publish_member_record_user((r->>'agent_id')::uuid);
      EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Member removal signal failed: %',SQLERRM; END;
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    r:=to_jsonb(NEW); new_user:=coalesce(r->>'user_id',r->>'player_id',r->>'id')::uuid;
    IF new_user IS DISTINCT FROM old_user THEN PERFORM public.fn_publish_member_record_user(new_user); END IF;
  END IF;
  IF TG_TABLE_NAME='profiles' THEN
  IF TG_OP='UPDATE' THEN
  IF ROW(OLD.alias,OLD.username,OLD.display_name,OLD.status,OLD.first_name,OLD.last_name,OLD.full_name) IS DISTINCT FROM
    ROW(NEW.alias,NEW.username,NEW.display_name,NEW.status,NEW.first_name,NEW.last_name,NEW.full_name) THEN
    FOR child IN SELECT DISTINCT user_id FROM public.club_members WHERE agent_id=new_user LOOP
      PERFORM public.fn_publish_member_record_user(child);
    END LOOP;
  END IF;
  END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_row() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_membership AFTER INSERT OR DELETE OR UPDATE OF role,agent_id,status,nickname,notes,display_name
ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
('club_members','member_record_membership','Private record and upline invalidation including removals; no money writes.');
CREATE TRIGGER member_record_profile AFTER UPDATE OF alias,username,display_name,first_name,last_name,full_name,arena_avatar_url,avatar_url,last_login,last_seen,is_online,status
ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
CREATE TRIGGER member_record_seat AFTER INSERT OR DELETE OR UPDATE OF user_id,club_id,left_at,joined_at,table_id
ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
('table_seats','member_record_seat','Private identity-only record invalidation; no financial mutation; delivery failure cannot roll back the seat.');

CREATE FUNCTION public.fn_publish_member_record_facts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    FOR u IN SELECT DISTINCT user_id FROM new_facts LOOP PERFORM public.fn_publish_member_record_user(u); END LOOP;
  ELSIF TG_OP='DELETE' THEN
    FOR u IN SELECT DISTINCT user_id FROM old_facts LOOP PERFORM public.fn_publish_member_record_user(u); END LOOP;
  ELSE
    FOR u IN SELECT DISTINCT user_id FROM (
      (SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM new_facts EXCEPT SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM old_facts)
      UNION ALL
      (SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM old_facts EXCEPT SELECT hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,cbet_flop,had_cbet_flop_opp FROM new_facts)
    ) changed LOOP PERFORM public.fn_publish_member_record_user(u); END LOOP;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_facts() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_facts_insert AFTER INSERT ON public.ca_hand_facts REFERENCING NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_publish_member_record_facts();
CREATE TRIGGER member_record_facts_update AFTER UPDATE ON public.ca_hand_facts REFERENCING NEW TABLE AS new_facts OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_publish_member_record_facts();
CREATE TRIGGER member_record_facts_delete AFTER DELETE ON public.ca_hand_facts REFERENCING OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_publish_member_record_facts();
CREATE TRIGGER member_record_cash_fee AFTER INSERT OR UPDATE ON public.ca_club_rake_daily_user
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
CREATE TRIGGER member_record_tournament_fee AFTER INSERT OR UPDATE ON public.ca_club_member_tournament_fee_daily
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();

CREATE FUNCTION public.fn_publish_member_record_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT DISTINCT x FROM unnest(ARRAY[NEW.from_user_id,NEW.to_user_id]) x WHERE x IS NOT NULL LOOP
    PERFORM public.fn_publish_member_record_user(u);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_transaction() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_transaction AFTER INSERT ON public.chip_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_transaction();
COMMIT;
